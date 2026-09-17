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

// סדר השלבים הפיזיים של הזמנה (ליקוט -> בדיקה -> אריזה -> משלוח -> סגירה).
// משמש רק לאכיפת קישור הזמנות (ר' assertLinkedGroupReady) — לא לשום דבר אחר.
const STATUS_INDEX = {
  open: 0, waiting_pick: 1, picking: 2, ready_for_check: 3,
  ready_to_pack: 4, waiting_pickup: 5, delivered_to_ups: 6, closed: 7,
};

// הזמנות מקושרות (linked_group_id) אמורות להיארז ולהישלח יחד, לא רק לשבת
// זו ליד זו בתור (ר' linkOrders למטה). לפני שהזמנה "בורחת קדימה" משלב האריזה
// ואילך (pack-done / deliver-ups / self-pickup / close), בודקים שאף אחות
// בקבוצה לא נשארה מאחור בשלב שהיא נמצאת בו כרגע — אם כן, חוסמים עם שגיאה
// ברורה שמפנה את המחסן להזמנה שעדיין לא הגיעה. הזמנה מבוטלת בקבוצה לא חוסמת
// יותר (היא לא תתקדם לעולם). לא חוסמים שלבי ליקוט/בדיקה מוקדמים יותר —
// שם קצב עצמאי בין ההזמנות סביר (ר' בקשת דניאל, ייעוץ 16.9.2026).
function assertLinkedGroupReady(state) {
  if (!state.linked_group_id) return;
  const myIndex = STATUS_INDEX[state.status];
  if (myIndex == null) return;
  const siblings = db.prepare(`
    SELECT ws.status, oc.order_num
    FROM workflow_state ws JOIN orders_cache oc ON oc.order_key = ws.order_key
    WHERE ws.linked_group_id = ? AND ws.order_key != ?
  `).all(state.linked_group_id, state.order_key);
  for (const sib of siblings) {
    if (sib.status === 'cancelled') continue;
    const sibIndex = STATUS_INDEX[sib.status];
    if (sibIndex == null || sibIndex < myIndex) {
      throw new RuleError(`לא ניתן להמשיך — הזמנה מקושרת #${sib.order_num} עדיין לא הגיעה לאותו שלב (עדיין ב"${sib.status}")`);
    }
  }
}

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
    UPDATE order_items_cache SET qty_picked = ?, pick_status = ?, pick_note = ?, pick_marked_at = datetime('now'), auto_missing = 0
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

// תיקון בודק (בקשת דניאל 14.9.2026): הבודק גילה שהמלקט טעה (למשל סימן "נלקט
// הכל" אבל בפועל חלק חסר, או להפך — סימן "חסר" אבל בעצם כן נמצא) — הבודק
// יכול לשנות בעצמו את pick_status/qty_picked של השורה, לא רק לאשר/לדחות.
// שומרים את הערת המלקט המקורית (pick_note) בלי לגעת בה, וכותבים את הסבר
// הבודק ל-check_note בנפרד — כדי שתישאר שקיפות מלאה מה כל אחד אמר. תיקון
// כזה מסמן את השורה כמאושרת (checked=1) — הבודק כבר ראה/קבע אותה בעצמו.
function correctPickedItem(orderKey, lineNo, userId, { qtyPicked, pickStatus, checkNote }) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'ready_for_check') throw new RuleError('ניתן לתקן שורה רק בשלב הבדיקה');
  if (!['picked', 'partial', 'missing'].includes(pickStatus)) throw new RuleError('סטטוס ליקוט לא תקין');
  const item = db.prepare('SELECT 1 FROM order_items_cache WHERE order_key = ? AND line_no = ?').get(orderKey, lineNo);
  if (!item) throw new RuleError('שורת פריט לא נמצאה');

  db.prepare(`
    UPDATE order_items_cache
    SET qty_picked = ?, pick_status = ?, checked = 1, check_note = ?, pick_marked_at = datetime('now'), auto_missing = 0
    WHERE order_key = ? AND line_no = ?
  `).run(pickStatus === 'missing' ? 0 : qtyPicked, pickStatus, checkNote || null, orderKey, lineNo);

  emitChange('order', { order_key: orderKey, status: state.status, version: state.version });
  return db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = ?').get(orderKey, lineNo);
}

