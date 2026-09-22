const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// בדיקה נשארת אופציונלית: "דלג על שלב הבדיקה" (skip-check) זמין תמיד
// ב-ready_for_check, אבל חסום — בדיוק כמו finish-check הרגיל — כל עוד יש
// שורה שנלקטה ידנית (לא בסריקת ברקוד) שעוד לא אושרה ע"י מנהל. ר' בקשת
// דניאל 22.9.2026.
describe('skip-check + manager approval for manually-picked lines', () => {
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

  function insertLine(orderKey, lineNo, extra = {}) {
    const base = {
      item_code: `A${lineNo}`, item_name: 'פריט', quantity: 1, price: 10,
      pick_status: 'picked', qty_picked: 1, checked: 0, picked_via: null,
      manual_pick_approved_by: null, manual_pick_approved_at: null,
      ...extra,
    };
    db.prepare(`
      INSERT INTO order_items_cache
        (order_key, line_no, item_code, item_name, quantity, price, pick_status, qty_picked, checked,
         picked_via, manual_pick_approved_by, manual_pick_approved_at)
      VALUES (@order_key, @line_no, @item_code, @item_name, @quantity, @price, @pick_status, @qty_picked, @checked,
              @picked_via, @manual_pick_approved_by, @manual_pick_approved_at)
    `).run({ order_key: orderKey, line_no: lineNo, ...base });
  }

  it('blocks skip-check while a manually-picked line is unapproved, with a dedicated error code', async () => {
    seedOrder(db, { orderKey: '3|0|10', orderNum: 10, status: 'ready_for_check' });
    insertLine('3|0|10', 1, { picked_via: 'scan' });
    insertLine('3|0|10', 2, { picked_via: 'manual' });

    const res = await request(app).post('/api/orders/3%7C0%7C10/skip-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('manual_pick_pending');

    const order = await request(app).get('/api/orders/3%7C0%7C10').set('Authorization', `Bearer ${warehouseToken}`);
    expect(order.body.order.status).toBe('ready_for_check'); // לא זזה
  });

  it('blocks the normal finish-check (all lines checked=1) the same way', async () => {
    seedOrder(db, { orderKey: '3|0|11', orderNum: 11, status: 'ready_for_check' });
    insertLine('3|0|11', 1, { picked_via: 'manual', checked: 1 });

    const res = await request(app).post('/api/orders/3%7C0%7C11/finish-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('manual_pick_pending');
  });

  it('lets skip-check through immediately when every line was scanned (no manual lines at all)', async () => {
    seedOrder(db, { orderKey: '3|0|12', orderNum: 12, status: 'ready_for_check' });
    insertLine('3|0|12', 1, { picked_via: 'scan' });
    insertLine('3|0|12', 2, { picked_via: 'scan' });

    const res = await request(app).post('/api/orders/3%7C0%7C12/skip-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.state.status).toBe('ready_to_pack');
  });

  it('a manual "missing" line never needs approval', async () => {
    seedOrder(db, { orderKey: '3|0|13', orderNum: 13, status: 'ready_for_check' });
    insertLine('3|0|13', 1, { picked_via: 'manual', pick_status: 'missing', qty_picked: 0 });

    const res = await request(app).post('/api/orders/3%7C0%7C13/skip-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(200);
  });

  it('approve-manual-pick is manager-only, and releases skip-check once approved', async () => {
    seedOrder(db, { orderKey: '3|0|14', orderNum: 14, status: 'ready_for_check' });
    insertLine('3|0|14', 1, { picked_via: 'manual' });

    const forbidden = await request(app)
      .post('/api/orders/3%7C0%7C14/items/1/approve-manual-pick')
      .set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(forbidden.status).toBe(403);

    const approved = await request(app)
      .post('/api/orders/3%7C0%7C14/items/1/approve-manual-pick')
      .set('Authorization', `Bearer ${managerToken}`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.item.manual_pick_approved_by).toBeTruthy();
    expect(approved.body.item.manual_pick_approved_at).toBeTruthy();

    const res = await request(app).post('/api/orders/3%7C0%7C14/skip-check').set('Authorization', `Bearer ${warehouseToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.state.status).toBe('ready_to_pack');
  });

  it('GET /manual-pick-approvals/pending is manager-only and lists exactly the unapproved manual lines', async () => {
    seedOrder(db, { orderKey: '3|0|15', orderNum: 15, status: 'ready_for_check' });
    insertLine('3|0|15', 1, { picked_via: 'manual' }); // pending
    insertLine('3|0|15', 2, { picked_via: 'scan' }); // not manual, excluded
    insertLine('3|0|15', 3, { picked_via: 'manual', manual_pick_approved_by: 'someone', manual_pick_approved_at: '2026-01-01 00:00:00' }); // already approved, excluded

    const forbidden = await request(app).get('/api/manual-pick-approvals/pending').set('Authorization', `Bearer ${warehouseToken}`);
    expect(forbidden.status).toBe(403);

    const res = await request(app).get('/api/manual-pick-approvals/pending').set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const forThisOrder = res.body.approvals.filter((a) => a.order_key === '3|0|15');
    expect(forThisOrder).toHaveLength(1);
    expect(forThisOrder[0].line_no).toBe(1);
  });

  it('re-picking a line manually after approval resets it back to pending', async () => {
    seedOrder(db, { orderKey: '3|0|16', orderNum: 16, status: 'picking' });
    insertLine('3|0|16', 1, {
      picked_via: 'manual', manual_pick_approved_by: 'someone', manual_pick_approved_at: '2026-01-01 00:00:00',
    });

    const res = await request(app)
      .post('/api/orders/3%7C0%7C16/items/1/pick')
      .set('Authorization', `Bearer ${warehouseToken}`)
      .send({ qtyPicked: 1, pickStatus: 'picked' });
    expect(res.status).toBe(200);
    expect(res.body.item.picked_via).toBe('manual');
    expect(res.body.item.manual_pick_approved_at).toBeFalsy();
  });
});
