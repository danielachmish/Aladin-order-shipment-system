const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// claimOrder הוא נקודת הכניסה לליקוט - מכסה גם optimistic concurrency (version)
// וגם את שער התפקידים (רק warehouse/warehouse_manager, לא agent).
describe('order claim (start picking)', () => {
  let app, db, cleanup;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    resetDb(db);
    seedUser(db, { username: 'wh1', role: 'warehouse' });
    seedUser(db, { username: 'agent1', role: 'agent' });
    seedOrder(db, { orderKey: '3|0|9001', orderNum: 9001, status: 'waiting_pick' });
  });

  it('a warehouse user can claim a waiting order, moving it to picking', async () => {
    const token = await loginAs(request, app, 'wh1');
    const res = await request(app)
      .post('/api/orders/3%7C0%7C9001/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.state.status).toBe('picking');
    expect(res.body.state.version).toBe(2);
  });

  it('an agent cannot claim an order (role gate)', async () => {
    const token = await loginAs(request, app, 'agent1');
    const res = await request(app)
      .post('/api/orders/3%7C0%7C9001/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('claiming an already-claimed order fails with a clear rule error', async () => {
    const token = await loginAs(request, app, 'wh1');
    await request(app).post('/api/orders/3%7C0%7C9001/claim').set('Authorization', `Bearer ${token}`).send({});
    const second = await request(app)
      .post('/api/orders/3%7C0%7C9001/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(second.status).toBe(400);
  });

  it('rejects a claim with a stale expectedVersion (optimistic concurrency)', async () => {
    const token = await loginAs(request, app, 'wh1');
    const res = await request(app)
      .post('/api/orders/3%7C0%7C9001/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedVersion: 99 });
    expect(res.status).toBe(409);
  });
});