// שידור "חסר מאומת" (ר' ייעוץ 17.9.2026, נושא 4) לכל שאר ההזמנות הפתוחות עם
// אותו item_code שעוד לא לוקטו (pick_status IS NULL), כדי שהמלקטת תדלג עליהן
// (יש כפתור תיקון קיים ב-UI אם בכל זאת נמצא). "מאומת" = השורה שרדה כ-missing
// עד סוף שלב הבדיקה — הבודק כבר קיבל הזדמנות לתקן ולא תיקן.
function propagateConfirmedShortages(orderKey, userId) {
  const missingItems = db.prepare(`
    SELECT DISTINCT item_code FROM order_items_cache WHERE order_key = ? AND pick_status = 'missing' AND item_code IS NOT NULL
  `).all(orderKey);
  if (missingItems.length === 0) return;

  const tx = db.transaction(() => {
    for (const { item_code } of missingItems) {
      db.prepare(`
        INSERT INTO item_shortage_status (item_code, marked_by, marked_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(item_code) DO UPDATE SET marked_by = excluded.marked_by, marked_at = datetime('now')
      `).run(item_code, userId);

      const affected = db.prepare(`
        SELECT order_key, line_no FROM order_items_cache
        WHERE item_code = ? AND order_key != ? AND pick_status IS NULL
      `).all(item_code, orderKey);
      for (const row of affected) {
        db.prepare(`
          UPDATE order_items_cache
          SET pick_status = 'missing', qty_picked = 0, auto_missing = 1, pick_marked_at = datetime('now')
          WHERE order_key = ? AND line_no = ?
        `).run(row.order_key, row.line_no);
        emitChange('order', { order_key: row.order_key });
      }
    }
  });
  tx();

  // סגירת המוצרים באתר המכירות (WooCommerce) — רק אחרי שהבודק אישר סופית
  // (ר' ייעוץ 17.9.2026). "ירי ושכח": לא מחכים לרשת ולא חוסמים את finishCheck
  // אם WooCommerce איטי/למטה — רק מעדכנים woocommerce_status/detail כשמסתיים.
  const woocommerce = require('./woocommerce');
  for (const { item_code } of missingItems) {
    woocommerce.closeProductBySku(item_code)
      .then((result) => {
        const status = result.closed ? 'closed' : 'skipped';
        db.prepare(`UPDATE item_shortage_status SET woocommerce_status = ?, woocommerce_detail = ? WHERE item_code = ?`)
          .run(status, result.reason || null, item_code);
      })
      .catch((e) => {
        db.prepare(`UPDATE item_shortage_status SET woocommerce_status = 'error', woocommerce_detail = ? WHERE item_code = ?`)
          .run(e.message, item_code);
      });
  }
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

  const updated = writeTransition(orderKey, userId, 'ready_to_pack', {}, 'אישור בדיקה — מוכן לאריזה');
  propagateConfirmedShortages(orderKey, userId);
  return updated;
}

// מסך "מוצרים שחזרו למלאי" (מנהל מחסן) — מנקה את הסימון האוטומטי מכל
// ההזמנות שעדיין לא לוקטו (לא נוגע בשורות שהמלקט כבר טיפל בהן בעצמו).
function listShortedItems() {
  const rows = db.prepare(`SELECT * FROM item_shortage_status ORDER BY marked_at DESC`).all();
  return rows.map((r) => {
    const sample = db.prepare(`SELECT item_name FROM order_items_cache WHERE item_code = ? AND item_name IS NOT NULL LIMIT 1`).get(r.item_code);
    const affectedCount = db.prepare(`
      SELECT COUNT(*) c FROM order_items_cache
      WHERE item_code = ? AND auto_missing = 1 AND pick_status = 'missing'
    `).get(r.item_code).c;
    return {
      item_code: r.item_code, item_name: sample ? sample.item_name : null,
      marked_by: r.marked_by, marked_at: r.marked_at, affected_orders: affectedCount,
      woocommerce_status: r.woocommerce_status, woocommerce_detail: r.woocommerce_detail,
    };
  });
}

function clearShortedItem(itemCode) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM item_shortage_status WHERE item_code = ?').run(itemCode);
    const rows = db.prepare(`
      SELECT order_key, line_no FROM order_items_cache
      WHERE item_code = ? AND auto_missing = 1 AND pick_status = 'missing'
    `).all(itemCode);
    for (const row of rows) {
      db.prepare(`
        UPDATE order_items_cache
        SET pick_status = NULL, qty_picked = NULL, auto_missing = 0, pick_marked_at = NULL
        WHERE order_key = ? AND line_no = ?
      `).run(row.order_key, row.line_no);
      emitChange('order', { order_key: row.order_key });
    }
  });
  tx();
  return { cleared: itemCode };
}

