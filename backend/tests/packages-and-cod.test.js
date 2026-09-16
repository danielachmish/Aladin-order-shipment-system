const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// מכסה שני פיצ'רים מהייעוץ (17.9.2026): (1) ספירת חבילות/משטחים ב-pack-done,
// לשימוש המזכירה בהפקת שטרי מטען UPS; (2) גוביינא (שיק דחוי) לפי הזמנה,
// כולל שכפול אוטומטי על קבוצה מקושרת (משלוח פיזי אחד).
describe('packages count + COD (gvina)', () => {
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

  describe('pack-done package/pallet count', () => {
    it('stores package and pallet counts on pack-done', async () => {
      seedOrder(db, { orderKey: '3|0|1', orderNum: 1, status: 'ready_to_pack' });
      const res = await request(app)
        .post('/api/orders/3%7C0%7C1/pack-done')
        .set('Authorization', `Bearer ${warehouseToken}`)
        .send({ packageCount: 3, palletCount: 1 });
      expect(res.status).toBe(200);
      expect(res.body.state.package_count).toBe(3);
      expect(res.body.state.pallet_count).toBe(1);
    });

    it('pack-done still works with no counts given (both stay null)', async () => {
      seedOrder(db, { orderKey: '3|0|2', orderNum: 2, status: 'ready_to_pack' });
      const res = await request(app)
        .post('/api/orders/3%7C0%7C2/pack-done')
        .set('Authorization', `Bearer ${warehouseToken}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.state.package_count).toBeNull();
      expect(res.body.state.pallet_count).toBeNull();
    });

    it('package/pallet counts show up in the history view', async () => {
      seedOrder(db, { orderKey: '3|0|3', orderNum: 3, status: 'ready_to_pack' });
      await request(app)
        .post('/api/orders/3%7C0%7C3/pack-done')
        .set('Authorization', `Bearer ${warehouseToken}`)
        .send({ packageCount: 5 });

      const res = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order = res.body.orders.find((o) => o.order_key === '3|0|3');
      expect(order.package_count).toBe(5);
    });
  });

  describe('POST /orders/:key/cod', () => {
    it('rejects a non-manager (role gate)', async () => {
      seedOrder(db, { orderKey: '3|0|4', orderNum: 4 });
      const res = await request(app)
        .post('/api/orders/3%7C0%7C4/cod')
        .set('Authorization', `Bearer ${warehouseToken}`)
        .send({ codType: 'full', dueDate: '2026-10-01' });
      expect(res.status).toBe(403);
    });

    it('rejects an invalid codType', async () => {
      seedOrder(db, { orderKey: '3|0|5', orderNum: 5 });
      const res = await request(app)
        .post('/api/orders/3%7C0%7C5/cod')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ codType: 'bogus', dueDate: '2026-10-01' });
      expect(res.status).toBe(400);
    });

    it('requires an amount for custom and a due date for anything but none', async () => {
      seedOrder(db, { orderKey: '3|0|6', orderNum: 6 });
      const noAmount = await request(app)
        .post('/api/orders/3%7C0%7C6/cod')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ codType: 'custom', dueDate: '2026-10-01' });
      expect(noAmount.status).toBe(400);

      const noDate = await request(app)
        .post('/api/orders/3%7C0%7C6/cod')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ codType: 'full' });
      expect(noDate.status).toBe(400);
    });

    it('"full" computes the display amount from the order total', async () => {
      seedOrder(db, { orderKey: '3|0|7', orderNum: 7, status: 'ready_to_pack' });
      db.prepare(`UPDATE orders_cache SET total_amount = 1200 WHERE order_key = '3|0|7'`).run();

      const res = await request(app)
        .post('/api/orders/3%7C0%7C7/cod')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ codType: 'full', dueDate: '2026-10-01' });
      expect(res.status).toBe(200);

      const hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order = hist.body.orders.find((o) => o.order_key === '3|0|7');
      expect(order.cod_display_amount).toBe(1200);
      expect(order.cod_due_date).toBe('2026-10-01');
    });

    it('"custom" uses the entered amount, ignoring the order total', async () => {
      seedOrder(db, { orderKey: '3|0|8', orderNum: 8, status: 'ready_to_pack' });
      db.prepare(`UPDATE orders_cache SET total_amount = 1200 WHERE order_key = '3|0|8'`).run();

      await request(app)
        .post('/api/orders/3%7C0%7C8/cod')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ codType: 'custom', amount: 300, dueDate: '2026-10-01' });

      const hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order = hist.body.orders.find((o) => o.order_key === '3|0|8');
      expect(order.cod_display_amount).toBe(300);
    });

    it('"full_plus_extra" adds the extra amount on top of the order total', async () => {
      seedOrder(db, { orderKey: '3|0|9', orderNum: 9, status: 'ready_to_pack' });
      db.prepare(`UPDATE orders_cache SET total_amount = 1000 WHERE order_key = '3|0|9'`).run();

      await request(app)
        .post('/api/orders/3%7C0%7C9/cod')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ codType: 'full_plus_extra', amount: 250, dueDate: '2026-10-01' });

      const hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order = hist.body.orders.find((o) => o.order_key === '3|0|9');
      expect(order.cod_display_amount).toBe(1250);
    });

    it('setting COD on a linked order replicates it across the whole group and sums both totals for "full"', async () => {
      seedOrder(db, { orderKey: '3|0|10', orderNum: 10, status: 'ready_to_pack' });
      seedOrder(db, { orderKey: '3|0|11', orderNum: 11, status: 'ready_to_pack' });
      db.prepare(`UPDATE orders_cache SET total_amount = 400 WHERE order_key = '3|0|10'`).run();
      db.prepare(`UPDATE orders_cache SET total_amount = 600 WHERE order_key = '3|0|11'`).run();
      await request(app).post('/api/orders/3%7C0%7C10/link').set('Authorization', `Bearer ${managerToken}`).send({ otherOrderNum: 11 });

      const res = await request(app)
        .post('/api/orders/3%7C0%7C10/cod')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ codType: 'full', dueDate: '2026-10-05' });
      expect(res.status).toBe(200);

      const hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order10 = hist.body.orders.find((o) => o.order_key === '3|0|10');
      const order11 = hist.body.orders.find((o) => o.order_key === '3|0|11');
      // שתיהן רואות את אותו סכום משולב (400+600), למרות שהוגדר רק דרך 3|0|10
      expect(order10.cod_display_amount).toBe(1000);
      expect(order11.cod_display_amount).toBe(1000);
      expect(order11.cod_due_date).toBe('2026-10-05');
    });

    it('"none" clears any previously set COD', async () => {
      seedOrder(db, { orderKey: '3|0|12', orderNum: 12, status: 'ready_to_pack' });
      db.prepare(`UPDATE orders_cache SET total_amount = 500 WHERE order_key = '3|0|12'`).run();
      await request(app).post('/api/orders/3%7C0%7C12/cod').set('Authorization', `Bearer ${managerToken}`).send({ codType: 'full', dueDate: '2026-10-01' });
      await request(app).post('/api/orders/3%7C0%7C12/cod').set('Authorization', `Bearer ${managerToken}`).send({ codType: 'none' });

      const hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order = hist.body.orders.find((o) => o.order_key === '3|0|12');
      expect(order.cod_display_amount).toBe(0);
      expect(order.cod_due_date).toBeNull();
    });
  });
});
