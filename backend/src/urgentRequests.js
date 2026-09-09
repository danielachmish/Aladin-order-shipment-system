// בקשת דחיפות מסוכן ואישור מנהל — סעיף 5.3 באפיון
const crypto = require('crypto');
const { db } = require('./db');
const { emitChange } = require('./bus');
const { RuleError, setPriority } = require('./workflow');

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function createRequest(orderKey, agentId) {
  const state = db.prepare('SELECT * FROM workflow_state WHERE order_key = ?').get(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.agent_id !== agentId) throw new RuleError('ניתן לבקש דחיפות רק להזמנות שלך');
  const pending = db.prepare(`SELECT 1 FROM urgent_requests WHERE order_key = ? AND status = 'pending'`).get(orderKey);
  if (pending) throw new RuleError('כבר קיימת בקשת דחיפות ממתינה להזמנה זו');

  const id = uid('req');
  db.prepare(`INSERT INTO urgent_requests (request_id, order_key, agent_id) VALUES (?, ?, ?)`).run(id, orderKey, agentId);
  emitChange('urgent_request', { request_id: id, order_key: orderKey, status: 'pending' });
  return db.prepare('SELECT * FROM urgent_requests WHERE request_id = ?').get(id);
}

function decideRequest(requestId, managerId, approve) {
  const reqRow = db.prepare('SELECT * FROM urgent_requests WHERE request_id = ?').get(requestId);
  if (!reqRow) throw new RuleError('בקשה לא נמצאה');
  if (reqRow.status !== 'pending') throw new RuleError('הבקשה כבר טופלה');

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE urgent_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE request_id = ?
    `).run(approve ? 'approved' : 'rejected', managerId, requestId);
    if (approve) {
      setPriority(reqRow.order_key, 'urgent', managerId);
    }
  });
  tx();

  emitChange('urgent_request', { request_id: requestId, order_key: reqRow.order_key, status: approve ? 'approved' : 'rejected' });
  return db.prepare('SELECT * FROM urgent_requests WHERE request_id = ?').get(requestId);
}

function listPending() {
  return db.prepare(`
    SELECT ur.*, oc.order_num, oc.customer_name, u.display_name AS agent_name
    FROM urgent_requests ur
    JOIN orders_cache oc ON oc.order_key = ur.order_key
    JOIN users u ON u.user_id = ur.agent_id
    WHERE ur.status = 'pending'
    ORDER BY ur.created_at ASC
  `).all();
}

function listForOrder(orderKey) {
  return db.prepare('SELECT * FROM urgent_requests WHERE order_key = ? ORDER BY created_at DESC').all(orderKey);
}

module.exports = { createRequest, decideRequest, listPending, listForOrder };
