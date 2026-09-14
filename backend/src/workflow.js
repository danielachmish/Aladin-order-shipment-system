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

const ACTIVE_STATUSES = ['open', 'waiting_pick', 'picking', 'ready_for_check', 'ready_to_pack', 'waiting_pickup', 'delivered_to_ups'];

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

// ליקוט לפי מיקום + בדיקה (QC) — ר' PICKING_QC_SPEC.md (סוכם עם דניאל 14.9.2026).
// כל שורת פריט מתעדכנת בנפרד תוך כדי ליקוט (updateItemPick); "סיום ליקוט" רק
// בודק שכל השורות טופלו ומעביר ל-ready_for_check (לא ישר לאריזה כמו קודם).
function updateItemPick(orderKey, lineNo, userId, { qtyPicked, pickStatus, pickNote }) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'picking') throw new RuleError('ניתן לעדכן ליקוט רק כשההזמנה בליקוט');
  if (!['picked', 'partial', 'missing'].includes(pickStatus)) throw new RuleError('סטטוס ליקוט לא תקין');
  const item = db.prepare('SELECT 1 FROM order_items_cache WHERE order_key = ? AND line_no = ?').get(orderKey, lineNo);
  if (!item) throw new RuleError('שורת פריט לא נמצאה');

  db.prepare(`
    UPDATE order_items_cache SET qty_picked = ?, pick_status = ?, pick_note = ?
    WHERE order_key = ? AND line_no = ?
  `).run(pickStatus === 'missing' ? 0 : qtyPicked, pickStatus, pickNote || null, orderKey, lineNo);

  emitChange('order', { order_key: orderKey, status: state.status, version: state.version });
  return db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = ?').get(orderKey, lineNo);
}

function finishPicking(orderKey, userId, expectedVersion) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'picking') throw new RuleError('ההזמנה אינה בליקוט');
  assertVersion(state, expectedVersion);

  const untouched = db.prepare(
    'SELECT COUNT(*) c FROM order_items_cache WHERE order_key = ? AND pick_status IS NULL'
  ).get(orderKey).c;
  if (untouched > 0) throw new RuleError(`יש ${untouched} שורות שעדיין לא סומנו`);

  return writeTransition(orderKey, userId, 'ready_for_check', {}, 'סיום ליקוט — ממתין לבדיקה');
}

// בדיקה (QC) — יכול לבצע אותו יוזר מחסן שליקט (login משותף בפועל, לא נאכף
// טכנית; ר' סעיף 2 באיפיון). שורה שסומנה 'missing' לא ניתנת לאישור (אין מה
// לבדוק בפריט שלא נמצא כלל).
function updateItemCheck(orderKey, lineNo, userId, { checked, checkNote }) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'ready_for_check') throw new RuleError('ניתן לעדכן בדיקה רק בשלב הבדיקה');
  const item = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = ?').get(orderKey, lineNo);
  if (!item) throw new RuleError('שורת פריט לא נמצאה');
  if (item.pick_status === 'missing') throw new RuleError('אין מה לבדוק בשורה שסומנה כחסרה');

  db.prepare(`
    UPDATE order_items_cache SET checked = ?, check_note = ?
    WHERE order_key = ? AND line_no = ?
  `).run(checked ? 1 : 0, checkNote || null, orderKey, lineNo);

  emitChange('order', { order_key: orderKey, status: state.status, version: state.version });
  return db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = ?').get(orderKey, lineNo);
}

function finishCheck(orderKey, userId, expectedVersion) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'ready_for_check') throw new RuleError('ההזמנה אינה בשלב בדיקה');
  assertVersion(state, expectedVersion);

  const unchecked = db.prepare(
    "SELECT COUNT(*) c FROM order_items_cache WHERE order_key = ? AND pick_status != 'missing' AND checked = 0"
  ).get(orderKey).c;
  if (unchecked > 0) throw new RuleError(`יש ${unchecked} שורות שעדיין לא אושרו בבדיקה`);

  return writeTransition(orderKey, userId, 'ready_to_pack', {}, 'אישור בדיקה — מוכן לאריזה');
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
  return writeTransition(orderKey, userId, 'delivered_to_ups', { delivery_method: 'ups' }, 'מסירה ל UPS');
}

// איסוף עצמי ע"י הלקוח — לא עובר דרך UPS בכלל, נסגר ישירות (עדיין בכפוף
// לבדיקת "תוספת בדרך", בדיוק כמו סגירה רגילה). ר' בקשת דניאל 14.9.2026.
function selfPickup(orderKey, userId, expectedVersion) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'waiting_pickup') throw new RuleError('ההזמנה אינה ממתינה לאיסוף');
  assertVersion(state, expectedVersion);
  if (state.pending_addition_note) {
    throw new RuleError(`לא ניתן לסגור — ממתינה תוספת: ${state.pending_addition_note}`);
  }
  return writeTransition(orderKey, userId, 'closed', { delivery_method: 'self_pickup' }, 'איסוף עצמי על ידי הלקוח');
}

function closeOrder(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'delivered_to_ups') throw new RuleError('ניתן לסגור רק לאחר מסירה ל UPS');
  if (state.pending_addition_note) {
    throw new RuleError(`לא ניתן לסגור — ממתינה תוספת: ${state.pending_addition_note}`);
  }
  return writeTransition(orderKey, userId, 'closed', {}, 'סגירה');
}

