const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// מכסה את התוצאה של הבדיקה מול Sigma האמיתית (16.9.2026, נושא 5): pritim.FLinkToMaazni
// -> maazni.name הוא ה-FK האמיתי לספק. הבדיקות האלה מכסות את הקליטה מהגשר
// (bridgeSecret) ואת שילוב הספק במסכי החוסרים - לא את הקישור עצמו ל-Sigma,
// שנשאר בצד bridge/sync.js.
describe('item suppliers (shortages by supplier)', () => {
  let app, db, cleanup, managerToken;

  beforeAll(() => {
    process.env.SIGMA_BRIDGE_SECRET = 'test-bridge-secret';
    ({ app, db, cleanup } = createTestApp());
  });

  afterAll(() => {
    cleanup();
    delete process.env.SIGMA_BRIDGE_SECRET;
  });

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
    managerToken = await loginAs(request, app, 'manager1');
  });

  function seedMissingItem(orderKey, orderNum, lineNo, itemCode, itemName, quantity) {
    seedOrder(db, { orderKey, orderNum, status: 'ready_for_check' });
    db.prepare(`
      INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, qty_picked, pick_status, pick_marked_at)
      VALUES (?, ?, ?, ?, ?, 0, 'missing', datetime('now'))
    `).run(orderKey, lineNo, itemCode, itemName, quantity);
  }

  describe('POST /admin/sigma-sync/suppliers (bridge push)', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await request(app).post('/api/admin/sigma-sync/suppliers').send({ items: [] });
      expect(res.status).toBe(401);
    });

    it('rejects the wrong bridge secret', async () => {
      const res = await request(app)
        .post('/api/admin/sigma-sync/suppliers')
        .set('Authorization', 'Bearer wrong-secret')
        .send({ items: [] });
      expect(res.status).toBe(401);
    });

    it('upserts item-supplier mappings with the correct secret', async () => {
      const res = await request(app)
        .post('/api/admin/sigma-sync/suppliers')
        .set('Authorization', 'Bearer test-bridge-secret')
        .send({ items: [{ itemCode: '106013', supplierId: 800504, supplierName: 'אנביטק גרופ בע"מ ( נטביט' }] });
      expect(res.status).toBe(200);
      expect(res.body.received).toBe(1);

      const row = db.prepare('SELECT * FROM item_suppliers WHERE item_code = ?').get('106013');
      expect(row.supplier_id).toBe(800504);
      expect(row.supplier_name).toBe('אנביטק גרופ בע"מ ( נטביט');
    });

    it('a second push updates the existing mapping instead of duplicating', async () => {
      await request(app)
        .post('/api/admin/sigma-sync/suppliers')
        .set('Authorization', 'Bearer test-bridge-secret')
        .send({ items: [{ itemCode: '106013', supplierId: 800504, supplierName: 'ספק ישן' }] });
      await request(app)
        .post('/api/admin/sigma-sync/suppliers')
        .set('Authorization', 'Bearer test-bridge-secret')
        .send({ items: [{ itemCode: '106013', supplierId: 800999, supplierName: 'ספק חדש' }] });

      const count = db.prepare('SELECT COUNT(*) c FROM item_suppliers WHERE item_code = ?').get('106013').c;
      expect(count).toBe(1);
      const row = db.prepare('SELECT * FROM item_suppliers WHERE item_code = ?').get('106013');
      expect(row.supplier_id).toBe(800999);
      expect(row.supplier_name).toBe('ספק חדש');
    });

    it('skips items with no supplierId rather than erroring', async () => {
      const res = await request(app)
        .post('/api/admin/sigma-sync/suppliers')
        .set('Authorization', 'Bearer test-bridge-secret')
        .send({ items: [{ itemCode: 'NO-SUPPLIER', supplierId: null, supplierName: null }] });
      expect(res.status).toBe(200);
      const row = db.prepare('SELECT * FROM item_suppliers WHERE item_code = ?').get('NO-SUPPLIER');
      expect(row).toBeUndefined();
    });
  });

  describe('GET /inventory/shortages includes supplier info', () => {
    it('attaches supplier_id/supplier_name when a mapping exists', async () => {
      seedMissingItem('3|0|1', 1, 1, '106013', 'כבל HDMI', 5);
      db.prepare(`INSERT INTO item_suppliers (item_code, supplier_id, supplier_name) VALUES (?, ?, ?)`)
        .run('106013', 800504, 'אנביטק גרופ');

      const res = await request(app).get('/api/inventory/shortages').set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      const item = res.body.items.find((i) => i.item_code === '106013');
      expect(item).toMatchObject({ supplier_id: 800504, supplier_name: 'אנביטק גרופ' });
    });

    it('leaves supplier fields null when no mapping is synced yet', async () => {
      seedMissingItem('3|0|2', 2, 1, 'UNMAPPED', 'פריט ללא ספק ידוע', 3);
      const res = await request(app).get('/api/inventory/shortages').set('Authorization', `Bearer ${managerToken}`);
      const item = res.body.items.find((i) => i.item_code === 'UNMAPPED');
      expect(item).toMatchObject({ supplier_id: null, supplier_name: null });
    });
  });

  describe('GET /inventory/shortages-by-supplier', () => {
    it('groups shortages by supplier, with items nested per supplier', async () => {
      seedMissingItem('3|0|3', 3, 1, '106013', 'כבל HDMI', 5);
      seedMissingItem('3|0|4', 4, 1, '107000', 'כבל USB', 2);
      db.prepare(`INSERT INTO item_suppliers (item_code, supplier_id, supplier_name) VALUES (?, ?, ?)`)
        .run('106013', 800504, 'אנביטק גרופ');
      db.prepare(`INSERT INTO item_suppliers (item_code, supplier_id, supplier_name) VALUES (?, ?, ?)`)
        .run('107000', 800504, 'אנביטק גרופ');

      const res = await request(app).get('/api/inventory/shortages-by-supplier').set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.suppliers).toHaveLength(1);
      expect(res.body.suppliers[0]).toMatchObject({ supplier_id: 800504, supplier_name: 'אנביטק גרופ' });
      expect(res.body.suppliers[0].items).toHaveLength(2);
    });

    it('groups items with no known supplier under a separate "unknown" bucket', async () => {
      seedMissingItem('3|0|5', 5, 1, 'UNMAPPED', 'פריט תעלומה', 1);
      const res = await request(app).get('/api/inventory/shortages-by-supplier').set('Authorization', `Bearer ${managerToken}`);
      expect(res.body.suppliers).toHaveLength(1);
      expect(res.body.suppliers[0].supplier_id).toBeNull();
      expect(res.body.suppliers[0].items[0].item_code).toBe('UNMAPPED');
    });

    it('an agent cannot reach the by-supplier view (role gate)', async () => {
      seedUser(db, { username: 'agent1', role: 'agent' });
      const agentToken = await loginAs(request, app, 'agent1');
      const res = await request(app).get('/api/inventory/shortages-by-supplier').set('Authorization', `Bearer ${agentToken}`);
      expect(res.status).toBe(403);
    });
  });
});
