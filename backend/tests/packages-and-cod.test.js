const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// מכסה שני פיצ'רים מהייעוץ (17.9.2026): (1) ספירת חבילות/משטחים ב-pack-done,
// לשימוש המזכירה בהפקת שטרי מטען UPS; (2) גוביינא (שיק דחוי) לפי הזמנה,
// כולל שכפול אוטומטי על קבוצה מקושרת (משלוח פיזי אחד).
describe('packages count + COD (gvina)', () => {
  let app, db, cleanup, managerToken, warehouseToken, agentToken;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
    seedUser(db, { username: 'wh1', role: 'warehouse' });
    seedUser(db, { username: 'agent1', role: 'agent' });
    managerToken = await loginAs(request, app, 'manager1');
    warehouseToken = await loginAs(request, app, 'wh1');
    agentToken = await loginAs(request, app, 'agent1');
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

    it('a real shortage (not replaced) lowers the "full" COD amount to what was actually supplied', async () => {
      seedOrder(db, { orderKey: '3|0|13', orderNum: 13, status: 'ready_for_check' });
      db.prepare(`UPDATE orders_cache SET total_amount = 1000 WHERE order_key = '3|0|13'`).run();
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked)
        VALUES ('3|0|13', 1, 'A1', 'פריט חסר', 5, 20, 'partial', 2)
      `).run(); // 3 יחידות חסרות * 20 = 60 ירידה

      await request(app).post('/api/orders/3%7C0%7C13/cod').set('Authorization', `Bearer ${managerToken}`).send({ codType: 'full', dueDate: '2026-10-01' });

      const hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order = hist.body.orders.find((o) => o.order_key === '3|0|13');
      expect(order.cod_display_amount).toBe(940);
    });

    it('a manager-entered (auto-confirmed) color-replacement does not lower the COD amount', async () => {
      seedOrder(db, { orderKey: '3|0|14', orderNum: 14, status: 'ready_for_check' });
      db.prepare(`UPDATE orders_cache SET total_amount = 1000 WHERE order_key = '3|0|14'`).run();
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked)
        VALUES ('3|0|14', 1, 'A1', 'פריט חסר', 5, 20, 'missing', 0)
      `).run();
      await request(app).post('/api/orders/3%7C0%7C14/items/1/replace').set('Authorization', `Bearer ${managerToken}`).send({ replacedTo: 'הוחלף לשחור', replacedQty: 5 });

      await request(app).post('/api/orders/3%7C0%7C14/cod').set('Authorization', `Bearer ${managerToken}`).send({ codType: 'full', dueDate: '2026-10-01' });

      const hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order = hist.body.orders.find((o) => o.order_key === '3|0|14');
      expect(order.cod_display_amount).toBe(1000);
      const shortage = order.shortages.find((s) => s.line_no === 1);
      expect(shortage.replaced_to).toBe('הוחלף לשחור');
      expect(shortage.replaced_qty).toBe(5);
      expect(shortage.replaced_confirmed).toBe(1);
    });

    it('a picker-entered replacement (during picking) stays pending and still counts against COD until the checker confirms it', async () => {
      seedOrder(db, { orderKey: '3|0|19', orderNum: 19, status: 'picking' });
      db.prepare(`UPDATE orders_cache SET total_amount = 1000 WHERE order_key = '3|0|19'`).run();
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked)
        VALUES ('3|0|19', 1, 'A1', 'פריט חסר', 5, 20, 'missing', 0)
      `).run();
      const res = await request(app)
        .post('/api/orders/3%7C0%7C19/items/1/replace')
        .set('Authorization', `Bearer ${warehouseToken}`)
        .send({ replacedTo: 'שחור', replacedQty: 5 });
      expect(res.body.item.replaced_confirmed).toBe(0);

      // ההיסטוריה מציגה רק הזמנות שכבר עברו ליקוט; מדמים את המעבר לבדיקה
      // כדי לראות את סכום הגוביינא — לא נוגע ב-replaced_confirmed עצמו.
      db.prepare(`UPDATE workflow_state SET status = 'ready_for_check' WHERE order_key = '3|0|19'`).run();

      await request(app).post('/api/orders/3%7C0%7C19/cod').set('Authorization', `Bearer ${managerToken}`).send({ codType: 'full', dueDate: '2026-10-01' });
      let hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      let order = hist.body.orders.find((o) => o.order_key === '3|0|19');
      // עוד לא מאומת — ממשיך להיחשב חוסר אמיתי לצורך הגוביינא (5*20=100 ירידה)
      expect(order.cod_display_amount).toBe(900);

      const confirmRes = await request(app)
        .post('/api/orders/3%7C0%7C19/items/1/confirm-replace')
        .set('Authorization', `Bearer ${warehouseToken}`);
      expect(confirmRes.body.item.replaced_confirmed).toBe(1);

      hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      order = hist.body.orders.find((o) => o.order_key === '3|0|19');
      expect(order.cod_display_amount).toBe(1000);
    });

    it('clearing the replacement note (empty replacedTo) makes the shortage count against COD again', async () => {
      seedOrder(db, { orderKey: '3|0|15', orderNum: 15, status: 'ready_for_check' });
      db.prepare(`UPDATE orders_cache SET total_amount = 500 WHERE order_key = '3|0|15'`).run();
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked)
        VALUES ('3|0|15', 1, 'A1', 'פריט חסר', 2, 100, 'missing', 0)
      `).run();
      await request(app).post('/api/orders/3%7C0%7C15/items/1/replace').set('Authorization', `Bearer ${managerToken}`).send({ replacedTo: 'שחור', replacedQty: 2 });
      await request(app).post('/api/orders/3%7C0%7C15/items/1/replace').set('Authorization', `Bearer ${managerToken}`).send({ replacedTo: '' });
      await request(app).post('/api/orders/3%7C0%7C15/cod').set('Authorization', `Bearer ${managerToken}`).send({ codType: 'full', dueDate: '2026-10-01' });

      const hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      const order = hist.body.orders.find((o) => o.order_key === '3|0|15');
      expect(order.cod_display_amount).toBe(300);
    });

    it('POST /items/:lineNo/replace requires a positive quantity', async () => {
      seedOrder(db, { orderKey: '3|0|17b', orderNum: 176, status: 'ready_for_check' });
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked)
        VALUES ('3|0|17b', 1, 'A1', 'פריט', 1, 10, 'missing', 0)
      `).run();
      const res = await request(app)
        .post('/api/orders/3%7C0%7C17b/items/1/replace')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ replacedTo: 'שחור' });
      expect(res.status).toBe(400);
    });

    it('POST /items/:lineNo/replace is usable by the picker/checker (warehouse), not just a manager', async () => {
      seedOrder(db, { orderKey: '3|0|16', orderNum: 16, status: 'ready_for_check' });
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked)
        VALUES ('3|0|16', 1, 'A1', 'פריט', 1, 10, 'missing', 0)
      `).run();
      const res = await request(app)
        .post('/api/orders/3%7C0%7C16/items/1/replace')
        .set('Authorization', `Bearer ${warehouseToken}`)
        .send({ replacedTo: 'שחור', replacedQty: 1 });
      expect(res.status).toBe(200);
      expect(res.body.item.replaced_to).toBe('שחור');
      // בשלב הבדיקה (ready_for_check) גם warehouse נחשב מאומת מיד — הרי רק הבודק פועל בשלב הזה
      expect(res.body.item.replaced_confirmed).toBe(1);
    });

    it('POST /items/:lineNo/replace rejects an agent (role gate)', async () => {
      seedOrder(db, { orderKey: '3|0|18', orderNum: 18, status: 'ready_for_check' });
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked)
        VALUES ('3|0|18', 1, 'A1', 'פריט', 1, 10, 'missing', 0)
      `).run();
      const res = await request(app)
        .post('/api/orders/3%7C0%7C18/items/1/replace')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ replacedTo: 'שחור', replacedQty: 1 });
      expect(res.status).toBe(403);
    });

    // היסטוריה: כל הזמנה, גם ללא חוסר, צריכה שדה הוצאתי-חשבונית נגיש (marking
    // עצמאי מהחוסר) — ר' ייעוץ 17.9.2026.
    it('marks and unmarks an order with no shortages as invoiced (not tied to a shortage)', async () => {
      seedOrder(db, { orderKey: '3|0|17', orderNum: 17, status: 'closed' });

      const mark = await request(app).post('/api/orders/3%7C0%7C17/mark-shortage-invoiced').set('Authorization', `Bearer ${managerToken}`);
      expect(mark.status).toBe(200);

      let hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      let order = hist.body.orders.find((o) => o.order_key === '3|0|17');
      expect(order.shortage_invoiced_at).not.toBeNull();
      expect(order.shortages).toEqual([]);

      await request(app).post('/api/orders/3%7C0%7C17/unmark-shortage-invoiced').set('Authorization', `Bearer ${managerToken}`);
      hist = await request(app).get('/api/history').set('Authorization', `Bearer ${managerToken}`);
      order = hist.body.orders.find((o) => o.order_key === '3|0|17');
      expect(order.shortage_invoiced_at).toBeNull();
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
