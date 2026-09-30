// קישור משלוחי UPS להזמנות כשהקישור האוטומטי לפי ref1 לא הצליח (אסמכתא ריקה,
// עם אותיות, או מספר שלא קיים). המשלוח וסטטוס שלו נשמרים בכל מקרה (upsWebhook.js);
// כאן: הצעות קישור חכמות, קישור/ניתוק ידני ע"י מנהל, והתראה הפוכה על הזמנות
// שנמסרו ל-UPS ולא קיבלו משלוח. ר' בקשת דניאל 30.9.2026.
const crypto = require('crypto');
const { db } = require('./db');
const { emitChange } = require('./bus');
const { getState, closeOrder, RuleError } = require('./workflow');

// אחרי כמה שעות הזמנה במצב "נמסר ל-UPS" בלי שום משלוח מקושר נחשבת חריגה
const ORPHAN_ORDER_HOURS = 24;

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// סגירה אוטומטית כשהמשלוח נמסר — best-effort: הזמנה עם תוספת בדרך או קבוצה
// מקושרת שלא מוכנה נשארת פתוחה, ובשום מקרה לא מפילה את קליטת הסטטוס.
function tryCloseDelivered(orderKey, userId) {
  const st = getState(orderKey);
  if (!st || st.status !== 'delivered_to_ups') return false;
  try {
    closeOrder(orderKey, userId);
    return true;
  } catch (e) {
    console.warn(`סגירה אוטומטית של ${orderKey} נכשלה: ${e.message}`);
    return false;
  }
}

function linkedOrderKeys(trackNo) {
  return db.prepare('SELECT order_key FROM order_shipments WHERE track_no = ?').all(trackNo).map((r) => r.order_key);
}

// חריגת קישור אחת פתוחה לכל שטר+אסמכתא — כל עדכון סטטוס חוזר של אותו שטר לא יוצר עוד אחת
function recordLinkException(trackNo, badRef, reason) {
  const open = db.prepare('SELECT 1 FROM link_exceptions WHERE track_no = ? AND COALESCE(bad_ref, \'\') = ? AND resolved = 0')
    .get(trackNo, badRef || '');
  if (open) return false;
  db.prepare('INSERT INTO link_exceptions (exception_id, track_no, bad_ref, reason) VALUES (?, ?, ?, ?)')
    .run(uid('lexc'), trackNo, badRef || '', reason);
  return true;
}

