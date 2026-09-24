const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');
const sigmaIngest = require('../src/sigmaIngest');

// "שחרור חסימה" הרגיל מחזיר הזמנה שנחסמה אוטומטית (כבר שורשרה לחשבונית
// בסיגמא) לסטטוס הפעיל הקודם — שגורם לה להיחסם שוב בסבב הסנכרון הבא (לולאה
// אינסופית, ר' דיווח דניאל 24.9.2026). close-stuck סוגר אותה ישירות, ורק
// כשההזמנה נחסמה מהסיבה הזו הספציפית (לא מדיווח בעיה ידני).
describe('close-stuck-order: direct close for orders auto-held by Sigma reconcile', () => {
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

  it('reproduces the loop: release-hold on a Sigma-invoiced order just re-triggers the same hold on the next sync', async () => {
    seedOrder(db, { orderKey: '3|0|20', orderNum: 20, status: 'ready_to_pack' });

    // סיגמא כבר לא מכירה בהזמנה 20 כ"פתוחה" (שורשרה לחשבונית) — reconcile חוסם אותה
    sigmaIngest.reconcileOpenOrders(3, 0, []);
    let order = await request(app).get('/api/orders/3%7C0%7C20').set('Authorization', `Bearer ${warehouseToken}`);
    expect(order.body.order.status).toBe('on_hold');

    // "שחרור חסימה" — חוזר לסטטוס הפעיל הקודם, לא סוגר בפועל
    await request(app).post('/api/orders/3%7C0%7C20/release-hold').set('Authorization', `Bearer ${warehouseToken}`).send({});
    order = await request(app).get('/api/orders/3%7C0%7C20').set('Authorization', `Bearer ${warehouseToken}`);
    expect(order.body.order.status).toBe('ready_to_pack');

    // סבב הסנכרון הבא — עדיין לא ב-validOrderNums, אז זה נחסם שוב באותה סיבה
    sigmaIngest.reconcileOpenOrders(3, 0, []);
    order = await request(app).get('/api/orders/3%7C0%7C20').set('Authorization', `Bearer ${warehouseToken}`);
    expect(order.body.order.status).toBe('on_hold');
  });

  it('close-stuck actually closes an order held by the Sigma reconcile reason, and it stays closed', async () => {
    seedOrder(db, { orderKey: '3|0|21', orderNum: 21, status: 'waiting_pickup' });
    sigmaIngest.reconcileOpenOrders(3, 0, []);

    const res = await request(app).post('/api/orders/3%7C0%7C21/close-stuck').set('Authorization', `Bearer ${managerToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.state.status).toBe('closed');

    // סבב סנכרון נוסף לא מזיז אותה בכלל — closed לא ב-ACTIVE_STATUSES, reconcile לא נוגע בה
    sigmaIngest.reconcileOpenOrders(3, 0, []);
    const order = await request(app).get('/api/orders/3%7C0%7C21').set('Authorization', `Bearer ${managerToken}`);
    expect(order.body.order.status).toBe('closed');
  });

  it('rejects close-stuck on an order held by a manually-reported issue (not the Sigma reconcile reason)', async () => {
    seedOrder(db, { orderKey: '3|0|22', orderNum: 22, status: 'picking' });
    await request(app).post('/api/orders/3%7C0%7C22/issue').set('Authorization', `Bearer ${warehouseToken}`).send({ reason: 'חוסר במלאי' });

    const res = await request(app).post('/api/orders/3%7C0%7C22/close-stuck').set('Authorization', `Bearer ${managerToken}`).send({});
    expect(res.status).toBe(400);

    const order = await request(app).get('/api/orders/3%7C0%7C22').set('Authorization', `Bearer ${managerToken}`);
    expect(order.body.order.status).toBe('on_hold'); // לא זזה
  });

  it('close-stuck is manager-only', async () => {
    seedOrder(db, { orderKey: '3|0|23', orderNum: 23, status: 'ready_to_pack' });
    sigmaIngest.reconcileOpenOrders(3, 0, []);

    const res = await request(app).post('/api/orders/3%7C0%7C23/close-stuck').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(403);
  });
});
