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

// ---------- Auth ----------
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  res.json(result);
});

router.get('/health', (req, res) => {
  const orders = db.prepare('SELECT COUNT(*) c FROM orders_cache').get().c;
  res.json({ ok: true, orders, ts: Date.now() });
});

// ---------- UPS Webhook ----------
// ממוקם לפני authMiddleware בכוונה: UPS קורא לנתיב הזה בלי טוקן JWT פנימי שלנו.
// אימות: אם UPS_WEBHOOK_BEARER_SECRET מוגדר ב-.env, נדרש Authorization: Bearer <secret>
// תמיד מעל HTTPS (סעיף 9.2, 13). כל עוד לא מוגדר — מתקבל בלי אימות (מצב פיתוח בלבד,
// מתועד גם ב-.env.example).
router.post('/webhooks/ups', express.json(), (req, res) => {
  if (upsCfg.webhookBearerSecret) {
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
           ws.version, ws.hold_reason, ws.pre_wait_status, ws.pending_addition_note, ws.delivery_method, ws.updated_at AS wf_updated_at,
           COALESCE(u.display_name, oc.sigma_agent_name) AS agent_name, cu.display_name AS claimed_by_name
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
  return (s || '').trim().replace(/\s+/g, ' ');
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
    SELECT oc.order_key, oc.order_num, oc.customer_name, oc.total_amount, oc.line_count, oc.notes,
           ws.status, ws.priority, ws.agent_id, ws.claimed_by, ws.queue_entered_at, ws.version, ws.pending_addition_note,
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

  // הוספת מיקום בתור להזמנות שבתור ממתינה לליקוט
  rows = rows.map((r) => {
    if (r.status === 'waiting_pick') {
      const pos = positionInQueue(r.order_key, 'waiting_pick');
      return { ...r, queue_position: pos };
    }
    return r;
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

  res.json({ order, items, events, shipments, urgent_requests: urgentReqs, queue_position: queuePos });
});

function handleWorkflowAction(fn) {
  return (req, res) => {
    const key = decodeURIComponent(req.params.key);
    try {
      const result = fn(key, req);
      res.json({ ok: true, state: result });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, current: e.current });
    }
  };
}

router.post('/orders/:key/claim', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.claimOrder(key, req.user.id, req.body?.expectedVersion)));

router.post('/orders/:key/finish-picking', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.finishPicking(key, req.user.id, req.body?.expectedVersion)));

router.post('/orders/:key/pack-done', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.packDone(key, req.user.id, req.body?.expectedVersion)));

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
      return res.status(403).json({ error: 'ניתן לבקש דחיפות רק להזמנות שלך' });
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
    SELECT oc.order_key, oc.order_num, oc.customer_name, oc.total_amount,
           ws.status, ws.priority, ws.updated_at
    FROM orders_cache oc
    JOIN workflow_state ws ON ws.order_key = oc.order_key
    WHERE ws.status IN ('ready_to_pack','waiting_pickup','delivered_to_ups','closed')
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

  const result = orders.map((o) => {
    const start = pickStartStmt.get(o.order_key);
    const end = pickEndStmt.get(o.order_key);
    const issues = issuesStmt.all(o.order_key);
    return {
      ...o,
      pick_started_at: start ? start.created_at : null,
      picked_by: start && start.user_id ? (userStmt.get(start.user_id) || {}).display_name : null,
      pick_finished_at: end ? end.created_at : null,
      issues,
    };
  });

  res.json({ orders: result, sinceDays });
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
  const rows = db.prepare(`SELECT user_id, username, display_name, role, is_active, created_at FROM users ORDER BY created_at ASC`).all();
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

  const { display_name, password, role, is_active } = req.body || {};
  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'תפקיד לא תקין' });

  db.prepare(`
    UPDATE users SET
      display_name = COALESCE(?, display_name),
      password = COALESCE(?, password),
      role = COALESCE(?, role),
      is_active = COALESCE(?, is_active)
    WHERE user_id = ?
  `).run(display_name || null, password || null, role || null, is_active === undefined ? null : (is_active ? 1 : 0), id);

  const updated = db.prepare(`SELECT user_id, username, display_name, role, is_active, created_at FROM users WHERE user_id = ?`).get(id);
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
