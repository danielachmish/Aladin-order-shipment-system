// קליטת הזמנות שנדחפות (push) מה-Sigma Bridge המקומי — ר' bridge/sync.js.
// זה מחליף את realSigmaBridge.js (משיכה/pull) כארכיטקטורה בפועל: השרת של
// אלדין בענן אינו יכול לגשת ל-SQL Server הפיזי שנמצא ברשת המקומית
// (וגם לא צריך — בדיוק כפי שהאפיון ממליץ בסעיף 7: "סנכרון יוצא בלבד" מהרשת
// המקומית אל הענן, בלי לחשוף את ה-SQL Server לאינטרנט).
const crypto = require('crypto');
const { db } = require('./db');
const { emitChange } = require('./bus');
const { ACTIVE_STATUSES, SYNC_HOLD_REASON } = require('./workflow');

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function orderKey(companyId, sidra, num) {
  return `${companyId}|${sidra}|${num}`;
}

// order: { companyId, sidra, orderNum, customerName, orderDate, deliveryDate,
//          totalAmount, notes, sourceStatus, agentName, sigmaAgentId,
//          items: [{lineNo,itemCode,itemName,quantity,price,location,barcode}] }
function ingestOrders(orders) {
  const insertOrder = db.prepare(`
    INSERT INTO orders_cache (order_key, company_id, sidra, order_num, customer_name, order_date, delivery_date, total_amount, line_count, notes, source_status, sigma_agent_name, sigma_agent_id, sigma_created_at, synced_at)
    VALUES (@order_key, @company_id, @sidra, @order_num, @customer_name, @order_date, @delivery_date, @total_amount, @line_count, @notes, @source_status, @sigma_agent_name, @sigma_agent_id, @sigma_created_at, datetime('now'))
    ON CONFLICT(order_key) DO UPDATE SET
      customer_name = excluded.customer_name, order_date = excluded.order_date,
      delivery_date = excluded.delivery_date, total_amount = excluded.total_amount,
      line_count = excluded.line_count, notes = excluded.notes,
      source_status = excluded.source_status, sigma_agent_name = excluded.sigma_agent_name,
      sigma_agent_id = excluded.sigma_agent_id,
      sigma_created_at = excluded.sigma_created_at,
      synced_at = datetime('now')
  `);
  // מיפוי אמיתי סוכן->יוזר (ר' ייעוץ 17.9.2026, נושא 6) — מוגדר ע"י מנהל
  // ב-UserManagement (users.sigma_agent_id). מוחלף על פני התאמת שם שברירית.
  const findAgentUser = db.prepare('SELECT user_id FROM users WHERE sigma_agent_id = ?');
  // תיקון קריטי (14.9.2026): "INSERT OR REPLACE" היה מוחק בכל סבב סנכרון (כל
  // 45 שניות) את כל התקדמות הליקוט/בדיקה של השורה (qty_picked, pick_status,
  // checked, check_note) — כי סיגמא לא יודעת שההזמנה בליקוט אצלנו, וממשיכה
  // להופיע ב"פתוחות" עד שהיא נסגרת בפועל. עכשיו מעדכנים רק את השדות שמגיעים
  // מסיגמא, ולא נוגעים בשדות הליקוט/בדיקה הפנימיים שלנו.
  const insertItem = db.prepare(`
    INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, location, barcode, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_key, line_no) DO UPDATE SET
      item_code = excluded.item_code, item_name = excluded.item_name,
      quantity = excluded.quantity, price = excluded.price,
      location = excluded.location, barcode = excluded.barcode
  `);
  // "הזמנה חדשה נכנסת מיד לתור" (סעיף 6.1.4) — רק אם עוד אין לה מצב עבודה.
  // agent_id מוזן כבר כאן אם יש מיפוי ידוע — לא מסתמכים על התאמת שם בזמן ריצה.
  const insertWorkflowIfNew = db.prepare(`
    INSERT OR IGNORE INTO workflow_state (order_key, status, priority, queue_entered_at, agent_id)
    VALUES (?, 'waiting_pick', 'normal', datetime('now'), ?)
  `);
  // גיבוי: אם ההזמנה כבר הייתה קיימת בלי agent_id (למשל המיפוי נוסף אחרי
  // שההזמנה כבר נכנסה), נמלא אותו בדיעבד ברגע שהוא הופך זמין.
  const backfillAgentId = db.prepare(`
    UPDATE workflow_state SET agent_id = ? WHERE order_key = ? AND agent_id IS NULL
  `);

  let created = 0, updated = 0;
  const tx = db.transaction((list) => {
    for (const o of list) {
      const key = orderKey(o.companyId, o.sidra, o.orderNum);
      const existed = db.prepare('SELECT 1 FROM orders_cache WHERE order_key = ?').get(key);
      const agentUserId = o.sigmaAgentId ? (findAgentUser.get(o.sigmaAgentId) || {}).user_id || null : null;
      insertOrder.run({
        order_key: key, company_id: o.companyId, sidra: o.sidra, order_num: o.orderNum,
        customer_name: o.customerName, order_date: o.orderDate || null, delivery_date: o.deliveryDate || null,
        total_amount: o.totalAmount || null, line_count: (o.items || []).length,
        notes: o.notes || null, source_status: o.sourceStatus || 'open',
        sigma_agent_name: o.agentName || null,
        sigma_agent_id: o.sigmaAgentId || null,
        sigma_created_at: o.createdAt || null,
      });
      const currentLineNos = new Set();
      (o.items || []).forEach((it, idx) => {
        const lineNo = it.lineNo ?? idx + 1;
        currentLineNos.add(String(lineNo));
        insertItem.run(key, lineNo, it.itemCode, it.itemName, it.quantity, it.price, it.location || null, it.barcode || null, null);
      });
      // תיקון 14.9.2026 (דיווח דניאל, הזמנה 192821 "עדשה מקומית"): שורות
      // ששורשרו לחשבונית בסיגמא בין סבב לסבב פשוט מפסיקות להישלח — עד עכשיו
      // לא היה שום מנגנון שמוחק אותן מה-cache שלנו, אז הן נשארו תקועות
      // למלקט לנצח למרות שכבר סגרו אותן. מוחקים כל שורה קיימת שלא הופיעה
      // בסבב הנוכחי (גם אם כבר לוקטה/נבדקה — היא כבר לא חלק מההזמנה בסיגמא).
      const existingLines = db.prepare('SELECT line_no FROM order_items_cache WHERE order_key = ?').all(key);
      const deleteLine = db.prepare('DELETE FROM order_items_cache WHERE order_key = ? AND line_no = ?');
      let removedLines = 0;
      for (const row of existingLines) {
        if (!currentLineNos.has(String(row.line_no))) {
          deleteLine.run(key, row.line_no);
          removedLines++;
        }
      }
      const wf = insertWorkflowIfNew.run(key, agentUserId);
      if (agentUserId) backfillAgentId.run(agentUserId, key);
      existed ? updated++ : created++;
      if (wf.changes > 0) emitChange('order', { order_key: key, status: 'waiting_pick', version: 1 });
      else if (removedLines > 0) emitChange('order', { order_key: key });
    }
  });
  tx(orders);

  // Date.now() לבדו יכול להתנגש בקריאות עוקבות מהירות (למשל בבדיקות) —
  // תוספת אקראית מבטיחה ייחודיות גם באותה מילישנייה.
  db.prepare(`INSERT INTO sync_runs (run_id, source, ok, detail) VALUES (?, 'sigma', 1, ?)`)
    .run(`run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`, JSON.stringify({ received: orders.length, created, updated }));

  return { received: orders.length, created, updated };
}

