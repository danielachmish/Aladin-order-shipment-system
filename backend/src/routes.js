const express = require('express');
const crypto = require('crypto');
const { db } = require('./db');
const { login, authMiddleware, requireRole } = require('./auth');
const wf = require('./workflow');
const { queueForStatus, positionInQueue } = require('./queue');
const urgent = require('./urgentRequests');
const ups = require('./upsWebhook');
const { emitChange } = require('./bus');
const { ups: upsCfg, sigma: sigmaCfg } = require('./config');
const sigmaIngest = require('./sigmaIngest');
const { computeDashboard } = require('./dashboard');

const router = express.Router();

// הסכום המוצג על הזמנה הוא תמיד סכום השורות בפועל כרגע (order_items_cache),
// לא המספר הקפוא שנמשך פעם אחת מסיגמא (orders_cache.total_amount) — כדי
// שישקף שינויים בפועל (חוסר, תיקון כמות וכו'). נופל חזרה לערך הקפוא רק אם
// אין עדיין שורות פריטים בכלל (למשל הזמנה שעוד לא סונכרנה עם פריטים).
// ר' בקשת דניאל 17.9.2026: "הסכום... בפועל מה שקיים כרגע".
const LIVE_TOTAL_SQL = `ROUND(COALESCE((SELECT SUM(quantity * price) FROM order_items_cache oic WHERE oic.order_key = oc.order_key), oc.total_amount), 2)`;

// תיקון אבטחה (סקירה 14.9.2026): לא הייתה שום הגנה מפני ניחוש-סיסמה בכוח גס על
// /auth/login (סיסמאות טקסט-גלוי, לעיתים קצרות כמו "1234" — ר' seed.js/auth.js).
// הגבלת קצב פשוטה בזיכרון, לפי כתובת IP: מקסימום 10 ניסיונות התחברות כושלים
// לכל IP בחלון של 5 דקות. לא נדרשת תלות חיצונית לצורך זה.
const loginAttempts = new Map(); // ip -> { count, windowStart }
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 0, windowStart: now });
    return next();
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfterSec = Math.ceil((LOGIN_WINDOW_MS - (now - entry.windowStart)) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'יותר מדי ניסיונות התחברות — נסה שוב בעוד כמה דקות' });
  }
  next();
}

// ---------- Auth ----------
router.post('/auth/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password);
  if (!result) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const entry = loginAttempts.get(ip) || { count: 0, windowStart: Date.now() };
    entry.count += 1;
    loginAttempts.set(ip, entry);
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  }
  res.json(result);
});

router.get('/health', (req, res) => {
  const orders = db.prepare('SELECT COUNT(*) c FROM orders_cache').get().c;
  res.json({ ok: true, orders, ts: Date.now() });
});

