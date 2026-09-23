// מדדי ביצוע לשני הדשבורדים (ר' בקשת דניאל 23.9.2026):
//   - "המחסן היום" (computeWarehouseToday) — מנהל מחסן + מנהל מערכת, חי.
//   - "תמונת הנהלה" (computeManagement) — מנהל מערכת בלבד, מגמות לתקופה.
//
// החישובים נעשים ב-JS ולא ב-SQL: צריך "יום" לפי שעון ישראל (ה-DB שומר UTC),
// ימי עבודה ושעת סגירה (cutoff) — קשה ושביר לבטא את זה ב-SQLite. הנפחים
// קטנים (עשרות הזמנות ביום), אז טוענים אירועים של התקופה ומחשבים בזיכרון.
//
// מקור האמת לזמנים הוא workflow_events (כל מעבר סטטוס). "יצאה מהמחסן" =
// מסירה ל-UPS או איסוף עצמי (closed מתוך waiting_pickup) — לא כל 'closed',
// כי סנכרון סיגמא סוגר הזמנות שמעולם לא יצאו פיזית (ר' sigmaIngest.js).
const { db } = require('./db');

const TZ = 'Asia/Jerusalem';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// סף "תקועה" לכל שלב, בדקות (אושר ע"י דניאל 23.9.2026)
const STUCK_MINUTES = {
  picking: 120,
  ready_for_check: 60,
  ready_to_pack: 60,
  waiting_pickup: 24 * 60,
};

const PERFECT_ORDER_HOURS = 24;

// ---------- זמן: UTC מה-DB <-> יום/שעה בישראל ----------

// ה-DB שומר גם 'YYYY-MM-DD HH:MM:SS' (datetime('now'), UTC) וגם ISO עם Z
// (ר' releaseHold ב-workflow.js). שניהם UTC.
function parseDbTime(s) {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function ilParts(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    dow: WEEKDAYS[p.weekday],
  };
}

function ilDayKey(date) {
  return ilParts(date).dayKey;
}

// הרגע (UTC) שבו מתחיל יום נתון בישראל, בתוספת דקות — עמיד לשעון קיץ/חורף
function ilDayStart(dayKey, plusMinutes = 0) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, 0, plusMinutes);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = ilParts(new Date(guess));
    const [py, pm, pd] = p.dayKey.split('-').map(Number);
    const shownAsUtc = Date.UTC(py, pm - 1, pd, 0, p.minutes);
    guess += target - shownAsUtc;
  }
  return new Date(guess);
}