// ניקוי: הזמנות ש"ממתינות לליקוט" (עוד לא התחילו) אבל כבר לא מופיעות ברשימה
// הפתוחה שנשלחה מ-Sigma (למשל שורשרו במלואה לחשבונית, בוטלו, או חזרו למזכירה) —
// נסגרות אוטומטית (עוד לא התחיל בהן עבודה, אין מה "לאבד").
//
// תיקון 14.9.2026 (דיווח דניאל, הזמנה 192821 "עדשה מקומית"): הזמנה שכבר
// **בעבודה** (ליקוט/בדיקה/אריזה/משלוח) ופתאום שורשרה במלואה לחשבונית לא
// הייתה מטופלת בכלל — לא נסגרה (בכוונה, כדי לא "לגנוב" עבודה שמישהו כבר
// באמצעה) אבל גם לא זזה משם, כך שהיא נשארה תקועה בתור הליקוט הפעיל בלי
// אף פריט (אחרי שהניקוי ברמת השורה הבודדת ב-ingestOrders מחק את כל
// השורות). דניאל ביקש: להעביר הזמנות כאלה לפאנל "הזמנות מעוכבות" הקיים
// (חריגות → on_hold) עד שמנהל יסגור אותן ידנית — לא לסגור אוטומטית,
// ולא להשאיר אותן "בליקוט" בלי כלום ללקט.
function reconcileOpenOrders(companyId, sidra, validOrderNums) {
  const prefix = `${companyId}|${sidra}|`;
  const rows = db.prepare(`
    SELECT order_key, status FROM workflow_state
    WHERE order_key LIKE ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
  `).all(`${prefix}%`, ...ACTIVE_STATUSES);

  const validSet = new Set(validOrderNums.map(String));
  let closedCount = 0, onHoldCount = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const num = r.order_key.split('|')[2];
      if (validSet.has(num)) continue;
      if (r.status === 'waiting_pick') {
        db.prepare(`
          UPDATE workflow_state SET status = 'closed', version = version + 1, updated_at = datetime('now')
          WHERE order_key = ?
        `).run(r.order_key);
        db.prepare(`
          INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
          VALUES (?, ?, NULL, 'waiting_pick', 'closed', 'הוסרה מסנכרון Sigma — כבר לא בקריטריון ההזמנות הפתוחות')
        `).run(uid('evt'), r.order_key);
        emitChange('order', { order_key: r.order_key, status: 'closed' });
        closedCount++;
      } else {
        db.prepare(`
          UPDATE workflow_state
          SET status = 'on_hold', hold_reason = ?, pre_wait_status = ?, version = version + 1, updated_at = datetime('now')
          WHERE order_key = ?
        `).run(SYNC_HOLD_REASON, r.status, r.order_key);
        db.prepare(`
          INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
          VALUES (?, ?, NULL, ?, 'on_hold', 'הועברה אוטומטית לעיכוב — הוסרה מסנכרון Sigma באמצע עבודה')
        `).run(uid('evt'), r.order_key, r.status);
        emitChange('order', { order_key: r.order_key, status: 'on_hold' });
        onHoldCount++;
      }
    }
  });
  tx();
  return { checked: rows.length, closed: closedCount, onHold: onHoldCount };
}

