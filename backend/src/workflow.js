// מנוע הסטטוסים המרכזי — ר' סעיף 4 באפיון.
// כל שינוי מצב: (1) בודק גרסה (optimistic concurrency, סעיף 4.3),
// (2) כותב ל-workflow_state ול-workflow_events באותה טרנזקציה (סעיף 10.1),
// (3) משדר אירוע Realtime.
const crypto = require('crypto');
const { db } = require('./db');
const { emitChange } = require('./bus');

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

class ConflictError extends Error {
  constructor(current) {
    super('הנתון השתנה בינתיים, טענו מחדש');
    this.status = 409;
    this.current = current;
  }
}
class RuleError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const ACTIVE_STATUSES = ['open', 'waiting_pick', 'picking', 'ready_to_pack', 'waiting_pickup', 'delivered_to_ups'];

function getState(orderKey) {
  return db.prepare('SELECT * FROM workflow_state WHERE order_key = ?').get(orderKey);
}

function assertVersion(state, expectedVersion) {
  if (expectedVersion != null && Number(expectedVersion) !== state.version) {
    throw new ConflictError(state);
  }
}

function writeTransition(orderKey, userId, toStatus, extraFields, note) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  const fromStatus = state.status;

  const setParts = ['status = @status', 'version = version + 1', "updated_at = datetime('now')"];
  const params = { key: orderKey, status: toStatus };
  for (const [k, v] of Object.entries(extraFields || {})) {
    setParts.push(`${k} = @${k}`);
    params[k] = v;
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE workflow_state SET ${setParts.join(', ')} WHERE order_key = @key`).run(params);
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), orderKey, userId || null, fromStatus, toStatus, note || null);
  });
  tx();

  const updated = getState(orderKey);
  emitChange('order', { order_key: orderKey, status: updated.status, version: updated.version });
  return updated;
}

// ----- מעברי הליבה (סעיף 4.1) -----

function claimOrder(orderKey, userId, expectedVersion) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'waiting_pick') {
    if (state.status === 'picking') {
      throw new RuleError(`ההזמנה כבר בליקוט` + (state.claimed_by ? ` על ידי משתמש אחר` : ''));
    }
    throw new RuleError('לא ניתן להתחיל ליקוט ממצב זה');
  }
  assertVersion(state, expectedVersion);
  return writeTransition(orderKey, userId, 'picking', { claimed_by: userId }, 'התחלת ליקוט');
}

function finishPicking(orderKey, userId, expectedVersion) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'picking') throw new RuleError('ההזמנה אינה בליקוט');
  assertVersion(state, expectedVersion);
  return writeTransition(orderKey, userId, 'ready_to_pack', {}, 'סיום ליקוט');
}

function packDone(orderKey, userId, expectedVersion) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'ready_to_pack') throw new RuleError('ההזמנה אינה מוכנה לאריזה');
  assertVersion(state, expectedVersion);
  return writeTransition(orderKey, userId, 'waiting_pickup', {}, 'סיום אריזה');
}

function deliverToUps(orderKey, userId, expectedVersion) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'waiting_pickup') throw new RuleError('ההזמנה אינה ממתינה לאיסוף');
  assertVersion(state, expectedVersion);
  return writeTransition(orderKey, userId, 'delivered_to_ups', {}, 'מסירה ל UPS');
}

function closeOrder(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'delivered_to_ups') throw new RuleError('ניתן לסגור רק לאחר מסירה ל UPS');
  return writeTransition(orderKey, userId, 'closed', {}, 'סגירה');
}

// מלקט מתקדם רק קדימה; החזרה/ביטול/שינוי בעלים — מנהל בלבד עם סיבה (סעיף 4.3)
function reportIssue(orderKey, userId, reason) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (!ACTIVE_STATUSES.includes(state.status)) throw new RuleError('לא ניתן לדווח בעיה במצב זה');
  return writeTransition(orderKey, userId, 'on_hold', { hold_reason: reason, pre_wait_status: state.status }, `בעיה: ${reason}`);
}

function releaseHold(orderKey, managerId, note) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'on_hold') throw new RuleError('ההזמנה אינה מעוכבת');
  const back = state.pre_wait_status || 'waiting_pick';
  return writeTransition(orderKey, managerId, back, {
    hold_reason: null,
    pre_wait_status: null,
    queue_entered_at: back === 'waiting_pick' ? new Date().toISOString() : state.queue_entered_at,
  }, note || 'שחרור חסימה על ידי מנהל');
}

function cancelOrder(orderKey, managerId, note) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  return writeTransition(orderKey, managerId, 'cancelled', {}, note || 'ביטול הזמנה על ידי מנהל');
}

// סטטוס ממתינה לתשובת לקוח/סוכן — זמין מכל שלב פעיל, בלי סיבה/הערה (הוחלט בשיחה מול דניאל)
function requestWait(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (!ACTIVE_STATUSES.includes(state.status)) throw new RuleError('לא ניתן לעצור לתשובה במצב זה');
  return writeTransition(orderKey, userId, 'waiting_answer', { pre_wait_status: state.status }, 'ממתינה לתשובת לקוח/סוכן');
}

function receivedAnswer(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'waiting_answer') throw new RuleError('ההזמנה אינה ממתינה לתשובה');
  const back = state.pre_wait_status || 'waiting_pick';
  return writeTransition(orderKey, userId, back, { pre_wait_status: null }, 'התקבלה תשובה');
}

// עדיפות: normal | urgent | next — מנהל בלבד (סעיף 5)
function setPriority(orderKey, priority, managerId) {
  if (!['normal', 'urgent', 'next'].includes(priority)) throw new RuleError('עדיפות לא תקינה');
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  const tx = db.transaction(() => {
    db.prepare("UPDATE workflow_state SET priority = ?, version = version + 1, updated_at = datetime('now') WHERE order_key = ?").run(priority, orderKey);
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), orderKey, managerId, state.status, state.status, `עדיפות שונתה ל-${priority}`);
  });
  tx();
  const updated = getState(orderKey);
  emitChange('order', { order_key: orderKey, status: updated.status, version: updated.version });
  return updated;
}

module.exports = {
  ConflictError, RuleError, ACTIVE_STATUSES,
  getState, claimOrder, finishPicking, packDone, deliverToUps, closeOrder,
  reportIssue, releaseHold, cancelOrder, requestWait, receivedAnswer, setPriority,
};
