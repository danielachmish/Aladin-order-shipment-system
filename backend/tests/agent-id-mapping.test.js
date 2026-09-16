const request = require('supertest');
const { createTestApp, seedUser, loginAs, resetDb } = require('./helpers/testApp');

// מכסה את הייעוץ 17.9.2026, נושא 6: מיפוי אמיתי סוכן->יוזר (users.sigma_agent_id,
// מאומת מול t_agents אמיתי) שמחליף את ההתאמה השברירית לפי שם, ואת מסך החוסרים
// הפרטי לסוכן שנבנה עליו.
describe('real agent_id mapping + agent-scoped shortages', () => {
  let app, db, cleanup, sigmaIngest;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
    // נדרש להיטען רק אחרי createTestApp (שקובע DB_PATH) כדי לא להתחבר ל-DB הלא-נכון
    sigmaIngest = require('../src/sigmaIngest');
  });

  afterAll(() => cleanup());

  beforeEach(() => resetDb(db));

  describe('PUT /users/:id sigma_agent_id', () => {
    it('a manager can set an agent user\'s sigma_agent_id', async () => {
      seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
      const agentId = seedUser(db, { username: 'agent1', role: 'agent' });
      const token = await loginAs(request, app, 'manager1');

      const res = await request(app)
        .put(`/api/users/${agentId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ sigma_agent_id: 800012 });
      expect(res.status).toBe(200);
      expect(res.body.user.sigma_agent_id).toBe(800012);
    });

    it('omitting sigma_agent_id leaves the existing value untouched', async () => {
      seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
      const agentId = seedUser(db, { username: 'agent1', role: 'agent' });
      const token = await loginAs(request, app, 'manager1');
      await request(app).put(`/api/users/${agentId}`).set('Authorization', `Bearer ${token}`).send({ sigma_agent_id: 800012 });

      const res = await request(app).put(`/api/users/${agentId}`).set('Authorization', `Bearer ${token}`).send({ display_name: 'שם חדש' });
      expect(res.body.user.sigma_agent_id).toBe(800012);
    });
  });

  describe('sigmaIngest.ingestOrders auto-resolves agent_id from sigma_agent_id', () => {
    it('assigns the real agent_id when the incoming order carries a mapped sigmaAgentId', () => {
      const agentId = seedUser(db, { username: 'agent1', role: 'agent' });
      db.prepare('UPDATE users SET sigma_agent_id = ? WHERE user_id = ?').run(800012, agentId);

      sigmaIngest.ingestOrders([{
        companyId: 3, sidra: 0, orderNum: 9001, customerName: 'לקוח בדיקה',
        sigmaAgentId: 800012, agentName: 'איזה שם שיהיה',
        items: [{ lineNo: 1, itemCode: 'X1', itemName: 'פריט', quantity: 1, price: 10 }],
      }]);

      const state = db.prepare('SELECT agent_id FROM workflow_state WHERE order_key = ?').get('3|0|9001');
      expect(state.agent_id).toBe(agentId);
    });

    it('leaves agent_id null when sigmaAgentId has no mapped user (no crash, no wrong assignment)', () => {
      sigmaIngest.ingestOrders([{
        companyId: 3, sidra: 0, orderNum: 9002, customerName: 'לקוח בדיקה',
        sigmaAgentId: 999999, items: [],
      }]);
      const state = db.prepare('SELECT agent_id FROM workflow_state WHERE order_key = ?').get('3|0|9002');
      expect(state.agent_id).toBeNull();
    });

    it('backfills agent_id on a re-sync once the mapping becomes known after the order already existed', () => {
      sigmaIngest.ingestOrders([{ companyId: 3, sidra: 0, orderNum: 9003, customerName: 'לקוח', items: [] }]);
      let state = db.prepare('SELECT agent_id FROM workflow_state WHERE order_key = ?').get('3|0|9003');
      expect(state.agent_id).toBeNull();

      const agentId = seedUser(db, { username: 'agent2', role: 'agent' });
      db.prepare('UPDATE users SET sigma_agent_id = ? WHERE user_id = ?').run(800099, agentId);
      sigmaIngest.ingestOrders([{ companyId: 3, sidra: 0, orderNum: 9003, customerName: 'לקוח', sigmaAgentId: 800099, items: [] }]);

      state = db.prepare('SELECT agent_id FROM workflow_state WHERE order_key = ?').get('3|0|9003');
      expect(state.agent_id).toBe(agentId);
    });
  });

  describe('GET /inventory/my-shortages', () => {
    it('an agent only sees shortages from their own orders (by real agent_id)', async () => {
      const agentAId = seedUser(db, { username: 'agentA', role: 'agent' });
      seedUser(db, { username: 'agentB', role: 'agent' });
      db.prepare(`
        INSERT INTO orders_cache (order_key, company_id, sidra, order_num, customer_name, synced_at)
        VALUES ('3|0|1', 3, 0, 1, 'לקוח א', datetime('now'))
      `).run();
      db.prepare(`INSERT INTO workflow_state (order_key, status, agent_id) VALUES ('3|0|1', 'ready_for_check', ?)`).run(agentAId);
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, pick_status, qty_picked, pick_marked_at)
        VALUES ('3|0|1', 1, 'SKU-A', 'מוצר של A', 2, 'missing', 0, datetime('now'))
      `).run();

      db.prepare(`
        INSERT INTO orders_cache (order_key, company_id, sidra, order_num, customer_name, synced_at)
        VALUES ('3|0|2', 3, 0, 2, 'לקוח ב', datetime('now'))
      `).run();
      db.prepare(`INSERT INTO workflow_state (order_key, status, agent_id) VALUES ('3|0|2', 'ready_for_check', NULL)`).run();
      db.prepare(`
        INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, pick_status, qty_picked, pick_marked_at)
        VALUES ('3|0|2', 1, 'SKU-B', 'מוצר של B', 1, 'missing', 0, datetime('now'))
      `).run();

      const tokenA = await loginAs(request, app, 'agentA');
      const res = await request(app).get('/api/inventory/my-shortages').set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].item_code).toBe('SKU-A');
    });

    it('a warehouse_manager cannot use the agent-only endpoint (role gate the other way)', async () => {
      seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
      const token = await loginAs(request, app, 'manager1');
      const res = await request(app).get('/api/inventory/my-shortages').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  });
});