// תיקון-חירום: מחזיר ל"ממתינה לליקוט" הזמנות שנסגרו בטעות ע"י reconcile (למשל
// קריאת בדיקה/דיבוג עם validOrderNums ריק ששלחה סגירה לא נכונה). לא נוגע
// בהזמנות שנסגרו מסיבה אחרת (סטטוס to_status חייב להיות 'closed' עם ההערה
// הספציפית של ניקוי סנכרון, ולא היה שינוי סטטוס נוסף אחריו).
function undoRecentSyncClosures(companyId, sidra, sinceMinutesAgo) {
  const prefix = `${companyId}|${sidra}|`;
  const rows = db.prepare(`
    SELECT we.order_key, we.event_id
    FROM workflow_events we
    JOIN workflow_state ws ON ws.order_key = we.order_key
    WHERE we.order_key LIKE ?
      AND we.to_status = 'closed'
      AND we.note = 'הוסרה מסנכרון Sigma — כבר לא בקריטריון ההזמנות הפתוחות'
      AND we.created_at >= datetime('now', ?)
      AND ws.status = 'closed'
  `).all(`${prefix}%`, `-${Number(sinceMinutesAgo)} minutes`);

  let reopened = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare(`
        UPDATE workflow_state SET status = 'waiting_pick', version = version + 1, updated_at = datetime('now')
        WHERE order_key = ?
      `).run(r.order_key);
      db.prepare(`
        INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note)
        VALUES (?, ?, NULL, 'closed', 'waiting_pick', 'שוחזרה — נסגרה בטעות ע"י בדיקת ניקוי שגויה')
      `).run(uid('evt'), r.order_key);
      emitChange('order', { order_key: r.order_key, status: 'waiting_pick' });
      reopened++;
    }
  });
  tx();
  return { checked: rows.length, reopened };
}