function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dowOf(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function sqlTime(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// ---------- הגדרות מדידה (כלי ניהול) ----------

const METRICS_DEFAULTS = {
  cutoffTime: '12:00',
  workdays: [0, 1, 2, 3, 4], // א'-ה'
  monthlyLaborCost: null,
};

function getMetricsSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN ('metrics_cutoff_time','metrics_workdays','metrics_monthly_labor_cost')`).all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const workdays = map.metrics_workdays != null
    ? map.metrics_workdays.split(',').filter((x) => x !== '').map(Number)
    : METRICS_DEFAULTS.workdays;
  const cost = map.metrics_monthly_labor_cost != null && map.metrics_monthly_labor_cost !== ''
    ? Number(map.metrics_monthly_labor_cost) : null;
  return {
    cutoffTime: map.metrics_cutoff_time || METRICS_DEFAULTS.cutoffTime,
    workdays,
    monthlyLaborCost: Number.isFinite(cost) ? cost : null,
  };
}

function saveMetricsSettings({ cutoffTime, workdays, monthlyLaborCost }) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoffTime || '')) throw Object.assign(new Error('שעת סגירה לא תקינה (HH:MM)'), { status: 400 });
  if (!Array.isArray(workdays) || workdays.length === 0 || workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw Object.assign(new Error('יש לבחור לפחות יום עבודה אחד'), { status: 400 });
  }
  let cost = '';
  if (monthlyLaborCost !== null && monthlyLaborCost !== undefined && monthlyLaborCost !== '') {
    const n = Number(monthlyLaborCost);
    if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('עלות עבודה לא תקינה'), { status: 400 });
    cost = String(n);
  }
  const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  db.transaction(() => {
    upsert.run('metrics_cutoff_time', cutoffTime);
    upsert.run('metrics_workdays', [...new Set(workdays)].sort().join(','));
    upsert.run('metrics_monthly_labor_cost', cost);
  })();
  return getMetricsSettings();
}

// יום היעד ליציאה: הזמנה שנכנסה ביום עבודה לפני שעת הסגירה — צריכה לצאת
// באותו יום; אחרת — ביום העבודה הבא. ר' החלטת דניאל 23.9.2026: הזמנה
// שנכנסת עד 12:00 עוד יכולה לצאת באותו יום (ניתן לשינוי בכלי ניהול).
function dueDayFor(enteredAt, settings) {
  const [ch, cm] = settings.cutoffTime.split(':').map(Number);
  const p = ilParts(enteredAt);
  const workdays = new Set(settings.workdays);
  let day = p.dayKey;
  if (!(workdays.has(p.dow) && p.minutes < ch * 60 + cm)) day = addDays(day, 1);
  for (let i = 0; i < 7 && !workdays.has(dowOf(day)); i++) day = addDays(day, 1);
  return day;
}

// ---------- ציר הזמן של כל הזמנה ----------

// בונה לכל הזמנה את רגעי המפתח שלה מתוך workflow_events. לוקחים את ההופעה
// הראשונה של כל שלב (אחרי השלב הקודם) — מספיק למדדים, גם אם הזמנה חזרה אחורה.
function loadTimelines(sinceDate) {
  const since = sqlTime(sinceDate);
  const states = db.prepare(`
    SELECT ws.order_key, ws.status, ws.queue_entered_at, ws.check_started_at, ws.check_started_by,
           ws.agent_id, oc.order_num, oc.customer_name,
           COALESCE(oc.sigma_agent_name, au.display_name) AS agent_name
    FROM workflow_state ws
    JOIN orders_cache oc ON oc.order_key = ws.order_key
    LEFT JOIN users au ON au.user_id = ws.agent_id
    WHERE ws.order_key IN (SELECT DISTINCT order_key FROM workflow_events WHERE created_at >= ?)
       OR ws.queue_entered_at >= ?
       OR ws.status NOT IN ('closed','cancelled')
  `).all(since, since);
  if (states.length === 0) return new Map();

  const events = db.prepare(`
    SELECT order_key, user_id, from_status, to_status, note, created_at
    FROM workflow_events
    WHERE order_key IN (SELECT value FROM json_each(?))
    ORDER BY created_at ASC, rowid ASC
  `).all(JSON.stringify(states.map((s) => s.order_key)));
  const byOrder = new Map();
  for (const e of events) {
    if (!byOrder.has(e.order_key)) byOrder.set(e.order_key, []);
    byOrder.get(e.order_key).push(e);
  }

  const out = new Map();
  for (const s of states) {
    const evs = byOrder.get(s.order_key) || [];
    const t = {
      orderKey: s.order_key, orderNum: s.order_num, customerName: s.customer_name,
      status: s.status, agentName: s.agent_name || 'ללא סוכן',
      enteredAt: parseDbTime(s.queue_entered_at),
      checkStartAt: parseDbTime(s.check_started_at), checkStartBy: s.check_started_by,
      pickStartAt: null, pickUser: null, pickEndAt: null,
      checkEndAt: null, checkUser: null, checkSkipped: false,
      packEndAt: null, leftAt: null,
      statusSince: null,
    };
    for (const e of evs) {
      const at = parseDbTime(e.created_at);
      if (e.to_status === s.status) t.statusSince = at;
      if (e.to_status === 'picking' && !t.pickStartAt) { t.pickStartAt = at; t.pickUser = e.user_id; }
      else if (e.to_status === 'ready_for_check' && t.pickStartAt && !t.pickEndAt) t.pickEndAt = at;
      else if (e.to_status === 'ready_to_pack' && !t.checkEndAt) {
        t.checkEndAt = at; t.checkUser = e.user_id; t.checkSkipped = (e.note || '').startsWith('דילוג');
      } else if (e.to_status === 'waiting_pickup' && !t.packEndAt) t.packEndAt = at;
      else if (!t.leftAt && (e.to_status === 'delivered_to_ups' || (e.to_status === 'closed' && e.from_status === 'waiting_pickup'))) t.leftAt = at;
    }
    // check_started_at שייך לסבב הבדיקה הנוכחי בלבד — לא רלוונטי אם קדם לסיום הליקוט
    if (t.checkStartAt && t.pickEndAt && t.checkStartAt < t.pickEndAt) t.checkStartAt = null;
    out.set(s.order_key, t);
  }
  return out;
}

// שורות הפריטים של קבוצת הזמנות, לחישובי חוסרים/דיוק/סריקה
function loadItems(orderKeys) {
  if (orderKeys.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT oic.order_key, oic.line_no, oic.item_code, oic.item_name, oic.quantity, oic.qty_picked, oic.price,
           oic.pick_status, oic.picked_via, oic.corrected_by_checker, oic.replaced_to, oic.replaced_confirmed,
           isup.supplier_name
    FROM order_items_cache oic
    LEFT JOIN item_suppliers isup ON isup.item_code = oic.item_code
    WHERE oic.order_key IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(orderKeys));
  const mismatches = db.prepare(`
    SELECT DISTINCT order_key, line_no FROM scan_events
    WHERE result_code IN ('VERIFY_MISMATCH') AND order_key IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(orderKeys));
  const mismatchSet = new Set(mismatches.map((m) => `${m.order_key}#${m.line_no}`));
  const map = new Map();
  for (const r of rows) {
    r.verifyMismatch = mismatchSet.has(`${r.order_key}#${r.line_no}`);
    if (!map.has(r.order_key)) map.set(r.order_key, []);
    map.get(r.order_key).push(r);
  }
  return map;
}

