const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// מכסה את ה-scoping לפי סוכן שנדון בייעוץ: agent_view_scope='own' חייב להראות
// לכל סוכן רק את ההזמנות שלו - הן לפי agent_id והן לפי ההתאמה הטקסטואלית
// (sigma_agent_name) שסומנה כשבירה, כדי שנדע אם היא נשברת בעתיד.
describe('agent view scoping', () => {
  let app, db, cleanup;
  let agent1Id, agent1Token, agent2Token;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
  });

  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    agent1Id = seedUser(db, { username: 'agent1', role: 'agent', displayName: 'נועה כהן' });
    seedUser(db, { username: 'agent2', role: 'agent', displayName: 'איתי לוי' });
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });

    // הזמנה ששייכת ל-agent1 דרך agent_id אמיתי
    seedOrder(db, { orderKey: '3|0|1', orderNum: 1, agentId: agent1Id });
    // הזמנה ששייכת ל-agent2 רק דרך התאמת שם חופשי מסיגמא (אין agent_id)
    seedOrder(db, { orderKey: '3|0|2', orderNum: 2, sigmaAgentName: 'איתי לוי' });
    // הזמנה שלא שייכת לאף אחד מהם
    seedOrder(db, { orderKey: '3|0|3', orderNum: 3 });

    const managerToken = await loginAs(request, app, 'manager1');
    await request(app)
      .post('/api/settings/agent-view-scope')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ scope: 'own' });

    agent1Token = await loginAs(request, app, 'agent1');
    agent2Token = await loginAs(request, app, 'agent2');
  });

  it('agent sees only their own orders in the list when scope=own', async () => {
    const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${agent1Token}`);
    expect(res.status).toBe(200);
    const keys = res.body.orders.map((o) => o.order_key);
    expect(keys).toEqual(['3|0|1']);
  });

  it('agent matched by free-text sigma_agent_name also sees their order', async () => {
    const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${agent2Token}`);
    expect(res.status).toBe(200);
    const keys = res.body.orders.map((o) => o.order_key);
    expect(keys).toEqual(['3|0|2']);
  });

  it("blocks an agent from opening another agent's order detail", async () => {
    const res = await request(app).get('/api/orders/3%7C0%7C2').set('Authorization', `Bearer ${agent1Token}`);
    expect(res.status).toBe(403);
  });

  it('allows an agent to open their own order detail', async () => {
    const res = await request(app).get('/api/orders/3%7C0%7C1').set('Authorization', `Bearer ${agent1Token}`);
    expect(res.status).toBe(200);
    expect(res.body.order.order_key).toBe('3|0|1');
  });

  it('a warehouse_manager is never restricted by agent scoping', async () => {
    const managerToken = await loginAs(request, app, 'manager1');
    const res = await request(app).get('/api/orders').set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(3);
  });
});
