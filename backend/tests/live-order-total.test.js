const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// הסכום המוצג על הזמנה צריך תמיד לשקף את שורות הפריטים בפועל כרגע, לא את
// המספר הקפוא שנמשך פעם אחת מסיגמא (orders_cache.total_amount) — ר' בקשת
// דניאל 17.9.2026: "הסכום... בפועל מה שקיים כרגע".
describe('order total is computed live from current item lines, not the frozen Sigma value', () => {
  let app, db, cleanup, managerToken;

  beforeAll(() => { ({ app, db, cleanup } = createTestApp()); });
  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
    managerToken = await loginAs(request, app, 'manager1');
  });

  it('GET /orders shows the live sum of item lines, ignoring a stale cached total_amount', async () => {
    seedOrder(db, { orderKey: '3|0|1', orderNum: 1 });
    db.prepare(`UPDATE orders_cache SET total_amount = 9999 WHERE order_key = '3|0|1'`).run(); // מספר קפוא/שגוי מסיגמא
    db.prepare(`
      INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price)
      VALUES ('3|0|1', 1, 'A1', 'פריט א', 2, 50), ('3|0|1', 2, 'B1', 'פריט ב', 1, 30)
    `).run();

    const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${managerToken}`);
    const order = res.body.orders.find((o) => o.order_key === '3|0|1');
    expect(order.total_amount).toBe(130); // 2*50 + 1*30, לא 9999
  });

  it('GET /orders/:key (order detail) also uses the live sum', async () => {
    seedOrder(db, { orderKey: '3|0|2', orderNum: 2 });
    db.prepare(`UPDATE orders_cache SET total_amount = 500 WHERE order_key = '3|0|2'`).run();
    db.prepare(`
      INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price)
      VALUES ('3|0|2', 1, 'A1', 'פריט', 3, 40)
    `).run();

    const res = await request(app).get('/api/orders/3%7C0%7C2').set('Authorization', `Bearer ${managerToken}`);
    expect(res.body.order.total_amount).toBe(120);
  });

  it('GET /history also uses the live sum', async () => {
    seedOrder(db, { orderKey: '3|0|3', orderNum: 3, status: 'ready_for_check' });
    db.prepare(`UPDATE orders_cache SET total_amount = 1 WHERE order_key = '3|0|3'`).run();
    db.prepare(`
      INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price)
      VALUES ('3|0|3', 1, 'A1', 'פריט', 4, 25)
    `).run();

    const res = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
    const order = res.body.orders.find((o) => o.order_key === '3|0|3');
    expect(order.total_amount).toBe(100);
  });

  it('falls back to the cached total_amount when there are no item lines yet', async () => {
    seedOrder(db, { orderKey: '3|0|4', orderNum: 4 });
    db.prepare(`UPDATE orders_cache SET total_amount = 777 WHERE order_key = '3|0|4'`).run();

    const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${managerToken}`);
    const order = res.body.orders.find((o) => o.order_key === '3|0|4');
    expect(order.total_amount).toBe(777);
  });
});