// הזמנות status_ID=0 ("ללא סטטוס", עדיין אצל המזכירה) — תצוגה בלבד, לא חלק
// ממנוע ה-workflow. פשוט מחליפים את כל הסט בכל סבב (אין claim/היסטוריה לשמר).
function ingestPendingOrders(orders) {
  const insert = db.prepare(`
    INSERT INTO pending_orders_cache (order_key, company_id, sidra, order_num, customer_name, order_date, sigma_created_at, total_amount, sigma_agent_name, synced_at)
    VALUES (@order_key, @company_id, @sidra, @order_num, @customer_name, @order_date, @sigma_created_at, @total_amount, @sigma_agent_name, datetime('now'))
    ON CONFLICT(order_key) DO UPDATE SET
      customer_name = excluded.customer_name, order_date = excluded.order_date,
      sigma_created_at = excluded.sigma_created_at, total_amount = excluded.total_amount,
      sigma_agent_name = excluded.sigma_agent_name, synced_at = datetime('now')
  `);
  const tx = db.transaction((list) => {
    for (const o of list) {
      insert.run({
        order_key: orderKey(o.companyId, o.sidra, o.orderNum),
        company_id: o.companyId, sidra: o.sidra, order_num: o.orderNum,
        customer_name: o.customerName, order_date: o.orderDate || null,
        sigma_created_at: o.createdAt || null, total_amount: o.totalAmount || null,
        sigma_agent_name: o.agentName || null,
      });
    }
  });
  tx(orders);
  return { received: orders.length };
}

// מסיר מהתצוגה הזמנות שכבר לא ב-status_ID=0 (הודפסו/בוטלו/חזרו) — לפי סדרה.
function reconcilePendingOrders(companyId, sidra, validOrderNums) {
  const prefix = `${companyId}|${sidra}|`;
  const rows = db.prepare(`SELECT order_key FROM pending_orders_cache WHERE order_key LIKE ?`).all(`${prefix}%`);
  const validSet = new Set(validOrderNums.map(String));
  let removed = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const num = r.order_key.split('|')[2];
      if (validSet.has(num)) continue;
      db.prepare('DELETE FROM pending_orders_cache WHERE order_key = ?').run(r.order_key);
      removed++;
    }
  });
  tx();
  return { checked: rows.length, removed };
}

// מיפוי פריט->ספק (ר' ייעוץ 16.9.2026, נושא 5 "חוסרים לפי ספק") - קטלוג
// שמשתנה לאט, מוחלף במלואו בכל סבב (בניגוד להזמנות, אין כאן claim/סטטוס
// עבודה לשמר). items: [{ itemCode, supplierId, supplierName }]
function ingestItemSuppliers(items) {
  const upsert = db.prepare(`
    INSERT INTO item_suppliers (item_code, supplier_id, supplier_name, synced_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(item_code) DO UPDATE SET
      supplier_id = excluded.supplier_id, supplier_name = excluded.supplier_name,
      synced_at = datetime('now')
  `);
  const tx = db.transaction((list) => {
    for (const it of list) {
      if (!it.itemCode || !it.supplierId) continue;
      upsert.run(String(it.itemCode), it.supplierId, it.supplierName || null);
    }
  });
  tx(items);
  return { received: items.length };
}

module.exports = {
  ingestOrders, reconcileOpenOrders, undoRecentSyncClosures,
  ingestPendingOrders, reconcilePendingOrders, orderKey,
  ingestItemSuppliers,
};
