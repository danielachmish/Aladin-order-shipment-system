const express = require('express');
const { db } = require('./db');
const { login, authMiddleware, requireRole } = require('./auth');
const wf = require('./workflow');
const { queueForStatus, positionInQueue } = require('./queue');
const urgent = require('./urgentRequests');
const ups = require('./upsWebhook');
const { emitChange } = require('./bus');

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
// MOCK: אין אימות Bearer אמיתי מול UPS בסביבה הזו (אין credentials). ר' upsWebhook.js.
// ממוקם לפני authMiddleware בכוונה: UPS קורא לנתיב הזה בלי טוקן JWT פנימי שלנו.
router.post('/webhooks/ups', express.json(), (req, res) => {
  try {
    const result = ups.handleWebhook(req.body);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
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
           ws.version, ws.hold_reason, ws.pre_wait_status, ws.updated_at AS wf_updated_at,
           u.display_name AS agent_name, cu.display_name AS claimed_by_name
    FROM orders_cache oc
    JOIN workflow_state ws ON ws.order_key = oc.order_key
    LEFT JOIN users u ON u.user_id = ws.agent_id
    LEFT JOIN users cu ON cu.user_id = ws.claimed_by
    WHERE oc.order_key = ?
  `).get(order_key);
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
           ws.status, ws.priority, ws.agent_id, ws.claimed_by, ws.queue_entered_at, ws.version,
           u.display_name AS agent_name, cu.display_name AS claimed_by_name
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
  if (req.user.role === 'agent' && scope === 'own') {
    sql += ` AND ws.agent_id = ?`;
    params.push(req.user.id);
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

  if (req.user.role === 'agent' && order.agent_id !== req.user.id) {
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

router.post('/orders/:key/close', requireRole('warehouse', 'warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.closeOrder(key, req.user.id)));

router.post('/orders/:key/issue', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.reportIssue(key, req.user.id, req.body?.reason || 'לא צוינה סיבה')));

router.post('/orders/:key/release-hold', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.releaseHold(key, req.user.id, req.body?.note)));

router.post('/orders/:key/cancel', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.cancelOrder(key, req.user.id, req.body?.note)));

router.post('/orders/:key/request-wait', requireRole('warehouse', 'warehouse_manager'),
  handleWorkflowAction((key, req) => wf.requestWait(key, req.user.id)));

router.post('/orders/:key/received-answer', requireRole('warehouse', 'warehouse_manager', 'agent', 'system_admin'),
  handleWorkflowAction((key, req) => {
    const order = baseOrderRow(key);
    if (req.user.role === 'agent' && order.agent_id !== req.user.id) {
      const err = new Error('רק הסוכן המשויך להזמנה יכול לעדכן תשובה');
      err.status = 403;
      throw err;
    }
    return wf.receivedAnswer(key, req.user.id);
  }));

router.post('/orders/:key/priority', requireRole('warehouse_manager', 'system_admin'),
  handleWorkflowAction((key, req) => wf.setPriority(key, req.body?.priority, req.user.id)));

// ---------- בקשות דחיפות ----------
router.post('/orders/:key/urgent-request', requireRole('agent'), (req, res) => {
  const key = decodeURIComponent(req.params.key);
  try {
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

module.exports = router;