// packageCount/palletCount: כמה חבילות/משטחים יצאו בפועל מההזמנה (בקשת
// דניאל 17.9.2026) — כדי שהמזכירה תדע במסך היסטוריה כמה שטרי מטען UPS
// להפיק, בלי לנחש/לספור מחדש. שניהם אופציונליים ויכולים להתקיים יחד
// (למשל גם חבילות וגם משטח מאותה הזמנה).
function packDone(orderKey, userId, expectedVersion, packageCount, palletCount) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'ready_to_pack') throw new RuleError('ההזמנה אינה מוכנה לאריזה');
  assertVersion(state, expectedVersion);
  assertLinkedGroupReady(state);
  const extra = {
    package_count: packageCount != null ? Number(packageCount) : null,
    pallet_count: palletCount != null ? Number(palletCount) : null,
  };
  return writeTransition(orderKey, userId, 'waiting_pickup', extra, 'סיום אריזה');
}

function deliverToUps(orderKey, userId, expectedVersion) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'waiting_pickup') throw new RuleError('ההזמנה אינה ממתינה לאיסוף');
  assertVersion(state, expectedVersion);
  assertLinkedGroupReady(state);
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
  assertLinkedGroupReady(state);
  return writeTransition(orderKey, userId, 'closed', { delivery_method: 'self_pickup' }, 'איסוף עצמי על ידי הלקוח');
}