// אותו כלל כמו computeShortageValue ב-workflow.js: חוסר/חלקי נחשב, אלא אם
// יש תחליף שהבודק אימת (אותו פריט, אותו מחיר)
function lineShortfall(it) {
  if (!['missing', 'partial'].includes(it.pick_status)) return 0;
  if (it.replaced_confirmed === 1 && it.replaced_to && it.replaced_to.trim() !== '') return 0;
  return Math.max(0, (it.quantity || 0) - (it.qty_picked || 0));
}

function isPickError(it) {
  return it.corrected_by_checker === 1 || it.verifyMismatch;
}

function minutesBetween(a, b) {
  if (!a || !b) return null;
  const m = (b - a) / 60000;
  return m >= 0 ? m : null;
}

function avg(nums) {
  const v = nums.filter((n) => n != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function round(n, digits = 0) {
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function pct(part, total) {
  return total > 0 ? round((part / total) * 100, 1) : null;
}

function inRange(date, from, to) {
  return date != null && date >= from && date < to;
}

function userNames() {
  return Object.fromEntries(db.prepare('SELECT user_id, display_name FROM users').all().map((u) => [u.user_id, u.display_name]));
}

// זמן ממוצע לכל שלב, מתוך הזמנות שהשלב שלהן הסתיים בטווח
function stageTimes(timelines, from, to) {
  const seg = (list, pick) => {
    const vals = list.map(pick).filter((x) => x != null);
    return { avgMinutes: round(avg(vals)), sample: vals.length };
  };
  const all = [...timelines.values()];
  return {
    waitPick: seg(all.filter((t) => inRange(t.pickStartAt, from, to)), (t) => minutesBetween(t.enteredAt, t.pickStartAt)),
    pick: seg(all.filter((t) => inRange(t.pickEndAt, from, to)), (t) => minutesBetween(t.pickStartAt, t.pickEndAt)),
    waitCheck: seg(all.filter((t) => inRange(t.checkEndAt, from, to) && t.checkStartAt), (t) => minutesBetween(t.pickEndAt, t.checkStartAt)),
    // דילוג על בדיקה = אין בדיקה בפועל, לא "בדיקה של 0 דקות"
    check: seg(all.filter((t) => inRange(t.checkEndAt, from, to) && t.checkStartAt && !t.checkSkipped), (t) => minutesBetween(t.checkStartAt, t.checkEndAt)),
    pack: seg(all.filter((t) => inRange(t.packEndAt, from, to)), (t) => minutesBetween(t.checkEndAt, t.packEndAt)),
    waitPickup: seg(all.filter((t) => inRange(t.leftAt, from, to)), (t) => minutesBetween(t.packEndAt, t.leftAt)),
  };
}

// דיוק ליקוט + אחוז סריקה, מתוך הזמנות שעברו בדיקה בטווח (לא דילוג — בדילוג
// אף אחד לא בדק, אז "אין תיקונים" לא אומר כלום על דיוק)
function qualityFor(timelines, itemsByOrder, from, to) {
  let checkedLines = 0, errorLines = 0, scanLines = 0, manualLines = 0;
  for (const t of timelines.values()) {
    if (!inRange(t.checkEndAt, from, to)) continue;
    for (const it of itemsByOrder.get(t.orderKey) || []) {
      if (it.picked_via === 'scan') scanLines++;
      else if (it.picked_via === 'manual') manualLines++;
      if (t.checkSkipped || it.pick_status == null) continue;
      checkedLines++;
      if (isPickError(it)) errorLines++;
    }
  }
  return {
    pickAccuracy: checkedLines > 0 ? round(100 - (errorLines / checkedLines) * 100, 1) : null,
    checkedLines, errorLines,
    scanShare: pct(scanLines, scanLines + manualLines),
    scanLines, manualLines,
  };
}

// ביצועים לכל עובד: ליקוט (הזמנות שהוא סיים ללקט בטווח) ובדיקה (הזמנות שהוא אישר)
function workersFor(timelines, itemsByOrder, from, to) {
  const names = userNames();
  const w = new Map();
  const get = (id) => {
    if (!w.has(id)) w.set(id, { userId: id, name: names[id] || 'לא ידוע', pickedOrders: 0, pickedLines: 0, pickMinutes: 0, pickErrors: 0, pickCheckedLines: 0, checkedOrders: 0, checkMinutes: [] });
    return w.get(id);
  };
  for (const t of timelines.values()) {
    if (t.pickUser && inRange(t.pickEndAt, from, to)) {
      const r = get(t.pickUser);
      const items = itemsByOrder.get(t.orderKey) || [];
      r.pickedOrders++;
      r.pickedLines += items.length;
      r.pickMinutes += minutesBetween(t.pickStartAt, t.pickEndAt) || 0;
    }
    if (t.pickUser && inRange(t.checkEndAt, from, to) && !t.checkSkipped) {
      const r = get(t.pickUser);
      for (const it of itemsByOrder.get(t.orderKey) || []) {
        if (it.pick_status == null) continue;
        r.pickCheckedLines++;
        if (isPickError(it)) r.pickErrors++;
      }
    }
    if (t.checkUser && inRange(t.checkEndAt, from, to) && !t.checkSkipped) {
      const r = get(t.checkUser);
      r.checkedOrders++;
      r.checkMinutes.push(minutesBetween(t.checkStartAt, t.checkEndAt));
    }
  }
  return [...w.values()].map((r) => ({
    userId: r.userId,
    name: r.name,
    pickedOrders: r.pickedOrders,
    pickedLines: r.pickedLines,
    linesPerHour: r.pickMinutes > 0 ? round(r.pickedLines / (r.pickMinutes / 60)) : null,
    avgPickMinutes: r.pickedOrders > 0 ? round(r.pickMinutes / r.pickedOrders) : null,
    pickAccuracy: r.pickCheckedLines > 0 ? round(100 - (r.pickErrors / r.pickCheckedLines) * 100, 1) : null,
    checkedOrders: r.checkedOrders,
    avgCheckMinutes: round(avg(r.checkMinutes)),
  })).sort((a, b) => (b.pickedOrders + b.checkedOrders) - (a.pickedOrders + a.checkedOrders));
}

// ---------- "המחסן היום" ----------

function computeWarehouseToday({ includeWorkerNames, now = new Date() }) {
  const settings = getMetricsSettings();
  const todayKey = ilDayKey(now);
  const dayStart = ilDayStart(todayKey);
  const dayEnd = ilDayStart(addDays(todayKey, 1));

  // אחורה 21 יום: מספיק כדי לתפוס הזמנות ישנות שעדיין פתוחות + יעד יציאה של היום
  const timelines = loadTimelines(new Date(dayStart.getTime() - 21 * DAY));
  const itemsByOrder = loadItems([...timelines.values()].filter((t) => inRange(t.checkEndAt, dayStart, dayEnd) || inRange(t.pickEndAt, dayStart, dayEnd)).map((t) => t.orderKey));
  const all = [...timelines.values()];

  const enteredToday = all.filter((t) => inRange(t.enteredAt, dayStart, dayEnd)).length;
  const leftToday = all.filter((t) => inRange(t.leftAt, dayStart, dayEnd)).length;

  // יעד היום: הזמנות שיום היעד שלהן הוא היום (לא מבוטלות, ולא כאלה שנסגרו
  // מסנכרון בלי לצאת פיזית)
  const dueToday = all.filter((t) => t.enteredAt && dueDayFor(t.enteredAt, settings) === todayKey
    && t.status !== 'cancelled' && !(t.status === 'closed' && !t.leftAt));
  const dueLeft = dueToday.filter((t) => t.leftAt && t.leftAt < dayEnd).length;
  const dueRemaining = dueToday.filter((t) => !t.leftAt).map((t) => ({ order_key: t.orderKey, order_num: t.orderNum, customer_name: t.customerName, status: t.status }));
  const [ch, cm] = settings.cutoffTime.split(':').map(Number);
  const nextWorkday = dueDayFor(ilDayStart(todayKey, 24 * 60 - 1), settings);

  // עומס לפי תחנה + תקועות (לפי זמן מאז הכניסה לסטטוס הנוכחי)
  const stations = {
    waiting_pick: 0, picking: 0, waiting_check: 0, checking: 0, ready_to_pack: 0, waiting_pickup: 0, waiting_answer: 0, on_hold: 0,
  };
  const stuck = [];
  for (const t of all) {
    let key = t.status;
    if (t.status === 'ready_for_check') key = t.checkStartAt ? 'checking' : 'waiting_check';
    if (!(key in stations)) continue;
    stations[key]++;
    const limit = STUCK_MINUTES[t.status];
    const since = t.statusSince || t.enteredAt;
    if (limit && since) {
      const mins = Math.floor((now - since) / 60000);
      if (mins >= limit) stuck.push({ order_key: t.orderKey, order_num: t.orderNum, customer_name: t.customerName, status: t.status, station: key, minutes_in_status: mins });
    }
  }
  stuck.sort((a, b) => b.minutes_in_status - a.minutes_in_status);

  const quality = qualityFor(timelines, itemsByOrder, dayStart, dayEnd);
  const workers = workersFor(timelines, itemsByOrder, dayStart, dayEnd);
  const team = workers.reduce((acc, r) => ({
    pickedOrders: acc.pickedOrders + r.pickedOrders,
    pickedLines: acc.pickedLines + r.pickedLines,
    checkedOrders: acc.checkedOrders + r.checkedOrders,
  }), { pickedOrders: 0, pickedLines: 0, checkedOrders: 0 });
  const pickMinutesTotal = all.filter((t) => inRange(t.pickEndAt, dayStart, dayEnd)).reduce((s, t) => s + (minutesBetween(t.pickStartAt, t.pickEndAt) || 0), 0);
  team.linesPerHour = pickMinutesTotal > 0 ? round(team.pickedLines / (pickMinutesTotal / 60)) : null;

  const manualPending = db.prepare(`
    SELECT COUNT(DISTINCT order_key) c FROM order_items_cache
    WHERE picked_via = 'manual' AND pick_status != 'missing' AND manual_pick_approved_at IS NULL
      AND order_key IN (SELECT order_key FROM workflow_state WHERE status = 'ready_for_check')
  `).get().c;

  return {
    day: todayKey,
    generatedAt: now.toISOString(),
    settings: { cutoffTime: settings.cutoffTime },
    enteredToday,
    leftToday,
    dueToday: {
      total: dueToday.length,
      left: dueLeft,
      remaining: dueRemaining,
      cutoffPassed: ilParts(now).minutes >= ch * 60 + cm,
      nextWorkday,
    },
    quality,
    stations,
    stuck,
    stuckThresholds: STUCK_MINUTES,
    stageTimes: stageTimes(timelines, dayStart, dayEnd),
    team,
    workers: includeWorkerNames ? workers : null,
    needsAttention: {
      pendingUrgent: db.prepare(`SELECT COUNT(*) c FROM urgent_requests WHERE status = 'pending'`).get().c,
      manualPickApprovals: manualPending,
    },
  };
}

// ---------- "תמונת הנהלה" ----------

function periodMetrics(timelines, itemsByOrder, from, to, settings, now) {
  const all = [...timelines.values()];
  const left = all.filter((t) => inRange(t.leftAt, from, to));
  const checked = all.filter((t) => inRange(t.checkEndAt, from, to));

  // Fill rate + שווי חוסרים — לפי הזמנות שעברו בדיקה בתקופה (שם החוסר נקבע סופית)
  let orderedValue = 0, shortageValue = 0;
  const bySupplier = new Map();
  const byItem = new Map();
  for (const t of checked) {
    for (const it of itemsByOrder.get(t.orderKey) || []) {
      const lineValue = (it.quantity || 0) * (it.price || 0);
      const lost = lineShortfall(it) * (it.price || 0);
      orderedValue += lineValue;
      if (lost <= 0) continue;
      shortageValue += lost;
      const sup = it.supplier_name || 'ללא ספק';
      bySupplier.set(sup, (bySupplier.get(sup) || 0) + lost);
      const k = it.item_code || it.item_name || '?';
      const cur = byItem.get(k) || { item_code: it.item_code, item_name: it.item_name, supplier_name: it.supplier_name, value: 0, orders: 0 };
      cur.value += lost; cur.orders++;
      byItem.set(k, cur);
    }
  }

  // הזמנה מושלמת: יצאה מלאה (בלי חוסר), הבודק לא תיקן כלום, ותוך 24 שעות מהכניסה לתור
  let perfect = 0;
  const cycleHours = [];
  for (const t of left) {
    const items = itemsByOrder.get(t.orderKey) || [];
    const hours = t.enteredAt ? (t.leftAt - t.enteredAt) / HOUR : null;
    if (hours != null && hours >= 0) cycleHours.push(hours);
    const complete = items.every((it) => lineShortfall(it) === 0);
    const clean = items.every((it) => !isPickError(it));
    if (complete && clean && hours != null && hours <= PERFECT_ORDER_HOURS) perfect++;
  }

  // יציאה בזמן: יום היעד (לפי שעת סגירה + ימי עבודה) נופל בתקופה. הזמנה
  // שיום היעד שלה הוא היום ועוד לא יצאה — עוד לא נקבע, לא נספרת.
  const todayKey = ilDayKey(now);
  let dueCount = 0, onTime = 0;
  for (const t of all) {
    if (!t.enteredAt || t.status === 'cancelled' || (t.status === 'closed' && !t.leftAt)) continue;
    const due = dueDayFor(t.enteredAt, settings);
    const dueStart = ilDayStart(due);
    if (!inRange(dueStart, from, to)) continue;
    if (!t.leftAt && due >= todayKey) continue;
    dueCount++;
    if (t.leftAt && ilDayKey(t.leftAt) <= due) onTime++;
  }

  const days = (to - from) / DAY;
  const laborCost = settings.monthlyLaborCost != null ? settings.monthlyLaborCost * (days / 30.44) : null;

  return {
    ordersLeft: left.length,
    ordersChecked: checked.length,
    orderedValue: round(orderedValue, 2),
    shortageValue: round(shortageValue, 2),
    fillRate: orderedValue > 0 ? round(100 - (shortageValue / orderedValue) * 100, 1) : null,
    perfectOrderRate: pct(perfect, left.length),
    avgCycleHours: round(avg(cycleHours), 1),
    onTimeRate: pct(onTime, dueCount),
    onTimeSample: dueCount,
    costPerOrder: laborCost != null && left.length > 0 ? round(laborCost / left.length, 1) : null,
    quality: qualityFor(timelines, itemsByOrder, from, to),
    _bySupplier: bySupplier,
    _byItem: byItem,
  };
}

function computeManagement({ days = 30, now = new Date() } = {}) {
  days = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const settings = getMetricsSettings();
  const todayKey = ilDayKey(now);
  const to = ilDayStart(addDays(todayKey, 1));
  const from = ilDayStart(addDays(todayKey, -(days - 1)));
  const prevFrom = ilDayStart(addDays(todayKey, -(2 * days - 1)));

  const timelines = loadTimelines(new Date(prevFrom.getTime() - 14 * DAY));
  const relevant = [...timelines.values()].filter((t) => inRange(t.checkEndAt, prevFrom, to) || inRange(t.leftAt, prevFrom, to) || inRange(t.pickEndAt, prevFrom, to));
  const itemsByOrder = loadItems(relevant.map((t) => t.orderKey));

  const current = periodMetrics(timelines, itemsByOrder, from, to, settings, now);
  const previous = periodMetrics(timelines, itemsByOrder, prevFrom, from, settings, now);

  const shortagesBySupplier = [...current._bySupplier.entries()]
    .map(([supplier_name, value]) => ({ supplier_name, value: round(value, 2) }))
    .sort((a, b) => b.value - a.value).slice(0, 8);
  const topShortItems = [...current._byItem.values()]
    .map((r) => ({ ...r, value: round(r.value, 2) }))
    .sort((a, b) => b.value - a.value).slice(0, 8);
  delete current._bySupplier; delete current._byItem;
  delete previous._bySupplier; delete previous._byItem;

  // סדרה לגרף: יומית עד 30 יום, שבועית ל-90
  const bucketDays = days > 30 ? 7 : 1;
  const series = [];
  for (let start = 0; start < days; start += bucketDays) {
    const bFrom = ilDayStart(addDays(todayKey, -(days - 1) + start));
    const bTo = ilDayStart(addDays(todayKey, Math.min(-(days - 1) + start + bucketDays, 1)));
    const left = [...timelines.values()].filter((t) => inRange(t.leftAt, bFrom, bTo));
    const hours = left.map((t) => (t.enteredAt ? (t.leftAt - t.enteredAt) / HOUR : null)).filter((h) => h != null && h >= 0);
    series.push({ from: ilDayKey(bFrom), orders: left.length, avgCycleHours: round(avg(hours), 1) });
  }

  // לפי סוכן: הזמנות שיצאו בתקופה + מצב נוכחי
  const agents = new Map();
  const agentRow = (name) => {
    if (!agents.has(name)) agents.set(name, { agent_name: name, ordersLeft: 0, value: 0, ordered: 0, shortage: 0, waitingAnswer: 0, active: 0, urgentRequests: 0 });
    return agents.get(name);
  };
  for (const t of timelines.values()) {
    if (inRange(t.leftAt, from, to)) {
      const r = agentRow(t.agentName);
      r.ordersLeft++;
      for (const it of itemsByOrder.get(t.orderKey) || []) {
        const v = (it.quantity || 0) * (it.price || 0);
        r.ordered += v; r.value += v;
        r.shortage += lineShortfall(it) * (it.price || 0);
      }
    }
    if (t.status === 'waiting_answer') agentRow(t.agentName).waitingAnswer++;
    if (!['closed', 'cancelled', 'on_hold', 'waiting_answer'].includes(t.status)) agentRow(t.agentName).active++;
  }
  const urgentRows = db.prepare(`
    SELECT COALESCE(oc.sigma_agent_name, u.display_name, 'ללא סוכן') AS agent_name, COUNT(*) c
    FROM urgent_requests ur
    JOIN orders_cache oc ON oc.order_key = ur.order_key
    LEFT JOIN users u ON u.user_id = ur.agent_id
    WHERE ur.created_at >= ? AND ur.created_at < ?
    GROUP BY agent_name
  `).all(sqlTime(from), sqlTime(to));
  for (const u of urgentRows) agentRow(u.agent_name).urgentRequests = u.c;
  const byAgent = [...agents.values()]
    .map((r) => ({
      agent_name: r.agent_name, ordersLeft: r.ordersLeft, value: round(r.value, 2),
      fillRate: r.ordered > 0 ? round(100 - (r.shortage / r.ordered) * 100, 1) : null,
      waitingAnswer: r.waitingAnswer, active: r.active, urgentRequests: r.urgentRequests,
    }))
    .sort((a, b) => b.value - a.value || b.active - a.active);

  // UPS: ממסירה ל-UPS ועד שנמסר ללקוח, ואחוז משלוחים עם חריגה
  const ups = db.prepare(`
    SELECT s.track_no, s.status, s.exception_code, s.delivered_time, MIN(we.created_at) AS handed_at
    FROM shipments s
    JOIN order_shipments os ON os.track_no = s.track_no
    JOIN workflow_events we ON we.order_key = os.order_key AND we.to_status = 'delivered_to_ups'
    GROUP BY s.track_no
    HAVING handed_at >= ? AND handed_at < ?
  `).all(sqlTime(from), sqlTime(to));
  const transitDays = ups
    .map((s) => { const a = parseDbTime(s.handed_at), b = parseDbTime(s.delivered_time); return a && b && b >= a ? (b - a) / DAY : null; })
    .filter((x) => x != null);
  const withException = ups.filter((s) => s.exception_code || ['ship_exception', 'ship_returned'].includes(s.status)).length;

  const pipelineValue = db.prepare(`
    SELECT COALESCE(SUM(COALESCE((SELECT SUM(quantity * price) FROM order_items_cache oic WHERE oic.order_key = ws.order_key), oc.total_amount)), 0) AS total
    FROM workflow_state ws JOIN orders_cache oc ON oc.order_key = ws.order_key
    WHERE ws.status IN ('open','waiting_pick','picking','ready_for_check','ready_to_pack','waiting_pickup','delivered_to_ups')
  `).get().total;

  return {
    days,
    from: ilDayKey(from),
    to: todayKey,
    generatedAt: now.toISOString(),
    settings: { cutoffTime: settings.cutoffTime, laborCostConfigured: settings.monthlyLaborCost != null },
    current,
    previous,
    series,
    seriesBucketDays: bucketDays,
    shortagesBySupplier,
    topShortItems,
    byAgent,
    workers: workersFor(timelines, itemsByOrder, from, to),
    stageTimes: stageTimes(timelines, from, to),
    ups: {
      shipments: ups.length,
      avgTransitDays: round(avg(transitDays), 1),
      transitSample: transitDays.length,
      exceptionRate: pct(withException, ups.length),
    },
    pipelineValue: round(pipelineValue, 2),
  };
}

module.exports = {
  computeWarehouseToday, computeManagement, getMetricsSettings, saveMetricsSettings,
  // לבדיקות
  dueDayFor, ilDayStart, ilDayKey, parseDbTime,
};