// "תוספת" בדרך (סוכן/מנהל) — לא משנה סטטוס, רק חוסם סגירה עד שהתוספת תסומן
// כהגיעה. ר' בקשת דניאל 14.9.2026: "שהמחסן לא יסגרו את ההזמנה עד שתגיע התוספת".
function requestAddition(orderKey, userId, note) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (!ACTIVE_STATUSES.includes(state.status)) throw new RuleError('לא ניתן לבקש תוספת במצב זה');
  const tx = db.transaction(() => {
    db.prepare("UPDATE workflow_state SET pending_addition_note = ?, version = version + 1, updated_at = datetime('now') WHERE order_key = ?")
      .run(note || 'תוספת בדרך', orderKey);
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), orderKey, userId, state.status, state.status, `בקשת תוספת: ${note || 'תוספת בדרך'}`);
  });
  tx();
  const updated = getState(orderKey);
  emitChange('order', { order_key: orderKey, status: updated.status, version: updated.version });
  return updated;
}

function additionReceived(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (!state.pending_addition_note) throw new RuleError('אין תוספת ממתינה בהזמנה זו');
  const tx = db.transaction(() => {
    db.prepare("UPDATE workflow_state SET pending_addition_note = NULL, version = version + 1, updated_at = datetime('now') WHERE order_key = ?")
      .run(orderKey);
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), orderKey, userId, state.status, state.status, 'התוספת הגיעה — ניתן לסגור');
  });
  tx();
  const updated = getState(orderKey);
  emitChange('order', { order_key: orderKey, status: updated.status, version: updated.version });
  return updated;
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

// הזמנות מקושרות — כשלקוח מוסיף פריטים בהזמנה נפרדת בסיגמא (יום אחרי, למשל),
// ההזמנה החדשה יורדת לסוף התור לפי הזמן שלה. קישור ידני "מצמיד" אותה למקום
// התור של ההזמנה הישנה (ר' PICKING_QC_SPEC.md / בקשת דניאל 14.9.2026). בכוונה
// לא אוטומטי לפי אותו לקוח — לקוח קבוע יכול לגמרי לשים כמה הזמנות לא-קשורות.
function linkOrders(orderKey, otherOrderNumOrKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');

  let otherKey = null;
  const exact = db.prepare('SELECT order_key FROM orders_cache WHERE order_key = ?').get(otherOrderNumOrKey);
  if (exact) {
    otherKey = exact.order_key;
  } else {
    const num = Number(otherOrderNumOrKey);
    const matches = db.prepare('SELECT order_key FROM orders_cache WHERE order_num = ?').all(num);
    if (matches.length === 0) throw new RuleError(`לא נמצאה הזמנה עם מספר ${otherOrderNumOrKey}`);
    if (matches.length > 1) throw new RuleError('נמצאו כמה הזמנות עם אותו מספר — יש לפנות למנהל');
    otherKey = matches[0].order_key;
  }

  if (otherKey === orderKey) throw new RuleError('לא ניתן לקשר הזמנה לעצמה');
  const otherState = getState(otherKey);
  if (!otherState) throw new RuleError('להזמנה השנייה אין עדיין מצב עבודה');

  if (state.linked_group_id && otherState.linked_group_id && state.linked_group_id !== otherState.linked_group_id) {
    throw new RuleError('שתי ההזמנות כבר משויכות לקבוצות קישור שונות — יש לבטל קישור קודם');
  }

  const groupId = state.linked_group_id || otherState.linked_group_id || uid('grp');
  const tx = db.transaction(() => {
    for (const [key, otherNum] of [[orderKey, otherState], [otherKey, state]]) {
      db.prepare("UPDATE workflow_state SET linked_group_id = ?, version = version + 1, updated_at = datetime('now') WHERE order_key = ?")
        .run(groupId, key);
    }
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), orderKey, userId, state.status, state.status, `קושרה להזמנה ${otherKey}`);
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), otherKey, userId, otherState.status, otherState.status, `קושרה להזמנה ${orderKey}`);
  });
  tx();

  emitChange('order', { order_key: orderKey });
  emitChange('order', { order_key: otherKey });
  return { linkedGroupId: groupId, otherKey };
}

function unlinkOrder(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (!state.linked_group_id) throw new RuleError('ההזמנה לא מקושרת');

  const tx = db.transaction(() => {
    db.prepare("UPDATE workflow_state SET linked_group_id = NULL, version = version + 1, updated_at = datetime('now') WHERE order_key = ?")
      .run(orderKey);
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), orderKey, userId, state.status, state.status, 'קישור לקבוצת הזמנות בוטל');
  });
  tx();

  emitChange('order', { order_key: orderKey });
  return getState(orderKey);
}

module.exports = {
  ConflictError, RuleError, ACTIVE_STATUSES,
  getState, claimOrder, finishPicking, packDone, deliverToUps, selfPickup, closeOrder,
  reportIssue, releaseHold, cancelOrder, requestWait, receivedAnswer, setPriority,
  requestAddition, additionReceived,
  updateItemPick, updateItemCheck, finishCheck,
  linkOrders, unlinkOrder,
};