function closeOrder(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  if (state.status !== 'delivered_to_ups') throw new RuleError('ניתן לסגור רק לאחר מסירה ל UPS');
  if (state.pending_addition_note) {
    throw new RuleError(`לא ניתן לסגור — ממתינה תוספת: ${state.pending_addition_note}`);
  }
  assertLinkedGroupReady(state);
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

const COD_TYPES = ['none', 'full', 'custom', 'full_plus_extra'];
const DELIVERY_PLAN_TYPES = ['ups', 'self_pickup'];

// הגדרות הזמנה שהמנהל קובע מוקדם, לא רק כשהיא מגיעה להיסטוריה (ר' ייעוץ
// 17.9.2026): גוביינא (שיק דחוי), אופן משלוח מתוכנן (כוונה בלבד — נפרד
// מ-delivery_method שנקבע בפועל ע"י המחסן בזמן אמת), הערה חופשית, ועדיפות.
//
// גוביינא/משלוח מתוכנן/הערה משתכפלים אוטומטית על כל הזמנות הקבוצה המקושרת
// (משלוח פיזי אחד = אותה החלטה לכולן). עדיפות חלה רק על ההזמנה הנוכחית —
// היא משפיעה על סדר בתור, לא על מה שיוצא באותו משלוח.
//
// כל שדה שלא נשלח (undefined) נשאר ללא שינוי — כך ש-/orders/:key/cod הישן
// יכול להמשיך לשלוח רק codType/amount/dueDate בלי לגעת בשאר.
function updateOrderSettings(orderKey, userId, { codType, amount, dueDate, plannedDeliveryMethod, specialInstructions, priority } = {}) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');

  if (codType !== undefined) {
    if (!COD_TYPES.includes(codType)) throw new RuleError('סוג גוביינא לא תקין');
    if ((codType === 'custom' || codType === 'full_plus_extra') && (amount == null || Number(amount) <= 0)) {
      throw new RuleError('יש להזין סכום');
    }
    if (codType !== 'none' && !dueDate) throw new RuleError('יש להזין תאריך פירעון');
  }
  if (plannedDeliveryMethod !== undefined && plannedDeliveryMethod && !DELIVERY_PLAN_TYPES.includes(plannedDeliveryMethod)) {
    throw new RuleError('אופן משלוח מתוכנן לא תקין');
  }
  if (priority !== undefined && !['normal', 'urgent', 'next'].includes(priority)) {
    throw new RuleError('עדיפות לא תקינה');
  }

  const groupKeys = state.linked_group_id
    ? db.prepare('SELECT order_key FROM workflow_state WHERE linked_group_id = ?').all(state.linked_group_id).map((r) => r.order_key)
    : [orderKey];

  const tx = db.transaction(() => {
    for (const key of groupKeys) {
      const s = getState(key);
      const sets = ['version = version + 1', "updated_at = datetime('now')"];
      const params = { key };
      if (codType !== undefined) {
        sets.push('cod_type = @cod_type', 'cod_amount = @cod_amount', 'cod_due_date = @cod_due_date', 'cod_set_by = @cod_set_by', "cod_set_at = datetime('now')");
        params.cod_type = codType;
        params.cod_amount = codType === 'none' ? null : (amount != null ? Number(amount) : null);
        params.cod_due_date = codType === 'none' ? null : dueDate;
        params.cod_set_by = userId;
      }
      if (plannedDeliveryMethod !== undefined) {
        sets.push('planned_delivery_method = @planned_delivery_method');
        params.planned_delivery_method = plannedDeliveryMethod || null;
      }
      if (specialInstructions !== undefined) {
        sets.push('special_instructions = @special_instructions');
        params.special_instructions = specialInstructions || null;
      }
      if (priority !== undefined && key === orderKey) {
        sets.push('priority = @priority');
        params.priority = priority;
      }
      db.prepare(`UPDATE workflow_state SET ${sets.join(', ')} WHERE order_key = @key`).run(params);
      db.prepare(`
        INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uid('evt'), key, userId, s.status, s.status, 'הגדרות הזמנה עודכנו');
    }
  });
  tx();

  for (const key of groupKeys) {
    const updated = getState(key);
    emitChange('order', { order_key: key, status: updated.status, version: updated.version });
  }
  return getState(orderKey);
}

// מחשב את סכום הגוביינא בפועל להצגה: full/full_plus_extra מסתכמים על כל
// ההזמנות בקבוצה המקושרת (משלוח פיזי אחד), לא רק ההזמנה הבודדת.
function computeCodDisplay(orderKey) {
  const state = getState(orderKey);
  if (!state || state.cod_type === 'none') return 0;
  if (state.cod_type === 'custom') return state.cod_amount || 0;

  const totalRow = state.linked_group_id
    ? db.prepare(`
        SELECT SUM(oc.total_amount) AS total FROM orders_cache oc
        JOIN workflow_state ws ON ws.order_key = oc.order_key
        WHERE ws.linked_group_id = ?
      `).get(state.linked_group_id)
    : db.prepare('SELECT total_amount AS total FROM orders_cache WHERE order_key = ?').get(orderKey);
  const groupTotal = totalRow?.total || 0;
  return state.cod_type === 'full_plus_extra' ? groupTotal + (state.cod_amount || 0) : groupTotal;
}

// דוח חוסרים למזכירה (בקשת דניאל 14.9.2026): מזכירה (יוזר warehouse_manager)
// מסמנת ברמת ההזמנה כולה שהוציאה חשבונית מתוקנת על כל החוסרים בה. עצמאי
// לגמרי מסטטוס העבודה של ההזמנה (אפשר לסמן גם על הזמנה סגורה).
function markShortageInvoiced(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE workflow_state
      SET shortage_invoiced_at = datetime('now'), shortage_invoiced_by = ?, version = version + 1, updated_at = datetime('now')
      WHERE order_key = ?
    `).run(userId, orderKey);
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), orderKey, userId, state.status, state.status, 'סומן כטופל — הופקה חשבונית מתוקנת על החוסרים');
  });
  tx();
  const updated = getState(orderKey);
  emitChange('order', { order_key: orderKey, status: updated.status, version: updated.version });
  return updated;
}

function unmarkShortageInvoiced(orderKey, userId) {
  const state = getState(orderKey);
  if (!state) throw new RuleError('הזמנה לא נמצאה');
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE workflow_state
      SET shortage_invoiced_at = NULL, shortage_invoiced_by = NULL, version = version + 1, updated_at = datetime('now')
      WHERE order_key = ?
    `).run(orderKey);
    db.prepare(`
      INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uid('evt'), orderKey, userId, state.status, state.status, 'בוטל סימון "טופל" על החוסרים');
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
  updateItemPick, updateItemCheck, finishCheck, correctPickedItem,
  markShortageInvoiced, unmarkShortageInvoiced,
  linkOrders, unlinkOrder,
  updateOrderSettings, computeCodDisplay,
  listShortedItems, clearShortedItem,
};
