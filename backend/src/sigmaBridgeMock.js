// MOCK: מדמה את "Sigma Bridge" (סעיף 6.1 + 7.1 באפיון).
// בפרודקשן: שירות Windows נפרד שקורא מ-SQL Server של Sigma דרך משתמש SELECT בלבד
// ומסנכרן ל-orders_cache/order_items_cache. כאן — נתוני דמו קבועים, כדי שאפשר
// יהיה להריץ ולבדוק את כל שאר המערכת בלי חיבור אמיתי.
// כדי לחבר Sigma אמיתי בעתיד: להחליף את seedOrders() בקריאה אמיתית ל-Bridge,
// בלי לשנות אף חלק אחר של המערכת (orders_cache הוא ה-contract).

const crypto = require('crypto');

function orderKey(companyId, sidra, num) {
  return `${companyId}|${sidra}|${num}`;
}

const DEMO_ORDERS = [
  {
    companyId: 3, sidra: 0, num: 54707,
    customer: 'מריאנה עוסק מורשה', total: 1240.5, lines: 4,
    notes: 'לקוח קבוע, לתאם משלוח לפני 14:00',
    agentUsername: 'agent1',
    items: [
      { code: 'A-100', name: 'מסך 24 אינץ׳', qty: 2, price: 320, location: 'A3' },
      { code: 'B-220', name: 'מקלדת אלחוטית', qty: 3, price: 90, location: 'B1' },
      { code: 'C-010', name: 'עכבר אופטי', qty: 3, price: 40, location: 'B2' },
      { code: 'D-500', name: 'רמקול Bluetooth', qty: 1, price: 260.5, location: 'C4' },
    ],
  },
  {
    companyId: 3, sidra: 0, num: 54712,
    customer: 'דקל טכנולוגיות בעמ', total: 860, lines: 2,
    notes: '',
    agentUsername: 'agent1',
    items: [
      { code: 'A-100', name: 'מסך 24 אינץ׳', qty: 1, price: 320, location: 'A3' },
      { code: 'E-330', name: 'עמדת עגינה', qty: 2, price: 270, location: 'A5' },
    ],
  },
  {
    companyId: 3, sidra: 0, num: 54720,
    customer: 'רותם שיווק', total: 430, lines: 1,
    notes: 'להתקשר לפני הגעה',
    agentUsername: 'agent2',
    items: [
      { code: 'F-050', name: 'כבל HDMI 3 מטר', qty: 10, price: 43, location: 'B4' },
    ],
  },
  {
    companyId: 3, sidra: 0, num: 54731,
    customer: 'ניצן אלקטרוניקה', total: 2100, lines: 3,
    notes: '',
    agentUsername: 'agent2',
    items: [
      { code: 'A-100', name: 'מסך 24 אינץ׳', qty: 4, price: 320, location: 'A3' },
      { code: 'G-777', name: 'כן למסך', qty: 4, price: 65, location: 'C1' },
      { code: 'B-220', name: 'מקלדת אלחוטית', qty: 4, price: 90, location: 'B1' },
    ],
  },
];

function seedOrders(db) {
  const insertOrder = db.prepare(`
    INSERT OR IGNORE INTO orders_cache
      (order_key, company_id, sidra, order_num, customer_name, order_date, delivery_date, total_amount, line_count, notes, source_status)
    VALUES (@order_key, @company_id, @sidra, @order_num, @customer_name, @order_date, @delivery_date, @total_amount, @line_count, @notes, 'open')
  `);
  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, location, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWorkflow = db.prepare(`
    INSERT OR IGNORE INTO workflow_state (order_key, status, priority, agent_id, queue_entered_at)
    VALUES (?, 'waiting_pick', 'normal', ?, datetime('now'))
  `);
  const users = db.prepare('SELECT user_id, username FROM users').all();
  const usernameToId = Object.fromEntries(users.map((u) => [u.username, u.user_id]));

  const today = new Date().toISOString().slice(0, 10);

  const insertAll = db.transaction(() => {
    for (const o of DEMO_ORDERS) {
      const key = orderKey(o.companyId, o.sidra, o.num);
      insertOrder.run({
        order_key: key,
        company_id: o.companyId,
        sidra: o.sidra,
        order_num: o.num,
        customer_name: o.customer,
        order_date: today,
        delivery_date: today,
        total_amount: o.total,
        line_count: o.lines,
        notes: o.notes,
      });
      o.items.forEach((it, idx) => {
        insertItem.run(key, idx + 1, it.code, it.name, it.qty, it.price, it.location, null);
      });
      insertWorkflow.run(key, usernameToId[o.agentUsername] || null);
    }
  });
  insertAll();
}

module.exports = { seedOrders, orderKey };
