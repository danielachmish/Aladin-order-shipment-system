const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// "יש תוספת בדרך" לא אמור לתת להזמנה לעבור לשלב אריזה בשקט — מישהו עלול
// לארוז ולשלוח בלי הפריט שעוד בדרך. finish-check צריך להיחסם עם קוד ייעודי
// (לא רק בסגירה, כמו שהיה עד עכשיו) עד ש"התוספת הגיעה" נלחץ. ר' בקשת דניאל
// 17.9.2026 ("אני לא רוצה שיגיעו לשלב הזה... יקפוץ לו חלון מודגש").
describe('finish-check is blocked while an addition is still pending', () => {
  let app, db, cleanup, managerToken, warehouseToken;

  beforeAll(() => { ({ app, db, cleanup } = createTestApp()); });
  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
    seedUser(db, { username: 'wh1', role: 'warehouse' });
    managerToken = await loginAs(request, app, 'manager1');
    warehouseToken = await loginAs(request, app, 'wh1');
  });

  async function readyForCheckOrderWithOneCheckedLine(orderKey) {
    db.prepare(`
      INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked, checked)
      VALUES (?, 1, 'A1', 'פריט', 1, 10, 'picked', 1, 1)
    `).run(orderKey);
  }

  it('rejects finish-check with a "pending_addition" error code while pending_addition_note is set', async () => {
    seedOrder(db, { orderKey: '3|0|1', orderNum: 1, status: 'ready_for_check' });
    await readyForCheckOrderWithOneCheckedLine('3|0|1');
    await request(app).post('/api/orders/3%7C0%7C1/request-addition').set('Authorization', `Bearer ${managerToken}`).send({ note: 'עוד מחשב בדרך' });

    const res = await request(app).post('/api/orders/3%7C0%7C1/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('pending_addition');
    expect(res.body.error).toContain('עוד מחשב בדרך');

    const order = await request(app).get('/api/orders/3%7C0%7C1').set('Authorization', `Bearer ${warehouseToken}`);
    expect(order.body.order.status).toBe('ready_for_check'); // לא זזה משלב בדיקה
  });

  it('allows finish-check once the addition has been marked received', async () => {
    seedOrder(db, { orderKey: '3|0|2', orderNum: 2, status: 'ready_for_check' });
    await readyForCheckOrderWithOneCheckedLine('3|0|2');
    await request(app).post('/api/orders/3%7C0%7C2/request-addition').set('Authorization', `Bearer ${managerToken}`).send({ note: 'תוספת' });

    const blocked = await request(app).post('/api/orders/3%7C0%7C2/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(blocked.status).toBe(400);

    await request(app).post('/api/orders/3%7C0%7C2/addition-received').set('Authorization', `Bearer ${managerToken}`);

    const res = await request(app).post('/api/orders/3%7C0%7C2/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.state.status).toBe('ready_to_pack');
  });

  it('an order with no pending addition finishes check normally', async () => {
    seedOrder(db, { orderKey: '3|0|3', orderNum: 3, status: 'ready_for_check' });
    await readyForCheckOrderWithOneCheckedLine('3|0|3');

    const res = await request(app).post('/api/orders/3%7C0%7C3/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.state.status).toBe('ready_to_pack');
  });
});
