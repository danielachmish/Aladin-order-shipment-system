// קליטת הזמנות שנדחפות (push) מה-Sigma Bridge המקומי — ר' bridge/sync.js.
// זה מחליף את realSigmaBridge.js (משיכה/pull) כארכיטקטורה בפועל: השרת של
// אלדין בענן (Render) אינו יכול לגשת ל-SQL Server הפיזי שנמצא ברשת המקומית
// (וגם לא צריך — בדיוק כפי שהאפיון ממליץ בסעיף 7: "סנכרון יוצא בלבד" מהרשת
// המקומית אל הענן, בלי לחשוף את ה-SQL Server לאינטרנט).
const crypto = require('crypto');
const { db } = require('./db');
const { emitChange } = require('./bus');

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function orderKey(companyId, sidra, num) {
  return `${companyId}|${sidra}|${num}`;
}

// order: { companyId, sidra, orderNum, customerName, orderDate, deliveryDate,
//          totalAmount, notes, sourceStatus, agentName, items: [{lineNo,itemCode,itemName,quantity,price,location}] }
function ingestOrders(orders) {
  const insertOrder = db.prepare(`
    INSERT INTO orders_cache (order_key, company_id, sidra, order_num, customer_name, order_date, delivery_date, total_amount, line_count, notes, source_status, sigma_agent_name, sigma_created_at, synced_at)
    VALUES (@order_key, @company_id, @sidra, @order_num, @customer_name, @order_date, @delivery_date, @total_amount, @line_count, @notes, @source_status, @sigma_agent_name, @sigma_created_at, datetime('now'))
    ON CONFLICT(order_key) DO UPDATE SET
      customer_name = excluded.customer_name, order_date = excluded.order_date,
      delivery_date = excluded.delivery_date, total_amount = excluded.total_amount,
      line_count = excluded.line_count, notes = excluded.notes,
      source_status = excluded.source_status, sigma_agent_name = excluded.sigma_agent_name,
      sigma_created_at = excluded.sigma_created_at,
      synced_at = datetime('now')
  `);
  const insertItem = db.prepare(`
    INSERT OR REPLACE INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, location, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // "הזמנה חדשה נכנסת מיד לתור" (סעיף 6.1.4) — רק אם עוד אין לה מצב עבודה
  const insertWorkflowIfNew = db.prepare(`
    INSERT OR IGNORE INTO workflow_state (order_key, status, priority, queue_entered_at)
    VALUES (?, 'waiting_pick', 'normal', datetime('now'))
  `);

  let created = 0, updated = 0;
  const tx = db.transaction((list) => {
    for (const o of list) {
      const key = orderKey(o.companyId, o.sidra, o.orderNum);
      const existed = db.prepare('SELECT 1 FROM orders_cache WHERE order_key = ?').get(key);
      insertOrder.run({
        order_key: key, company_id: o.companyId, sidra: o.sidra, order_num: o.orderNum,
        customer_name: o.customerName, order_date: o.orderDate || null, delivery_date: o.deliveryDate || null,
        total_amount: o.totalAmount || null, line_count: (o.items || []).length,
        notes: o.notes || null, source_status: o.sourceStatus || 'open',
        sigma_agent_name: o.agentName || null,
        sigma_created_at: o.createdAt || null,
      });
      (o.items || []).forEach((it, idx) => {
        insertItem.run(key, it.lineNo ?? idx + 1, it.itemCode, it.itemName, it.quantity, it.price, it.location || null, null);
      });
      const wf = insertWorkflowIfNew.run(key);
      existed ? updated++ : created++;
      if (wf.changes > 0) emitChange('order', { order_key: key, status: 'waiting_pick', version: 1 });
    }
  });
  tx(orders);

  db.prepare(`INSERT INTO sync_runs (run_id, source, ok, detail) VALUES (?, 'sigma', 1, ?)`)
    .run(`run_${Date.now()}`, JSON.stringify({ received: orders.length, created, updated }));

  return { received: orders.length, created, updated };
}

// ניקוי: הזמנות ש"ממתינות לליקוט" (עוד לא התחילו) אבל כבר לא מופיעות ברשימה
// הפתוחה שנשלחה מ-Sigma (למשל שורשרו במלואה לחשבונית, בוטלו, או חזרו למזכירה) —
// נסגרות אוטומטית. לא נוגעים בהזמנה שכבר בליקוט/אריזה/משלוח — מישהו כבר עובד עליה.
function reconcileOpenOrders(companyId, sidra, validOrderNums) {
  const prefix = `${companyId}|${sidra}|`;
  const rows = db.prepare(`
    SELECT order_key FROM workflow_state
    WHERE status = 'waiting_pick' AND order_key LIKE ?
  `).all(`${prefix}%`);

  const validSet = new Set(validOrderNums.map(String));
  let closedCount = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const num = r.order_key.split('|')[2];
      if (validSet.has(num)) continue;
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
    }
  });
  tx();
  return { checked: rows.length, closed: closedCount };
}

module.exports = { ingestOrders, reconcileOpenOrders, orderKey };
