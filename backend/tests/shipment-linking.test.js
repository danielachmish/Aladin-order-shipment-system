const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// משלוח שלא קושר להזמנה: הסטטוס נשמר ומוצג, נוצרת חריגה, יש הצעות וקישור ידני.
describe('shipment linking', () => {
  let app, db, cleanup, upsCfg, token;

  const webhook = (body) => request(app).post('/api/webhooks/ups').send(body);

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
    upsCfg = require('../src/config').ups;
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    upsCfg.webhookBearerSecret = null;
    upsCfg.webhookAllowedIps = [];
    process.env.ALLOW_UNAUTHENTICATED_UPS_WEBHOOK = 'true';
    seedUser(db, { username: 'mgr', role: 'warehouse_manager' });
    token = await loginAs(request, app, 'mgr');
  });

  afterEach(() => { delete process.env.ALLOW_UNAUTHENTICATED_UPS_WEBHOOK; });

  const openLinkExceptions = () => db.prepare('SELECT * FROM link_exceptions WHERE resolved = 0').all();

  it('keeps and lists the status of a shipment whose ref1 has no order number, and raises one exception', async () => {
    await webhook({ trackNo: 'W1', ref1: 'SH2413002825', ref2: 'יוסי לוי,', serviceLevel: '31', statusCode: 9 });
    await webhook({ trackNo: 'W1', ref1: 'SH2413002825', ref2: 'יוסי לוי,', serviceLevel: '31', statusCode: 10 });

    const res = await request(app).get('/api/shipments').set('Authorization', `Bearer ${token}`);
    const ship = res.body.shipments.find((s) => s.track_no === 'W1');
    expect(ship.status).toBe('ship_out_for_delivery');
    expect(ship.orders).toEqual([]);
    expect(ship).toMatchObject({ ref1: 'SH2413002825', ref2: 'יוסי לוי', service_level: '31' });

    const exc = openLinkExceptions();
    expect(exc).toHaveLength(1);
    expect(exc[0]).toMatchObject({ track_no: 'W1', bad_ref: 'SH2413002825' });
  });

  it('raises an exception for an empty ref1 too', async () => {
    await webhook({ trackNo: 'W2', statusCode: 9 });
    expect(openLinkExceptions()).toHaveLength(1);
  });

  it('suggests the order whose number hides inside ref1, and one with a similar recipient name', async () => {
    seedOrder(db, { orderKey: '3|0|54707', orderNum: 54707, customerName: 'חנות אחרת', status: 'delivered_to_ups' });
    seedOrder(db, { orderKey: '3|0|54712', orderNum: 54712, customerName: 'יוסי לוי בע"מ', status: 'delivered_to_ups' });
    seedOrder(db, { orderKey: '3|0|54800', orderNum: 54800, customerName: 'מישהו שלישי', status: 'waiting_pick' });
    await webhook({ trackNo: 'W3', ref1: 'SH54707', ref2: 'משה כהן', statusCode: 9 });
    await webhook({ trackNo: 'W4', ref1: '', ref2: 'יוסי לוי', statusCode: 9 });

    const s3 = await request(app).get('/api/shipments/W3/link-suggestions').set('Authorization', `Bearer ${token}`);
    expect(s3.status).toBe(200);
    expect(s3.body.suggestions[0].order_key).toBe('3|0|54707');

    const s4 = await request(app).get('/api/shipments/W4/link-suggestions').set('Authorization', `Bearer ${token}`);
    expect(s4.body.suggestions[0].order_key).toBe('3|0|54712');
    expect(s4.body.suggestions.map((s) => s.order_key)).not.toContain('3|0|54800');
  });

  it('links manually by order number, resolves the exception, and later webhooks keep the link', async () => {
    seedOrder(db, { orderKey: '3|0|54707', orderNum: 54707, status: 'delivered_to_ups' });
    await webhook({ trackNo: 'W5', ref1: 'SH54707', statusCode: 9 });

    const link = await request(app).post('/api/shipments/W5/links').set('Authorization', `Bearer ${token}`).send({ orderNum: '54707' });
    expect(link.status).toBe(200);
    expect(openLinkExceptions()).toHaveLength(0);

    // עדכון נוסף עם אותה אסמכתא בעייתית — לא פותח חריגה מחדש, והמסירה סוגרת את ההזמנה
    await webhook({ trackNo: 'W5', ref1: 'SH54707', statusCode: 4, deliveredTime: '2026-09-30T10:00:00' });
    expect(openLinkExceptions()).toHaveLength(0);
    expect(db.prepare('SELECT status FROM workflow_state WHERE order_key = ?').get('3|0|54707').status).toBe('closed');
  });

  it('closes the order right away when linking a shipment that was already delivered', async () => {
    seedOrder(db, { orderKey: '3|0|54707', orderNum: 54707, status: 'delivered_to_ups' });
    await webhook({ trackNo: 'W6', statusCode: 4 });
    const link = await request(app).post('/api/shipments/W6/links').set('Authorization', `Bearer ${token}`).send({ orderNum: 54707 });
    expect(link.body.closed).toBe(true);
    expect(db.prepare('SELECT status FROM workflow_state WHERE order_key = ?').get('3|0|54707').status).toBe('closed');
  });

  it('still records a delivered status when the linked order cannot be closed (addition pending)', async () => {
    seedOrder(db, { orderKey: '3|0|54707', orderNum: 54707, status: 'delivered_to_ups' });
    db.prepare("UPDATE workflow_state SET pending_addition_note = 'תוספת' WHERE order_key = ?").run('3|0|54707');
    const res = await webhook({ trackNo: 'W7', ref1: '54707', statusCode: 4 });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT status FROM shipments WHERE track_no = ?').get('W7').status).toBe('ship_delivered');
    expect(db.prepare('SELECT status FROM workflow_state WHERE order_key = ?').get('3|0|54707').status).toBe('delivered_to_ups');
  });

  it('rejects an unknown order number and lets a manager unlink', async () => {
    seedOrder(db, { orderKey: '3|0|54707', orderNum: 54707, status: 'delivered_to_ups' });
    await webhook({ trackNo: 'W8', ref1: '54707', statusCode: 9 });
    const bad = await request(app).post('/api/shipments/W8/links').set('Authorization', `Bearer ${token}`).send({ orderNum: 99999 });
    expect(bad.status).toBe(400);
    const del = await request(app).delete(`/api/shipments/W8/links/${encodeURIComponent('3|0|54707')}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM order_shipments').get().c).toBe(0);
  });

  it('forbids linking for non-managers', async () => {
    seedUser(db, { username: 'wh', role: 'warehouse' });
    const whToken = await loginAs(request, app, 'wh');
    await webhook({ trackNo: 'W9', statusCode: 9 });
    const res = await request(app).post('/api/shipments/W9/links').set('Authorization', `Bearer ${whToken}`).send({ orderNum: 1 });
    expect(res.status).toBe(403);
  });

  it('flags orders handed to UPS over a day ago that never got a shipment', async () => {
    seedOrder(db, { orderKey: '3|0|1', orderNum: 1, status: 'delivered_to_ups' });
    seedOrder(db, { orderKey: '3|0|2', orderNum: 2, status: 'delivered_to_ups' });
    seedOrder(db, { orderKey: '3|0|3', orderNum: 3, status: 'delivered_to_ups' });
    const ev = db.prepare(`INSERT INTO workflow_events (event_id, order_key, from_status, to_status, created_at) VALUES (?, ?, 'waiting_pickup', 'delivered_to_ups', datetime('now', ?))`);
    ev.run('e1', '3|0|1', '-30 hours'); // ישנה, בלי משלוח -> חריגה
    ev.run('e2', '3|0|2', '-2 hours'); // טרייה -> עוד לא
    ev.run('e3', '3|0|3', '-30 hours'); // ישנה, אבל יש משלוח
    await webhook({ trackNo: 'W10', ref1: '3', statusCode: 9 });

    const res = await request(app).get('/api/exceptions').set('Authorization', `Bearer ${token}`);
    expect(res.body.ordersWithoutShipment.map((o) => o.order_key)).toEqual(['3|0|1']);
  });
});