// ---------- UPS Webhook ----------
// ממוקם לפני authMiddleware בכוונה: UPS קורא לנתיב הזה בלי טוקן JWT פנימי שלנו.
// אימות: נדרש Authorization: Bearer <UPS_WEBHOOK_BEARER_SECRET> תמיד מעל HTTPS
// (סעיף 9.2, 13).
// תיקון אבטחה (סקירה 14.9.2026): קודם, כשהסוד לא היה מוגדר, הנתיב פשוט קיבל כל
// בקשה בלי אימות ("נכשל פתוח") — נתיב חשוף לאינטרנט שיכול לגרום לסגירה אוטומטית
// של הזמנות אמיתיות (ship_delivered -> closeOrder). עכשיו: אם הסוד לא מוגדר,
// הנתיב נדחה כברירת מחדל. לבדיקה מקומית בלי סוד: הגדירו
// ALLOW_UNAUTHENTICATED_UPS_WEBHOOK=true במפורש בסביבת הפיתוח שלכם בלבד.
router.post('/webhooks/ups', express.json(), (req, res) => {
  const devBypass = !upsCfg.webhookBearerSecret && process.env.ALLOW_UNAUTHENTICATED_UPS_WEBHOOK === 'true';
  if (!devBypass) {
    if (!upsCfg.webhookBearerSecret) {
      return res.status(503).json({ error: 'UPS_WEBHOOK_BEARER_SECRET לא מוגדר בשרת — Webhook חסום' });
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token !== upsCfg.webhookBearerSecret) {
      return res.status(401).json({ error: 'אימות Webhook נכשל' });
    }
  }
  try {
    const result = ups.handleWebhook(req.body);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------- Sigma Bridge (push מהרשת המקומית) ----------
// ממוקם לפני authMiddleware בכוונה: ה-Bridge המקומי (ר' bridge/) לא מחזיק
// טוקן JWT פנימי — הוא מזדהה עם SIGMA_BRIDGE_SECRET משלו (ר' config.js).
router.post('/admin/sigma-sync', express.json({ limit: '25mb' }), (req, res) => {
  if (!sigmaCfg.bridgeSecret) {
    return res.status(400).json({ error: 'SIGMA_BRIDGE_SECRET לא מוגדר בשרת — אין למי לקבל נתונים' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== sigmaCfg.bridgeSecret) {
    return res.status(401).json({ error: 'אימות Sigma Bridge נכשל' });
  }
  try {
    const orders = req.body?.orders;
    if (!Array.isArray(orders)) return res.status(400).json({ error: 'שדה orders חסר או לא מערך' });
    const result = sigmaIngest.ingestOrders(orders);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ניקוי: סוגר אוטומטית הזמנות "ממתינות לליקוט" שכבר לא ברשימה הפתוחה של Sigma
// (לא נוגע בהזמנות שכבר בעבודה). נקרא פעם אחת בסוף כל סבב סנכרון מלא.
router.post('/admin/sigma-sync/reconcile', express.json({ limit: '1mb' }), (req, res) => {
  if (!sigmaCfg.bridgeSecret) {
    return res.status(400).json({ error: 'SIGMA_BRIDGE_SECRET לא מוגדר בשרת' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== sigmaCfg.bridgeSecret) {
    return res.status(401).json({ error: 'אימות Sigma Bridge נכשל' });
  }
  try {
    const { companyId, sidra, validOrderNums } = req.body || {};
    if (!Array.isArray(validOrderNums)) return res.status(400).json({ error: 'שדה validOrderNums חסר או לא מערך' });
    const result = sigmaIngest.reconcileOpenOrders(companyId, sidra, validOrderNums);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- הזמנות "ממתינות לאישור" (status_ID=0 — עדיין אצל המזכירה) ----------
// תצוגה בלבד, לא חלק מתור הליקוט. אותו דפוס אימות כמו שאר ה-Sigma Bridge.
router.post('/admin/sigma-sync/pending', express.json({ limit: '10mb' }), (req, res) => {
  if (!sigmaCfg.bridgeSecret) {
    return res.status(400).json({ error: 'SIGMA_BRIDGE_SECRET לא מוגדר בשרת' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== sigmaCfg.bridgeSecret) {
    return res.status(401).json({ error: 'אימות Sigma Bridge נכשל' });
  }
  try {
    const orders = req.body?.orders;
    if (!Array.isArray(orders)) return res.status(400).json({ error: 'שדה orders חסר או לא מערך' });
    const result = sigmaIngest.ingestPendingOrders(orders);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/sigma-sync/pending/reconcile', express.json({ limit: '1mb' }), (req, res) => {
  if (!sigmaCfg.bridgeSecret) {
    return res.status(400).json({ error: 'SIGMA_BRIDGE_SECRET לא מוגדר בשרת' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== sigmaCfg.bridgeSecret) {
    return res.status(401).json({ error: 'אימות Sigma Bridge נכשל' });
  }
  try {
    const { companyId, sidra, validOrderNums } = req.body || {};
    if (!Array.isArray(validOrderNums)) return res.status(400).json({ error: 'שדה validOrderNums חסר או לא מערך' });
    const result = sigmaIngest.reconcilePendingOrders(companyId, sidra, validOrderNums);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// תיקון-חירום: שחזור הזמנות שנסגרו בטעות ע"י קריאת reconcile שגויה (לא נשלחת
// כחלק מהזרימה הרגילה — נשארת כאן לשימוש נקודתי במקרה חירום דומה בעתיד).
router.post('/admin/sigma-sync/undo-closures', express.json({ limit: '1mb' }), (req, res) => {
  if (!sigmaCfg.bridgeSecret) {
    return res.status(400).json({ error: 'SIGMA_BRIDGE_SECRET לא מוגדר בשרת' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== sigmaCfg.bridgeSecret) {
    return res.status(401).json({ error: 'אימות Sigma Bridge נכשל' });
  }
  try {
    const { companyId, sidra, sinceMinutesAgo } = req.body || {};
    const result = sigmaIngest.undoRecentSyncClosures(companyId, sidra, sinceMinutesAgo || 30);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// מיפוי פריט->ספק (ר' ייעוץ 16.9.2026, נושא 5) - נדחף בנפרד מהזמנות, בקצב
// איטי יותר (קטלוג, לא תור עבודה). אותו דפוס אימות כמו שאר ה-Sigma Bridge.
router.post('/admin/sigma-sync/suppliers', express.json({ limit: '10mb' }), (req, res) => {
  if (!sigmaCfg.bridgeSecret) {
    return res.status(400).json({ error: 'SIGMA_BRIDGE_SECRET לא מוגדר בשרת' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token !== sigmaCfg.bridgeSecret) {
    return res.status(401).json({ error: 'אימות Sigma Bridge נכשל' });
  }
  try {
    const items = req.body?.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'שדה items חסר או לא מערך' });
    const result = sigmaIngest.ingestItemSuppliers(items);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.use(authMiddleware);

// ---------- Settings ----------
function getSetting(key, def) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

router.get('/settings/agent-view-scope', (req, res) => {
  res.json({ scope: getSetting('agent_view_scope', 'all') });
});

router.post('/settings/agent-view-scope', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const { scope } = req.body || {};
  if (!['all', 'own'].includes(scope)) return res.status(400).json({ error: 'ערך לא תקין' });
  db.prepare(`INSERT INTO settings (key, value) VALUES ('agent_view_scope', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(scope);
  emitChange('settings', { key: 'agent_view_scope', value: scope });
  res.json({ scope });
});

// ---------- Orders ----------
function baseOrderRow(order_key) {
  return db.prepare(`
    SELECT oc.*, ws.status, ws.priority, ws.agent_id, ws.claimed_by, ws.queue_entered_at,
           ws.version, ws.hold_reason, ws.pre_wait_status, ws.pending_addition_note, ws.delivery_method,
           ws.linked_group_id, ws.updated_at AS wf_updated_at,
           ws.package_count, ws.pallet_count, ws.cod_type, ws.cod_amount, ws.cod_due_date,
           ws.planned_delivery_method, ws.special_instructions,
           COALESCE(u.display_name, oc.sigma_agent_name) AS agent_name, cu.display_name AS claimed_by_name,
           ${LIVE_TOTAL_SQL} AS total_amount
    FROM orders_cache oc
    JOIN workflow_state ws ON ws.order_key = oc.order_key
    LEFT JOIN users u ON u.user_id = ws.agent_id
    LEFT JOIN users cu ON cu.user_id = ws.claimed_by
    WHERE oc.order_key = ?
  `).get(order_key);
}

// שיוך הזמנה לסוכן: או שיוך מפורש (ws.agent_id, כמעט אף פעם לא קיים כי הזמנות
// מגיעות מסיגמא עם שם סוכן כטקסט חופשי בלבד — sigma_agent_name), או התאמה
// לפי שם תצוגה: אם למשתמש-הסוכן שם זהה (אחרי טרים/נירמול רווחים) לשם הסוכן
// שהגיע מסיגמא. בלי זה, שום סוכן לא היה יכול לפעול על אף הזמנה משלו בפועל —
// באג שדניאל דיווח עליו 14.9.2026 ("אין אפשרות ללחוץ דחופה/תוספת").
function normalizeName(s) {
  // מסיר גם סיומת בסוגריים כמו "(סוכן)"/"(סוכנת)" — הרגל מהמשתמשי-דמו הישנים
  // שאנשים נוטים לחזור עליו כשיוצרים משתמש חדש, אבל בסיגמא השם מגיע נקי.
  return (s || '').trim().replace(/\s+/g, ' ').replace(/\s*\([^)]*\)\s*$/, '').trim();
}
function isAssignedAgent(order, user) {
  if (!user || user.role !== 'agent') return false;
  if (order.agent_id && order.agent_id === user.id) return true;
  const orderAgentName = normalizeName(order.agent_name || order.sigma_agent_name);
  return !!orderAgentName && orderAgentName === normalizeName(user.name);
}

function shipmentsForOrder(order_key) {
  return db.prepare(`
    SELECT s.*, os.ref1_raw
    FROM order_shipments os
    JOIN shipments s ON s.track_no = os.track_no
    WHERE os.order_key = ?
    ORDER BY s.updated_at DESC
  `).all(order_key);
}

router.get('/orders', (req, res) => {
  const { status, search } = req.query;
  const scope = getSetting('agent_view_scope', 'all');

  let sql = `
    SELECT oc.order_key, oc.order_num, oc.customer_name, ${LIVE_TOTAL_SQL} AS total_amount, oc.line_count, oc.notes,
           ws.status, ws.priority, ws.agent_id, ws.claimed_by, ws.queue_entered_at, ws.version,
           ws.pending_addition_note, ws.linked_group_id,
           ws.cod_type, ws.planned_delivery_method, ws.special_instructions,
           COALESCE(u.display_name, oc.sigma_agent_name) AS agent_name, cu.display_name AS claimed_by_name
    FROM orders_cache oc
    JOIN workflow_state ws ON ws.order_key = oc.order_key
    LEFT JOIN users u ON u.user_id = ws.agent_id
    LEFT JOIN users cu ON cu.user_id = ws.claimed_by
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    const list = String(status).split(',').map((s) => s.trim());
    sql += ` AND ws.status IN (${list.map(() => '?').join(',')})`;
    params.push(...list);
  }
  if (search) {
    sql += ` AND (oc.order_num LIKE ? OR oc.customer_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  // סוכן: תלוי במתג "תצוגת הזמנות לסוכנים" (סעיף 5.4). סוכן יכול תמיד לראות רק את שלו אם scope=own.
  // "שלו" = שיוך מפורש (agent_id, נדיר) או התאמת שם תצוגה לשם הסוכן שהגיע מסיגמא
  // (ר' isAssignedAgent) — לכן ההשוואה כאן גם מול sigma_agent_name, לא רק agent_id.
  if (req.user.role === 'agent' && scope === 'own') {
    sql += ` AND (ws.agent_id = ? OR TRIM(oc.sigma_agent_name) = TRIM(?))`;
    params.push(req.user.id, req.user.name);
  }

  let rows = db.prepare(sql).all(...params);

  // הוספת מיקום בתור להזמנות שבתור ממתינה לליקוט + סכום גוביינא מחושב
  // (רק כשיש גוביינא בכלל — לא לבזבז שאילתה על כל שורה סתם)
  rows = rows.map((r) => {
    let extra = {};
    if (r.status === 'waiting_pick') {
      extra.queue_position = positionInQueue(r.order_key, 'waiting_pick');
    }
    if (r.cod_type && r.cod_type !== 'none') {
      extra.cod_display_amount = wf.computeCodDisplay(r.order_key);
    }
    return { ...r, ...extra };
  });

  res.json({ orders: rows, agent_view_scope: scope });
});

router.get('/orders/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const order = baseOrderRow(key);
  if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

  if (req.user.role === 'agent' && !isAssignedAgent(order, req.user)) {
    const scope = getSetting('agent_view_scope', 'all');
    if (scope === 'own') return res.status(403).json({ error: 'אין הרשאה לצפות בהזמנה זו' });
  }

  const items = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? ORDER BY line_no').all(key);
  const events = db.prepare(`
    SELECT we.*, u.display_name AS user_name FROM workflow_events we
    LEFT JOIN users u ON u.user_id = we.user_id
    WHERE we.order_key = ? ORDER BY we.created_at DESC
  `).all(key);
  const shipments = shipmentsForOrder(key);
  const urgentReqs = urgent.listForOrder(key);
  const queuePos = order.status === 'waiting_pick' ? positionInQueue(key, 'waiting_pick') : null;

  // הזמנות מקושרות (ר' workflow.js linkOrders) — שאר ההזמנות באותה קבוצה
  const linkedOrders = order.linked_group_id
    ? db.prepare(`
        SELECT oc.order_key, oc.order_num, oc.customer_name, ws.status
        FROM workflow_state ws JOIN orders_cache oc ON oc.order_key = ws.order_key
        WHERE ws.linked_group_id = ? AND ws.order_key != ?
      `).all(order.linked_group_id, key)
    : [];

  const codDisplayAmount = wf.computeCodDisplay(key);
  res.json({ order: { ...order, cod_display_amount: codDisplayAmount }, items, events, shipments, urgent_requests: urgentReqs, queue_position: queuePos, linked_orders: linkedOrders });
});

// הזמנות מקושרות ידנית — ר' workflow.js linkOrders (בקשת דניאל 14.9.2026)
router.post('/orders/:key/link', requireRole('agent', 'warehouse', 'warehouse_manager', 'system_admin'), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { otherOrderNum } = req.body || {};
    if (!otherOrderNum) return res.status(400).json({ error: 'יש להזין מספר הזמנה לקישור' });
    const result = wf.linkOrders(key, String(otherOrderNum).trim(), req.user.id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/orders/:key/unlink', requireRole('agent', 'warehouse', 'warehouse_manager', 'system_admin'), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const state = wf.unlinkOrder(key, req.user.id);
    res.json({ ok: true, state });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

function handleWorkflowAction(fn) {
  return (req, res) => {
    const key = decodeURIComponent(req.params.key);
    try {
      const result = fn(key, req);
      res.json({ ok: true, state: result });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, current: e.current, code: e.code });
    }
  };
}

router.post('/orders/:key/claim', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.claimOrder(key, req.user.id, req.body?.expectedVersion)));

router.post('/orders/:key/finish-picking', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.finishPicking(key, req.user.id, req.body?.expectedVersion)));

// ליקוט לפי מיקום + בדיקה (QC) — ר' PICKING_QC_SPEC.md (סוכם עם דניאל 14.9.2026)
router.post('/orders/:key/items/:lineNo/pick', requireRole('warehouse', 'warehouse_manager'), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const lineNo = Number(req.params.lineNo);
    const { qtyPicked, pickStatus, pickNote } = req.body || {};
    const item = wf.updateItemPick(key, lineNo, req.user.id, { qtyPicked, pickStatus, pickNote });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/orders/:key/items/:lineNo/check', requireRole('warehouse', 'warehouse_manager'), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const lineNo = Number(req.params.lineNo);
    const { checked, checkNote } = req.body || {};
    const item = wf.updateItemCheck(key, lineNo, req.user.id, { checked, checkNote });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// תיקון בודק לשורה שהמלקט כבר סימן (למשל: המלקט טעה, בפועל חסר/הכמות
// שונה, או להפך — כן נמצא). ר' PICKING_QC_SPEC.md סעיף 12 (בקשת דניאל 14.9.2026)
router.post('/orders/:key/items/:lineNo/correct-pick', requireRole('warehouse', 'warehouse_manager'), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const lineNo = Number(req.params.lineNo);
    const { qtyPicked, pickStatus, checkNote } = req.body || {};
    const item = wf.correctPickedItem(key, lineNo, req.user.id, { qtyPicked, pickStatus, checkNote });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// סריקת ברקוד — ליקוט ובדיקה כאחד, ההקשר (סטטוס ההזמנה) קובע את הפעולה
// בצד השרת. ר' BARCODE_SCANNING_SPEC.md.
router.post('/orders/:key/items/scan', requireRole('warehouse', 'warehouse_manager'), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const { barcode, clientEventId, deviceId, quantity } = req.body || {};
    if (!barcode || typeof barcode !== 'string') return res.status(400).json({ error: 'ברקוד חסר' });
    if (!clientEventId || typeof clientEventId !== 'string') return res.status(400).json({ error: 'clientEventId חסר' });
    const result = wf.scanItem(key, { barcode, clientEventId, userId: req.user.id, deviceId: deviceId || null, quantity });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/orders/:key/finish-check', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.finishCheck(key, req.user.id, req.body?.expectedVersion)));

router.post('/orders/:key/pack-done', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.packDone(key, req.user.id, req.body?.expectedVersion, req.body?.packageCount, req.body?.palletCount)));

router.post('/orders/:key/deliver-ups', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.deliverToUps(key, req.user.id, req.body?.expectedVersion)));

router.post('/orders/:key/self-pickup', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.selfPickup(key, req.user.id, req.body?.expectedVersion)));

router.post('/orders/:key/close', requireRole('warehouse', 'warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.closeOrder(key, req.user.id)));

router.post('/orders/:key/issue', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.reportIssue(key, req.user.id, req.body?.reason || 'לא צוינה סיבה')));

// שחרור הזמנה מעוכבת: גם למחסן הרגיל (לא רק מנהל מחסן) — כדי שלא יתקע
// לגמרי אם הוא-עצמו דיווח את הבעיה ורוצה להמשיך. ביטול מלא נשאר למנהל בלבד
// (סעיף בקשת דניאל, 14.9.2026).
router.post('/orders/:key/release-hold', requireRole('warehouse', 'warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.releaseHold(key, req.user.id, req.body?.note)));

router.post('/orders/:key/cancel', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.cancelOrder(key, req.user.id, req.body?.note)));

router.post('/orders/:key/request-wait', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.requestWait(key, req.user.id)));

router.post('/orders/:key/received-answer', requireRole('warehouse', 'warehouse_manager', 'agent', 'system_admin'),
  handleWorkflowAction((key, req) => {
    const order = baseOrderRow(key);
    if (req.user.role === 'agent' && !isAssignedAgent(order, req.user)) {
      const err = new Error('רק הסוכן המשויך להזמנה יכול לעדכן תשובה');
      err.status = 403;
      throw err;
    }
    return wf.receivedAnswer(key, req.user.id);
  }));

router.post('/orders/:key/priority', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.setPriority(key, req.body?.priority, req.user.id)));

// ---------- "תוספת" בדרך — חוסם סגירת ההזמנה עד שתסומן כהגיעה ----------
router.post('/orders/:key/request-addition', requireRole('agent', 'warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => {
    const order = baseOrderRow(key);
    if (req.user.role === 'agent' && !isAssignedAgent(order, req.user)) {
      const err = new Error('רק הסוכן המשויך להזמנה יכול לבקש תוספת');
      err.status = 403;
      throw err;
    }
    return wf.requestAddition(key, req.user.id, req.body?.note);
  }));

router.post('/orders/:key/addition-received', requireRole('agent', 'warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => {
    const order = baseOrderRow(key);
    if (req.user.role === 'agent' && !isAssignedAgent(order, req.user)) {
      const err = new Error('רק הסוכן המשויך להזמנה יכול לעדכן שהתוספת הגיעה');
      err.status = 403;
      throw err;
    }
    return wf.additionReceived(key, req.user.id);
  }));

// ---------- בקשות דחיפות ----------
router.post('/orders/:key/urgent-request', requireRole('agent'), (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
    const order = baseOrderRow(key);
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (!isAssignedAgent(order, req.user)) {
      return res.status(403).json({
        error: `ניתן לבקש דחיפות רק להזמנות שלך (השם שלך: "${req.user.name}", הסוכן על ההזמנה: "${order.agent_name || '—'}")`,
      });
    }
    const result = urgent.createRequest(key, req.user.id);
    res.json({ ok: true, request: result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/urgent-requests/pending', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  res.json({ requests: urgent.listPending() });
});

router.post('/urgent-requests/:id/decide', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  try {
    const result = urgent.decideRequest(req.params.id, req.user.id, !!req.body?.approve);
    res.json({ ok: true, request: result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------- חריגות ----------
router.get('/exceptions', (req, res) => {
  const onHold = db.prepare(`
    SELECT oc.order_key, oc.order_num, oc.customer_name, ws.hold_reason, ws.updated_at
    FROM workflow_state ws JOIN orders_cache oc ON oc.order_key = ws.order_key
    WHERE ws.status = 'on_hold' ORDER BY ws.updated_at DESC
  `).all();
  const linkExceptions = db.prepare(`
    SELECT * FROM link_exceptions WHERE resolved = 0 ORDER BY created_at DESC
  `).all();
  const shipmentExceptions = db.prepare(`
    SELECT * FROM shipments WHERE status = 'ship_exception' ORDER BY updated_at DESC
  `).all();
  res.json({ onHold, linkExceptions, shipmentExceptions });
});

router.post('/link-exceptions/:id/resolve', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  db.prepare('UPDATE link_exceptions SET resolved = 1 WHERE exception_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- היסטוריה (הזמנות שסיימו ליקוט, למחסן ולניהול) ----------
// "סיימו ליקוט" = כל הזמנה שכבר עברה את שלב הליקוט (גם אם עדיין באריזה/במשלוח/סגורה).
// ---------- דשבורד מנהל ----------
router.get('/dashboard', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  try {
    res.json(computeDashboard());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', requireRole('warehouse', 'warehouse_manager', 'system_admin'), (req, res) => {
  const { search, days } = req.query;
  const sinceDays = Number(days) > 0 ? Number(days) : 30;

  let sql = `
    SELECT oc.order_key, oc.order_num, oc.customer_name, ${LIVE_TOTAL_SQL} AS total_amount,
           ws.status, ws.priority, ws.updated_at, ws.shortage_invoiced_at, ws.shortage_invoiced_by,
           ws.package_count, ws.pallet_count, ws.linked_group_id,
           ws.cod_type, ws.cod_amount, ws.cod_due_date
    FROM orders_cache oc
    JOIN workflow_state ws ON ws.order_key = oc.order_key
    WHERE ws.status IN ('ready_for_check','ready_to_pack','waiting_pickup','delivered_to_ups','closed')
      AND ws.updated_at >= datetime('now', ?)
  `;
  const params = [`-${sinceDays} days`];
  if (search) {
    sql += ` AND (oc.order_num LIKE ? OR oc.customer_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ` ORDER BY ws.updated_at DESC LIMIT 300`;

  const orders = db.prepare(sql).all(...params);

  const pickStartStmt = db.prepare(`
    SELECT created_at, user_id FROM workflow_events
    WHERE order_key = ? AND to_status = 'picking' ORDER BY created_at ASC LIMIT 1
  `);
  const pickEndStmt = db.prepare(`
    SELECT created_at FROM workflow_events
    WHERE order_key = ? AND to_status = 'ready_to_pack' ORDER BY created_at DESC LIMIT 1
  `);
  const issuesStmt = db.prepare(`
    SELECT we.created_at, we.note, u.display_name AS user_name
    FROM workflow_events we LEFT JOIN users u ON u.user_id = we.user_id
    WHERE we.order_key = ? AND we.to_status IN ('on_hold', 'cancelled', 'waiting_answer')
    ORDER BY we.created_at ASC
  `);
  const userStmt = db.prepare(`SELECT display_name FROM users WHERE user_id = ?`);
  // דוח חוסרים למזכירה — ר' PICKING_QC_SPEC.md סעיף 5.3 (סוכם עם דניאל 14.9.2026)
  const shortagesStmt = db.prepare(`
    SELECT line_no, item_code, item_name, quantity AS qty_ordered, qty_picked, pick_status, pick_note, check_note,
           replaced_to, replaced_qty, replaced_confirmed
    FROM order_items_cache
    WHERE order_key = ? AND pick_status IN ('missing', 'partial')
    ORDER BY line_no
  `);

  const result = orders.map((o) => {
    const start = pickStartStmt.get(o.order_key);
    const end = pickEndStmt.get(o.order_key);
    const issues = issuesStmt.all(o.order_key);
    const shortages = shortagesStmt.all(o.order_key);
    return {
      ...o,
      pick_started_at: start ? start.created_at : null,
      picked_by: start && start.user_id ? (userStmt.get(start.user_id) || {}).display_name : null,
      pick_finished_at: end ? end.created_at : null,
      shortage_invoiced_by_name: o.shortage_invoiced_by ? (userStmt.get(o.shortage_invoiced_by) || {}).display_name : null,
      cod_display_amount: wf.computeCodDisplay(o.order_key),
      issues,
      shortages,
    };
  });

  res.json({ orders: result, sinceDays });
});

// דוח חוסרים למזכירה — סימון/ביטול "טופל" (הופקה חשבונית מתוקנת) ברמת
// ההזמנה כולה. ר' PICKING_QC_SPEC.md סעיף 12 (בקשת דניאל 14.9.2026).
router.post('/orders/:key/mark-shortage-invoiced', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.markShortageInvoiced(key, req.user.id)));

router.post('/orders/:key/unmark-shortage-invoiced', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.unmarkShortageInvoiced(key, req.user.id)));

// "הוחלף צבע" — תיעוד תחליף שהלקוח אישר לפריט חסר, עם כמות מפורשת (ר' ייעוץ
// 17.9.2026). זמין למלקט/בודק (warehouse) בזמן אמת וגם למנהל מההיסטוריה
// אחר כך — לא נכתב לסיגמא. replacedTo ריק/חסר = מבטל את הסימון.
router.post('/orders/:key/items/:lineNo/replace', requireRole('warehouse', 'warehouse_manager', 'system_admin'), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const lineNo = Number(req.params.lineNo);
    const item = wf.markItemReplaced(key, lineNo, req.user.id, req.user.role, req.body?.replacedTo, req.body?.replacedQty);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// הבודק מאשר תחליף שהמלקט כבר הזין, בלי לערוך מחדש — ר' בקשת דניאל
// 17.9.2026 ("הבודק צריך לוודא שאכן הביא את הדבר הנכון... וגם את הכמות").
router.post('/orders/:key/items/:lineNo/confirm-replace', requireRole('warehouse', 'warehouse_manager', 'system_admin'), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const lineNo = Number(req.params.lineNo);
    const item = wf.confirmItemReplacement(key, lineNo, req.user.id);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// גוביינא (שיק דחוי) — ר' ייעוץ 17.9.2026. המזכירה בלבד (warehouse_manager/system_admin).
router.post('/orders/:key/cod', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.updateOrderSettings(key, req.user.id, {
    codType: req.body?.codType, amount: req.body?.amount, dueDate: req.body?.dueDate,
  })));

// "⚙️ הגדרות הזמנה" — פאנל מהיר (גוביינא + משלוח מתוכנן + הערה + עדיפות)
// שמנהל יכול למלא מוקדם, ישר מרשימת ההזמנות, לא רק אחרי שההזמנה עברה
// להיסטוריה. ר' ייעוץ 17.9.2026. שדה שלא נשלח בכלל נשאר ללא שינוי.
router.post('/orders/:key/settings', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.updateOrderSettings(key, req.user.id, {
    codType: req.body?.codType, amount: req.body?.amount, dueDate: req.body?.dueDate,
    plannedDeliveryMethod: req.body?.plannedDeliveryMethod, specialInstructions: req.body?.specialInstructions,
    priority: req.body?.priority,
  })));

// "חוסרי מלאי היום" — תצוגה מרוכזת לפי מק"ט למנהל מחסן (לא לפי הזמנה, כמו
// דוח החוסרים למזכירה — כאן המטרה לדעת מה חסר במלאי בפועל). ר' בקשת דניאל 14.9.2026.
router.get('/inventory/shortages', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const days = Number(req.query.days) > 0 ? Number(req.query.days) : 1;
  const rows = db.prepare(`
    SELECT oic.order_key, oic.item_code, oic.item_name, oic.quantity, oic.qty_picked, oic.pick_status,
           oc.order_num, oc.customer_name, oc.sigma_agent_name AS agent_name
    FROM order_items_cache oic
    JOIN orders_cache oc ON oc.order_key = oic.order_key
    WHERE oic.pick_status IN ('missing', 'partial')
      AND oic.pick_marked_at >= datetime('now', ?)
    ORDER BY oic.pick_marked_at DESC
  `).all(`-${days} days`);

  const supplierByItem = new Map(
    db.prepare('SELECT item_code, supplier_id, supplier_name FROM item_suppliers').all()
      .map((s) => [s.item_code, s])
  );

  const byItem = new Map();
  for (const r of rows) {
    const missingQty = r.pick_status === 'missing' ? r.quantity : Math.max(0, (r.quantity || 0) - (r.qty_picked || 0));
    if (missingQty <= 0) continue;
    if (!byItem.has(r.item_code)) {
      const supplier = supplierByItem.get(r.item_code);
      byItem.set(r.item_code, {
        item_code: r.item_code, item_name: r.item_name, total_missing: 0, orders: [],
        supplier_id: supplier?.supplier_id ?? null, supplier_name: supplier?.supplier_name ?? null,
      });
    }
    const entry = byItem.get(r.item_code);
    entry.total_missing += missingQty;
    entry.orders.push({
      order_key: r.order_key, order_num: r.order_num, customer_name: r.customer_name,
      agent_name: r.agent_name, missing_qty: missingQty, item_name: r.item_name, item_code: r.item_code,
    });
  }
  const items = Array.from(byItem.values()).sort((a, b) => b.total_missing - a.total_missing);
  res.json({ items, days });
});

// "מוצרים שחזרו למלאי" (ר' ייעוץ 17.9.2026, נושא 4) — רשימת פריטים שהוגדרו
// "חסר מאומת" (ר' workflow.js propagateConfirmedShortages) וכפתור לנקות.
router.get('/inventory/shorted-items', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  res.json({ items: wf.listShortedItems() });
});

router.post('/inventory/shorted-items/:itemCode/clear', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const result = wf.clearShortedItem(req.params.itemCode);
  res.json({ ok: true, ...result });
});

// חוסרים של הסוכן המחובר בלבד (ר' ייעוץ 17.9.2026, נושא 6) — לא נותנים לסוכן
// לראות הזמנות של סוכנים אחרים. לפי agent_id אמיתי (users.sigma_agent_id
// שמסונכרן מ-Sigma) עם נפילה חזרה להתאמת שם, כמו ב-GET /orders.
router.get('/inventory/my-shortages', requireRole('agent'), (req, res) => {
  const days = Number(req.query.days) > 0 ? Number(req.query.days) : 1;
  const rows = db.prepare(`
    SELECT oic.order_key, oic.item_code, oic.item_name, oic.quantity, oic.qty_picked, oic.pick_status,
           oc.order_num, oc.customer_name
    FROM order_items_cache oic
    JOIN orders_cache oc ON oc.order_key = oic.order_key
    JOIN workflow_state ws ON ws.order_key = oic.order_key
    WHERE oic.pick_status IN ('missing', 'partial')
      AND oic.pick_marked_at >= datetime('now', ?)
      AND (ws.agent_id = ? OR TRIM(oc.sigma_agent_name) = TRIM(?))
    ORDER BY oic.pick_marked_at DESC
  `).all(`-${days} days`, req.user.id, req.user.name);

  const byItem = new Map();
  for (const r of rows) {
    const missingQty = r.pick_status === 'missing' ? r.quantity : Math.max(0, (r.quantity || 0) - (r.qty_picked || 0));
    if (missingQty <= 0) continue;
    if (!byItem.has(r.item_code)) {
      byItem.set(r.item_code, { item_code: r.item_code, item_name: r.item_name, total_missing: 0, orders: [] });
    }
    const entry = byItem.get(r.item_code);
    entry.total_missing += missingQty;
    entry.orders.push({ order_key: r.order_key, order_num: r.order_num, customer_name: r.customer_name, missing_qty: missingQty });
  }
  const items = Array.from(byItem.values()).sort((a, b) => b.total_missing - a.total_missing);
  res.json({ items, days });
});

// אותם חוסרים, מקובצים לפי ספק במקום לפי פריט - למחלקת רכש (ר' ייעוץ 16.9.2026,
// נושא 5). פריט בלי ספק ידוע (עדיין לא סונכרן/לא משוייך ב-Sigma) מקובץ תחת
// supplier_id=null בנפרד, כדי שלא "ייעלם" מהתצוגה.
router.get('/inventory/shortages-by-supplier', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const days = Number(req.query.days) > 0 ? Number(req.query.days) : 1;
  const rows = db.prepare(`
    SELECT oic.item_code, oic.item_name, oic.quantity, oic.qty_picked, oic.pick_status
    FROM order_items_cache oic
    JOIN orders_cache oc ON oc.order_key = oic.order_key
    WHERE oic.pick_status IN ('missing', 'partial')
      AND oic.pick_marked_at >= datetime('now', ?)
  `).all(`-${days} days`);

  const supplierByItem = new Map(
    db.prepare('SELECT item_code, supplier_id, supplier_name FROM item_suppliers').all()
      .map((s) => [s.item_code, s])
  );

  const bySupplier = new Map(); // key: supplier_id ?? 'unknown'
  for (const r of rows) {
    const missingQty = r.pick_status === 'missing' ? r.quantity : Math.max(0, (r.quantity || 0) - (r.qty_picked || 0));
    if (missingQty <= 0) continue;
    const supplier = supplierByItem.get(r.item_code);
    const key = supplier?.supplier_id ?? 'unknown';
    if (!bySupplier.has(key)) {
      bySupplier.set(key, {
        supplier_id: supplier?.supplier_id ?? null, supplier_name: supplier?.supplier_name ?? 'ספק לא ידוע',
        items: new Map(),
      });
    }
    const group = bySupplier.get(key);
    if (!group.items.has(r.item_code)) {
      group.items.set(r.item_code, { item_code: r.item_code, item_name: r.item_name, total_missing: 0 });
    }
    group.items.get(r.item_code).total_missing += missingQty;
  }

  const suppliers = Array.from(bySupplier.values())
    .map((g) => ({ ...g, items: Array.from(g.items.values()).sort((a, b) => b.total_missing - a.total_missing) }))
    .sort((a, b) => (a.supplier_name || '').localeCompare(b.supplier_name || '', 'he'));
  res.json({ suppliers, days });
});

// ---------- לשונית "משלוחים": כל מה שכבר נמסר בפועל ל-UPS, עם סטטוס עדכני ----------
// לא כולל הזמנות באיסוף עצמי (delivery_method='self_pickup') — אלו לא עוברות ב-UPS כלל.
router.get('/shipments', requireRole('agent', 'warehouse', 'warehouse_manager', 'system_admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT track_no, status, status_desc_heb, exception_code, exception_desc_heb,
           estimate_delivery, delivered_time, received_by, rts_track_no, updated_at
    FROM shipments
    ORDER BY updated_at DESC
    LIMIT 300
  `).all();
  const orderStmt = db.prepare(`
    SELECT oc.order_key, oc.order_num, oc.customer_name
    FROM order_shipments os JOIN orders_cache oc ON oc.order_key = os.order_key
    WHERE os.track_no = ?
  `);
  const result = rows.map((r) => ({ ...r, orders: orderStmt.all(r.track_no) }));
  res.json({ shipments: result });
});

// הזמנות status_ID=0 ("ללא סטטוס" — עדיין אצל המזכירה, לא בתור הליקוט).
// תצוגה בלבד: מנהל מערכת, מנהל מחסן, וסוכנים (לדעת מה מגיע בהמשך) — לא צוות
// המחסן השוטף, שאין לו מה לעשות עם הזמנה שעוד לא הודפסה.
router.get('/pending-orders', requireRole('agent', 'warehouse_manager', 'system_admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT order_key, order_num, customer_name, order_date, sigma_created_at, total_amount, sigma_agent_name AS agent_name
    FROM pending_orders_cache
    ORDER BY COALESCE(sigma_created_at, order_date) ASC
  `).all();
  res.json({ orders: rows });
});

// ---------- מצב חיבורים (סעיף 3.5 "מצב שירותים") ----------
router.get('/admin/integrations-status', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const { sigma, ups: upsCfg2 } = require('./config');
  const lastSigma = db.prepare(`SELECT * FROM sync_runs WHERE source = 'sigma' ORDER BY created_at DESC LIMIT 1`).get();
  const lastUps = db.prepare(`SELECT * FROM sync_runs WHERE source = 'ups' ORDER BY created_at DESC LIMIT 1`).get();
  const failedRuns24h = db.prepare(`SELECT COUNT(*) c FROM sync_runs WHERE ok = 0 AND created_at >= datetime('now', '-1 day')`).get().c;
  res.json({
    sigma: {
      bridgeConfigured: !!sigma.bridgeSecret,
      pullModeEnabled: sigma.enabled,
      lastRun: lastSigma || null,
    },
    ups: {
      webhookAuthEnabled: !!upsCfg2.webhookBearerSecret,
      reconcileEnabled: upsCfg2.reconcileEnabled,
      lastReconcile: lastUps || null,
    },
    failedRuns24h,
  });
});

// ---------- WooCommerce (אתר המכירות) — ר' ייעוץ 16.9.2026 ----------
// ניהול פרטי החיבור: system_admin בלבד (בקשה מפורשת של דניאל — לא warehouse_manager).
const woocommerce = require('./woocommerce');

router.get('/admin/woocommerce-settings', requireRole('system_admin'), (req, res) => {
  res.json(woocommerce.getMaskedSettings());
});

router.post('/admin/woocommerce-settings', requireRole('system_admin'), (req, res) => {
  const { storeUrl, consumerKey, consumerSecret } = req.body || {};
  res.json(woocommerce.saveSettings({ storeUrl, consumerKey, consumerSecret }));
});

router.post('/admin/woocommerce-settings/test', requireRole('system_admin'), async (req, res) => {
  const result = await woocommerce.testConnection();
  res.json(result);
});

// שליפת סטטוס מוצר לפי SKU — קריאה בלבד, למנהל מחסן (מסך חוסרי מלאי).
router.get('/woocommerce/product-status', requireRole('warehouse_manager', 'system_admin'), async (req, res) => {
  const { sku } = req.query;
  if (!sku) return res.status(400).json({ error: 'חסר sku' });
  try {
    const result = await woocommerce.getProductStatusBySku(String(sku));
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// שער Sigma (סעיף 17.1): בדיקת קריאת הזמנה בודדת אמיתית, לצורך אימות לפני פיתוח מלא
router.post('/admin/sigma-test/:companyId/:sidra/:num', requireRole('system_admin', 'warehouse_manager'), async (req, res) => {
  try {
    const { sigma: sigmaCfg } = require('./config');
    if (!sigmaCfg.enabled) return res.status(400).json({ error: 'Sigma לא מוגדר ב-.env' });
    const realSigma = require('./realSigmaBridge');
    const result = await realSigma.fetchOrderByKey(Number(req.params.companyId), Number(req.params.sidra), Number(req.params.num));
    if (!result) return res.status(404).json({ error: 'הזמנה לא נמצאה ב-Sigma' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- ניהול משתמשים (מנהל בלבד) ----------
// MOCK: סיסמאות טקסט-גלוי בהתאם לשאר המערכת (ר' seed.js/auth.js) — לא לפרודקשן אמיתי.
const VALID_ROLES = ['agent', 'warehouse', 'warehouse_manager', 'system_admin'];

router.get('/users', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const rows = db.prepare(`SELECT user_id, username, display_name, role, is_active, sigma_agent_id, created_at FROM users ORDER BY created_at ASC`).all();
  res.json({ users: rows });
});

router.post('/users', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const { username, display_name, password, role } = req.body || {};
  if (!username || !display_name || !password || !role) {
    return res.status(400).json({ error: 'חסרים שדות חובה (שם משתמש, שם, סיסמה, תפקיד)' });
  }
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'תפקיד לא תקין' });
  try {
    const user_id = `u_${crypto.randomBytes(6).toString('hex')}`;
    db.prepare(`INSERT INTO users (user_id, username, display_name, password, role) VALUES (?, ?, ?, ?, ?)`)
      .run(user_id, username, display_name, password, role);
    res.json({ ok: true, user: { user_id, username, display_name, role, is_active: 1 } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'שם המשתמש כבר תפוס' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM users WHERE user_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'משתמש לא נמצא' });

  const { display_name, password, role, is_active, sigma_agent_id } = req.body || {};
  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'תפקיד לא תקין' });

  try {
    db.prepare(`
      UPDATE users SET
        display_name = COALESCE(?, display_name),
        password = COALESCE(?, password),
        role = COALESCE(?, role),
        is_active = COALESCE(?, is_active),
        sigma_agent_id = CASE WHEN ? THEN ? ELSE sigma_agent_id END
      WHERE user_id = ?
    `).run(
      display_name || null, password || null, role || null,
      is_active === undefined ? null : (is_active ? 1 : 0),
      sigma_agent_id !== undefined ? 1 : 0, sigma_agent_id === '' ? null : (sigma_agent_id ?? null),
      id
    );
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const updated = db.prepare(`SELECT user_id, username, display_name, role, is_active, sigma_agent_id, created_at FROM users WHERE user_id = ?`).get(id);
  res.json({ ok: true, user: updated });
});

// מחיקה אמיתית (לא רק השבתה) — לניקוי משתמשי הדמו הראשוניים. שומרים על לפחות
// מנהל מערכת פעיל אחד כדי לא לנעול את המערכת החוצה.
router.delete('/users/:id', requireRole('warehouse_manager', 'system_admin'), (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM users WHERE user_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'משתמש לא נמצא' });

  if (existing.role === 'system_admin') {
    const activeAdmins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'system_admin' AND is_active = 1`).get().c;
    if (activeAdmins <= 1) return res.status(400).json({ error: 'לא ניתן למחוק את מנהל המערכת האחרון' });
  }

  db.prepare('DELETE FROM users WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