function normalizeName(s) {
  return String(s || '')
    .replace(/בע"?מ|בע'?מ/g, ' ')
    .replace(/["'`׳״.,\-_/\\()]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// 0..1 — כמה ממילות השם הקצר מופיעות בשם הארוך
function nameSimilarity(a, b) {
  const ta = normalizeName(a);
  const tb = normalizeName(b);
  if (!ta.length || !tb.length) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const hits = short.filter((t) => long.some((u) => u === t || (t.length >= 3 && (u.includes(t) || t.includes(u)))));
  return hits.length / short.length;
}

function digitRuns(...values) {
  const out = new Set();
  for (const v of values) {
    for (const m of String(v || '').match(/\d{3,}/g) || []) out.add(String(Number(m)));
  }
  return [...out];
}

function hoursBetween(a, b) {
  return Math.abs(new Date(`${a}Z`) - new Date(`${b}Z`)) / 36e5;
}

function suggestOrders(trackNo, limit = 5) {
  const ship = db.prepare('SELECT * FROM shipments WHERE track_no = ?').get(trackNo);
  if (!ship) throw Object.assign(new RuleError('משלוח לא נמצא'), { status: 404 });
  const alreadyLinked = new Set(linkedOrderKeys(trackNo));
  const firstSeen = db.prepare('SELECT MIN(created_at) t FROM shipment_events WHERE track_no = ?').get(trackNo).t || ship.updated_at;

  const candidates = new Map();
  const add = (row, points, reason) => {
    if (alreadyLinked.has(row.order_key)) return;
    const c = candidates.get(row.order_key) || { ...row, score: 0, reasons: [] };
    c.score += points;
    c.reasons.push(reason);
    candidates.set(row.order_key, c);
  };

  const baseSelect = `
    SELECT oc.order_key, oc.order_num, oc.customer_name, ws.status,
           (SELECT MAX(created_at) FROM workflow_events we WHERE we.order_key = oc.order_key AND we.to_status = 'delivered_to_ups') AS delivered_at,
           (SELECT COUNT(*) FROM order_shipments os WHERE os.order_key = oc.order_key) AS shipment_count
    FROM orders_cache oc LEFT JOIN workflow_state ws ON ws.order_key = oc.order_key`;

  // מספר הזמנה שמסתתר באסמכתא (למשל SH54707 -> 54707) — הרמז החזק ביותר
  for (const num of digitRuns(ship.ref1, ship.ref2)) {
    for (const row of db.prepare(`${baseSelect} WHERE oc.order_num = ?`).all(Number(num))) {
      add(row, 100, `מספר ההזמנה ${row.order_num} מופיע באסמכתא`);
    }
  }

  // הזמנות שנמסרו ל-UPS ועדיין אין להן משלוח — המועמדות הטבעיות
  const waiting = db.prepare(`${baseSelect} WHERE ws.status = 'delivered_to_ups'`).all()
    .filter((r) => r.shipment_count === 0);
  for (const row of waiting) {
    add(row, 10, 'נמסרה ל-UPS ועדיין בלי משלוח');
  }

  for (const c of candidates.values()) {
    const sim = nameSimilarity(ship.ref2, c.customer_name);
    if (sim >= 0.5) {
      c.score += Math.round(60 * sim);
      c.reasons.push(`שם הנמען דומה ("${String(ship.ref2).trim()}")`);
    }
    if (c.delivered_at && firstSeen && hoursBetween(c.delivered_at, firstSeen) <= 36) {
      c.score += 15;
      c.reasons.push('נמסרה ל-UPS סמוך לעדכון הראשון של המשלוח');
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ order_key, order_num, customer_name, status, score, reasons }) => ({
      order_key, order_num, customer_name, status, score, reasons,
    }));
}

function resolveOrderKey(orderRef) {
  const exact = db.prepare('SELECT order_key FROM orders_cache WHERE order_key = ?').get(String(orderRef));
  if (exact) return exact.order_key;
  const num = Number(String(orderRef).trim());
  if (!Number.isInteger(num) || num <= 0) throw new RuleError('מספר הזמנה לא תקין');
  const matches = db.prepare('SELECT order_key FROM orders_cache WHERE order_num = ?').all(num);
  if (matches.length === 0) throw new RuleError(`לא נמצאה הזמנה עם מספר ${num}`);
  if (matches.length > 1) throw new RuleError('נמצאו כמה הזמנות עם אותו מספר — יש לפנות למנהל מערכת');
  return matches[0].order_key;
}

function noteOnOrder(orderKey, userId, note) {
  const st = getState(orderKey);
  if (!st) return;
  db.prepare(`
    INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uid('evt'), orderKey, userId || null, st.status, st.status, note);
}

function linkShipment(trackNo, orderRef, userId) {
  const ship = db.prepare('SELECT * FROM shipments WHERE track_no = ?').get(trackNo);
  if (!ship) throw Object.assign(new RuleError('משלוח לא נמצא'), { status: 404 });
  const orderKey = resolveOrderKey(orderRef);

  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO order_shipments (order_key, track_no, ref1_raw) VALUES (?, ?, ?)')
      .run(orderKey, trackNo, 'קישור ידני');
    db.prepare('UPDATE link_exceptions SET resolved = 1 WHERE track_no = ? AND resolved = 0').run(trackNo);
    noteOnOrder(orderKey, userId, `שטר UPS ${trackNo} קושר ידנית להזמנה`);
  });
  tx();

  // המשלוח כבר נמסר לפני שקושר — סוגרים עכשיו, בדיוק כמו בקישור אוטומטי
  const closed = ship.status === 'ship_delivered' ? tryCloseDelivered(orderKey, userId) : false;
  emitChange('shipment', { track_no: trackNo, status: ship.status, linked: [orderKey], exceptions: [] });
  return { ok: true, trackNo, orderKey, closed };
}

function unlinkShipment(trackNo, orderKey, userId) {
  const res = db.prepare('DELETE FROM order_shipments WHERE track_no = ? AND order_key = ?').run(trackNo, orderKey);
  if (res.changes === 0) throw Object.assign(new RuleError('הקישור לא נמצא'), { status: 404 });
  noteOnOrder(orderKey, userId, `בוטל הקישור לשטר UPS ${trackNo}`);
  const ship = db.prepare('SELECT status FROM shipments WHERE track_no = ?').get(trackNo);
  emitChange('shipment', { track_no: trackNo, status: ship && ship.status, linked: [], exceptions: [] });
  return { ok: true };
}

// הכיוון ההפוך: הזמנות שנמסרו ל-UPS לפני יותר מ-ORPHAN_ORDER_HOURS ואף משלוח לא קושר אליהן
function ordersWithoutShipment() {
  return db.prepare(`
    SELECT * FROM (
      SELECT oc.order_key, oc.order_num, oc.customer_name,
             (SELECT MAX(created_at) FROM workflow_events we WHERE we.order_key = oc.order_key AND we.to_status = 'delivered_to_ups') AS delivered_at
      FROM workflow_state ws JOIN orders_cache oc ON oc.order_key = ws.order_key
      WHERE ws.status = 'delivered_to_ups'
        AND NOT EXISTS (SELECT 1 FROM order_shipments os WHERE os.order_key = ws.order_key)
    )
    WHERE delivered_at IS NOT NULL AND delivered_at <= datetime('now', ?)
    ORDER BY delivered_at ASC
  `).all(`-${ORPHAN_ORDER_HOURS} hours`);
}

module.exports = {
  suggestOrders, linkShipment, unlinkShipment, ordersWithoutShipment,
  recordLinkException, tryCloseDelivered, linkedOrderKeys, nameSimilarity,
  ORPHAN_ORDER_HOURS,
};
