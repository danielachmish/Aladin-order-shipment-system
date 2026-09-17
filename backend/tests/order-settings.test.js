const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// מכסה את ייעוץ 17.9.2026: פאנל "⚙️ הגדרות הזמנה" (גוביינא + משלוח מתוכנן +
// הערה + עדיפות) שמנהל יכול למלא מוקדם, ישר מרשימת ההזמנות - לא רק אחרי
// שההזמנה עברה להיסטוריה. גוביינא/משלוח/הערה משתכפלים על קבוצה מקושרת;
// עדיפות חלה רק על ההזמנה הנוכחית.
describe('order settings panel (POST /orders/:key/settings)', () => {
  let app, db, cleanup, managerToken, warehouseToken;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
    seedUser(db, { username: 'wh1', role: 'warehouse' });
    managerToken = await loginAs(request, app, 'manager1');
    warehouseToken = await loginAs(request, app, 'wh1');
  });

  it('rejects non-managers (role gate)', async () => {
    seedOrder(db, { orderKey: '3|0|1', orderNum: 1 });
    const res = await request(app)
      .post('/api/orders/3%7C0%7C1/settings')
      .set('Authorization', `Bearer ${warehouseToken}`)
      .send({ codType: 'none', priority: 'urgent' });
    expect(res.status).toBe(403);
  });

  it('sets priority to "next", which previously had no dedicated UI/route at all', async () => {
    seedOrder(db, { orderKey: '3|0|2', orderNum: 2 });
    const res = await request(app)
      .post('/api/orders/3%7C0%7C2/settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ priority: 'next' });
    expect(res.status).toBe(200);
    expect(res.body.state.priority).toBe('next');
  });

  it('sets planned delivery method and a free-text note, independent of orders_cache.notes', async () => {
    seedOrder(db, { orderKey: '3|0|3', orderNum: 3 });
    const res = await request(app)
      .post('/api/orders/3%7C0%7C3/settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ plannedDeliveryMethod: 'self_pickup', specialInstructions: 'לא להוציא לפני תשלום' });
    expect(res.status).toBe(200);
    expect(res.body.state.planned_delivery_method).toBe('self_pickup');
    expect(res.body.state.special_instructions).toBe('לא להוציא לפני תשלום');
  });

  it('rejects an invalid planned delivery method', async () => {
    seedOrder(db, { orderKey: '3|0|4', orderNum: 4 });
    const res = await request(app)
      .post('/api/orders/3%7C0%7C4/settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ plannedDeliveryMethod: 'carrier_pigeon' });
    expect(res.status).toBe(400);
  });

  it('still validates COD the same way as the old /cod endpoint', async () => {
    seedOrder(db, { orderKey: '3|0|5', orderNum: 5 });
    const res = await request(app)
      .post('/api/orders/3%7C0%7C5/settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ codType: 'custom', dueDate: '2026-10-01' }); // חסר amount
    expect(res.status).toBe(400);
  });

  it('replicates delivery-method plan and note across a linked group, but keeps priority per-order', async () => {
    seedOrder(db, { orderKey: '3|0|6', orderNum: 6 });
    seedOrder(db, { orderKey: '3|0|7', orderNum: 7 });
    await request(app).post('/api/orders/3%7C0%7C6/link').set('Authorization', `Bearer ${managerToken}`).send({ otherOrderNum: 7 });

    await request(app)
      .post('/api/orders/3%7C0%7C6/settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ plannedDeliveryMethod: 'ups', specialInstructions: 'איסוף מרוכז', priority: 'urgent' });

    const other = await request(app).get('/api/orders/3%7C0%7C7').set('Authorization', `Bearer ${managerToken}`);
    expect(other.body.order.planned_delivery_method).toBe('ups');
    expect(other.body.order.special_instructions).toBe('איסוף מרוכז');
    expect(other.body.order.priority).toBe('normal'); // לא הודבקה מההזמנה השנייה בקבוצה

    const mine = await request(app).get('/api/orders/3%7C0%7C6').set('Authorization', `Bearer ${managerToken}`);
    expect(mine.body.order.priority).toBe('urgent');
  });

  it('fields left out of the request are not touched', async () => {
    seedOrder(db, { orderKey: '3|0|8', orderNum: 8 });
    await request(app)
      .post('/api/orders/3%7C0%7C8/settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ specialInstructions: 'הערה ראשונה' });

    await request(app)
      .post('/api/orders/3%7C0%7C8/settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ priority: 'urgent' }); // לא נוגע בהערה

    const res = await request(app).get('/api/orders/3%7C0%7C8').set('Authorization', `Bearer ${managerToken}`);
    expect(res.body.order.special_instructions).toBe('הערה ראשונה');
    expect(res.body.order.priority).toBe('urgent');
  });

  describe('GET /orders list surfaces the new fields', () => {
    it('includes cod_display_amount, planned_delivery_method and special_instructions', async () => {
      seedOrder(db, { orderKey: '3|0|9', orderNum: 9 });
      db.prepare(`UPDATE orders_cache SET total_amount = 750 WHERE order_key = '3|0|9'`).run();
      await request(app)
        .post('/api/orders/3%7C0%7C9/settings')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ codType: 'full', dueDate: '2026-10-10', plannedDeliveryMethod: 'ups', specialInstructions: 'שים לב' });

      const list = await request(app).get('/api/orders').set('Authorization', `Bearer ${managerToken}`);
      const order = list.body.orders.find((o) => o.order_key === '3|0|9');
      expect(order.cod_display_amount).toBe(750);
      expect(order.planned_delivery_method).toBe('ups');
      expect(order.special_instructions).toBe('שים לב');
    });

    it('omits cod_display_amount entirely for an order with no COD set', async () => {
      seedOrder(db, { orderKey: '3|0|10', orderNum: 10 });
      const list = await request(app).get('/api/orders').set('Authorization', `Bearer ${managerToken}`);
      const order = list.body.orders.find((o) => o.order_key === '3|0|10');
      expect(order.cod_display_amount).toBeUndefined();
    });
  });
});
