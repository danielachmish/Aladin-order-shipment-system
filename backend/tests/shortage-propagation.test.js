const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// מכסה את הייעוץ 17.9.2026, נושא 4: ברגע שהבודק משאיר שורה 'missing' עד סוף
// finish-check (=מאומת, לא רק ניחוש המלקט), המערכת משדרת את זה לכל שאר
// ההזמנות הפתוחות עם אותו item_code שעוד לא לוקטו - כדי שהמלקטת תדלג עליהן -
// ומסך "חזר למלאי" מנקה את הסימון בחזרה.
describe('shortage propagation (item_shortage_status)', () => {
  let app, db, cleanup, warehouseToken, managerToken;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'wh1', role: 'warehouse' });
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
    warehouseToken = await loginAs(request, app, 'wh1');
    managerToken = await loginAs(request, app, 'manager1');
  });

  function seedItem(orderKey, lineNo, itemCode, { pickStatus = null, checked = 0, autoMissing = 0 } = {}) {
    db.prepare(`
      INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, pick_status, qty_picked, checked, auto_missing)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(orderKey, lineNo, itemCode, `שם ${itemCode}`, pickStatus, pickStatus ? 0 : null, checked, autoMissing);
  }

  it('finish-check on an order with a surviving "missing" line propagates it to unpicked lines in other orders', async () => {
    seedOrder(db, { orderKey: '3|0|1', orderNum: 1, status: 'ready_for_check' });
    seedItem('3|0|1', 1, 'SKU1', { pickStatus: 'missing' });

    seedOrder(db, { orderKey: '3|0|2', orderNum: 2, status: 'waiting_pick' });
    seedItem('3|0|2', 1, 'SKU1'); // עוד לא לוקטה

    const res = await request(app)
      .post('/api/orders/3%7C0%7C1/finish-check')
      .set('Authorization', `Bearer ${warehouseToken}`)
      .send({});
    expect(res.status).toBe(200);

    const other = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = 1').get('3|0|2');
    expect(other.pick_status).toBe('missing');
    expect(other.auto_missing).toBe(1);

    const shortage = db.prepare('SELECT * FROM item_shortage_status WHERE item_code = ?').get('SKU1');
    expect(shortage).toBeTruthy();
  });

  it('does not overwrite a line that was already picked in another order', async () => {
    seedOrder(db, { orderKey: '3|0|3', orderNum: 3, status: 'ready_for_check' });
    seedItem('3|0|3', 1, 'SKU2', { pickStatus: 'missing' });

    seedOrder(db, { orderKey: '3|0|4', orderNum: 4, status: 'ready_for_check' });
    seedItem('3|0|4', 1, 'SKU2', { pickStatus: 'picked', checked: 1 });

    await request(app).post('/api/orders/3%7C0%7C3/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});

    const other = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = 1').get('3|0|4');
    expect(other.pick_status).toBe('picked'); // לא נדרס
    expect(other.auto_missing).toBe(0);
  });

  it('a line the checker corrected back to found does not propagate as a shortage', async () => {
    seedOrder(db, { orderKey: '3|0|5', orderNum: 5, status: 'ready_for_check' });
    seedItem('3|0|5', 1, 'SKU3', { pickStatus: 'picked', checked: 1 }); // תוקן ע"י הבודק, כבר לא missing

    seedOrder(db, { orderKey: '3|0|6', orderNum: 6, status: 'waiting_pick' });
    seedItem('3|0|6', 1, 'SKU3');

    await request(app).post('/api/orders/3%7C0%7C5/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});

    const other = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = 1').get('3|0|6');
    expect(other.pick_status).toBeNull();
    const shortage = db.prepare('SELECT * FROM item_shortage_status WHERE item_code = ?').get('SKU3');
    expect(shortage).toBeUndefined();
  });

  describe('GET /inventory/shorted-items + clear', () => {
    it('lists a confirmed shortage with the count of affected unpicked lines', async () => {
      seedOrder(db, { orderKey: '3|0|7', orderNum: 7, status: 'ready_for_check' });
      seedItem('3|0|7', 1, 'SKU4', { pickStatus: 'missing' });
      seedOrder(db, { orderKey: '3|0|8', orderNum: 8, status: 'waiting_pick' });
      seedItem('3|0|8', 1, 'SKU4');
      seedOrder(db, { orderKey: '3|0|9', orderNum: 9, status: 'waiting_pick' });
      seedItem('3|0|9', 1, 'SKU4');

      await request(app).post('/api/orders/3%7C0%7C7/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});

      const res = await request(app).get('/api/inventory/shorted-items').set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      const entry = res.body.items.find((i) => i.item_code === 'SKU4');
      expect(entry.affected_orders).toBe(2);
    });

    it('clearing a shorted item resets auto-marked lines back to untouched', async () => {
      seedOrder(db, { orderKey: '3|0|10', orderNum: 10, status: 'ready_for_check' });
      seedItem('3|0|10', 1, 'SKU5', { pickStatus: 'missing' });
      seedOrder(db, { orderKey: '3|0|11', orderNum: 11, status: 'waiting_pick' });
      seedItem('3|0|11', 1, 'SKU5');

      await request(app).post('/api/orders/3%7C0%7C10/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});

      const clearRes = await request(app)
        .post('/api/inventory/shorted-items/SKU5/clear')
        .set('Authorization', `Bearer ${managerToken}`);
      expect(clearRes.status).toBe(200);

      const line = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = 1').get('3|0|11');
      expect(line.pick_status).toBeNull();
      expect(line.auto_missing).toBe(0);

      const shortage = db.prepare('SELECT * FROM item_shortage_status WHERE item_code = ?').get('SKU5');
      expect(shortage).toBeUndefined();
    });

    it('clearing does not touch a line the picker already handled themselves after the auto-mark', async () => {
      seedOrder(db, { orderKey: '3|0|12', orderNum: 12, status: 'ready_for_check' });
      seedItem('3|0|12', 1, 'SKU6', { pickStatus: 'missing' });
      seedOrder(db, { orderKey: '3|0|13', orderNum: 13, status: 'picking' });
      seedItem('3|0|13', 1, 'SKU6');

      await request(app).post('/api/orders/3%7C0%7C12/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});

      // המלקט מוצא את הפריט בפועל ומתקן ידנית
      const pickRes = await request(app)
        .post('/api/orders/3%7C0%7C13/items/1/pick')
        .set('Authorization', `Bearer ${warehouseToken}`)
        .send({ qtyPicked: 1, pickStatus: 'picked' });
      expect(pickRes.status).toBe(200);

      await request(app).post('/api/inventory/shorted-items/SKU6/clear').set('Authorization', `Bearer ${managerToken}`);

      const line = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ? AND line_no = 1').get('3|0|13');
      expect(line.pick_status).toBe('picked'); // לא נדרס ע"י הניקוי
    });

    it('agents cannot reach the shorted-items screen (role gate)', async () => {
      seedUser(db, { username: 'agent1', role: 'agent' });
      const agentToken = await loginAs(request, app, 'agent1');
      const res = await request(app).get('/api/inventory/shorted-items').set('Authorization', `Bearer ${agentToken}`);
      expect(res.status).toBe(403);
    });
  });
});
