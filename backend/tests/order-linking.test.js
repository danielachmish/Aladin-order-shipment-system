const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// מכסה את הזרימה שדניאל שאל עליה: קישור/ביטול-קישור הזמנות (workflow.js linkOrders/unlinkOrder)
// ואת מה שהיום *לא* אכוף - כל הזמנה בקבוצה עדיין זזה בסטטוסים בנפרד.
describe('order linking', () => {
  let app, db, cleanup, warehouseToken;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'wh1', role: 'warehouse' });
    warehouseToken = await loginAs(request, app, 'wh1');
  });

  function auth(req) {
    return req.set('Authorization', `Bearer ${warehouseToken}`);
  }

  it('links two orders by order number and exposes each other as linked_orders', async () => {
    seedOrder(db, { orderKey: '3|0|1001', orderNum: 1001 });
    seedOrder(db, { orderKey: '3|0|1002', orderNum: 1002 });

    const linkRes = await auth(request(app).post('/api/orders/3%7C0%7C1001/link')).send({ otherOrderNum: 1002 });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.linkedGroupId).toBeTruthy();

    const order1 = await auth(request(app).get('/api/orders/3%7C0%7C1001'));
    expect(order1.body.order.linked_group_id).toBe(linkRes.body.linkedGroupId);
    expect(order1.body.linked_orders).toHaveLength(1);
    expect(order1.body.linked_orders[0].order_key).toBe('3|0|1002');

    const order2 = await auth(request(app).get('/api/orders/3%7C0%7C1002'));
    expect(order2.body.order.linked_group_id).toBe(linkRes.body.linkedGroupId);
  });

  it('rejects linking an order to itself', async () => {
    seedOrder(db, { orderKey: '3|0|2001', orderNum: 2001 });
    const res = await auth(request(app).post('/api/orders/3%7C0%7C2001/link')).send({ otherOrderNum: 2001 });
    expect(res.status).toBe(400);
  });

  it('rejects linking two orders that already belong to two different groups', async () => {
    seedOrder(db, { orderKey: '3|0|3001', orderNum: 3001 });
    seedOrder(db, { orderKey: '3|0|3002', orderNum: 3002 });
    seedOrder(db, { orderKey: '3|0|3003', orderNum: 3003 });
    seedOrder(db, { orderKey: '3|0|3004', orderNum: 3004 });

    await auth(request(app).post('/api/orders/3%7C0%7C3001/link')).send({ otherOrderNum: 3002 }); // group A
    await auth(request(app).post('/api/orders/3%7C0%7C3003/link')).send({ otherOrderNum: 3004 }); // group B

    const res = await auth(request(app).post('/api/orders/3%7C0%7C3001/link')).send({ otherOrderNum: 3003 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/קבוצות קישור שונות/);
  });

  it('unlink clears the group on that order only', async () => {
    seedOrder(db, { orderKey: '3|0|4001', orderNum: 4001 });
    seedOrder(db, { orderKey: '3|0|4002', orderNum: 4002 });
    await auth(request(app).post('/api/orders/3%7C0%7C4001/link')).send({ otherOrderNum: 4002 });

    const unlinkRes = await auth(request(app).post('/api/orders/3%7C0%7C4001/unlink'));
    expect(unlinkRes.status).toBe(200);
    expect(unlinkRes.body.state.linked_group_id).toBeNull();

    const order2 = await auth(request(app).get('/api/orders/3%7C0%7C4002'));
    expect(order2.body.order.linked_group_id).toBeTruthy(); // עדיין מקושרת, רק 4001 יצאה

    const order1 = await auth(request(app).get('/api/orders/3%7C0%7C4001'));
    expect(order1.body.linked_orders).toHaveLength(0);
  });

  // ליקוט/בדיקה מוקדמים - קצב עצמאי בין הזמנות מקושרות נשאר מותר בכוונה
  // (ר' assertLinkedGroupReady ב-workflow.js). האכיפה מתחילה רק משלב האריזה.
  it('still allows independent picking pace between linked orders', async () => {
    seedOrder(db, { orderKey: '3|0|5001', orderNum: 5001, status: 'picking' });
    seedOrder(db, { orderKey: '3|0|5002', orderNum: 5002, status: 'waiting_pick' }); // עדיין בתור
    await auth(request(app).post('/api/orders/3%7C0%7C5001/link')).send({ otherOrderNum: 5002 });

    const res = await auth(request(app).post('/api/orders/3%7C0%7C5001/finish-picking'));
    expect(res.status).toBe(200);
  });

  // מכאן ואילך: אכיפת "אריזה משותפת" שנוספה בעקבות הייעוץ (16.9.2026) -
  // הזמנה מקושרת לא יכולה "לברוח קדימה" משלב האריזה ואילך אם אחותה נשארה מאחור.
  it('blocks pack-done when a linked sibling has not reached the same stage yet', async () => {
    seedOrder(db, { orderKey: '3|0|6001', orderNum: 6001, status: 'ready_to_pack' });
    seedOrder(db, { orderKey: '3|0|6002', orderNum: 6002, status: 'picking' }); // עדיין מאחור
    await auth(request(app).post('/api/orders/3%7C0%7C6001/link')).send({ otherOrderNum: 6002 });

    const res = await auth(request(app).post('/api/orders/3%7C0%7C6001/pack-done'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/6002/);
  });

  it('allows pack-done once the linked sibling catches up to the same stage', async () => {
    seedOrder(db, { orderKey: '3|0|7001', orderNum: 7001, status: 'ready_to_pack' });
    seedOrder(db, { orderKey: '3|0|7002', orderNum: 7002, status: 'ready_to_pack' }); // כבר באותו שלב
    await auth(request(app).post('/api/orders/3%7C0%7C7001/link')).send({ otherOrderNum: 7002 });

    const res = await auth(request(app).post('/api/orders/3%7C0%7C7001/pack-done'));
    expect(res.status).toBe(200);
    expect(res.body.state.status).toBe('waiting_pickup');
  });

  it('blocks close (self-pickup) when a linked sibling is still behind', async () => {
    seedOrder(db, { orderKey: '3|0|8001', orderNum: 8001, status: 'waiting_pickup' });
    seedOrder(db, { orderKey: '3|0|8002', orderNum: 8002, status: 'ready_to_pack' }); // עוד לא ארוזה
    await auth(request(app).post('/api/orders/3%7C0%7C8001/link')).send({ otherOrderNum: 8002 });

    const res = await auth(request(app).post('/api/orders/3%7C0%7C8001/self-pickup'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8002/);
  });

  it('a cancelled sibling never blocks the group', async () => {
    seedOrder(db, { orderKey: '3|0|9101', orderNum: 9101, status: 'waiting_pickup' });
    seedOrder(db, { orderKey: '3|0|9102', orderNum: 9102, status: 'cancelled' });
    await auth(request(app).post('/api/orders/3%7C0%7C9101/link')).send({ otherOrderNum: 9102 });

    const res = await auth(request(app).post('/api/orders/3%7C0%7C9101/self-pickup'));
    expect(res.status).toBe(200);
    expect(res.body.state.status).toBe('closed');
  });
});
