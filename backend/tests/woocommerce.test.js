const request = require('supertest');
const { createTestApp, seedUser, loginAs, resetDb } = require('./helpers/testApp');

// מכסה את מה שביקש דניאל (16.9.2026): שדה ניהול חיבור ל-WooCommerce אצל
// system_admin בלבד, ושירות קריאה-בלבד (GET) לסטטוס מוצר לפי SKU - לא כותב
// כלום באתר.
describe('woocommerce integration settings + product status', () => {
  let app, db, cleanup, adminToken, managerToken;
  let originalFetch;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
    originalFetch = global.fetch;
  });

  afterAll(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'admin1', role: 'system_admin' });
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
    adminToken = await loginAs(request, app, 'admin1');
    managerToken = await loginAs(request, app, 'manager1');
    global.fetch = originalFetch;
  });

  it('starts unconfigured', async () => {
    const res = await request(app).get('/api/admin/woocommerce-settings').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.storeUrl).toBeNull();
  });

  it('blocks warehouse_manager from reading or writing the settings (system_admin only)', async () => {
    const getRes = await request(app).get('/api/admin/woocommerce-settings').set('Authorization', `Bearer ${managerToken}`);
    expect(getRes.status).toBe(403);
    const postRes = await request(app)
      .post('/api/admin/woocommerce-settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ storeUrl: 'https://shop.example.com', consumerKey: 'ck_x', consumerSecret: 'cs_y' });
    expect(postRes.status).toBe(403);
  });

  it('saves settings and returns them masked, never in the clear', async () => {
    const saveRes = await request(app)
      .post('/api/admin/woocommerce-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ storeUrl: 'https://shop.example.com/', consumerKey: 'ck_1234567890', consumerSecret: 'cs_abcdefghij' });
    expect(saveRes.status).toBe(200);
    expect(saveRes.body.storeUrl).toBe('https://shop.example.com'); // סלאש סוגר הוסר
    expect(saveRes.body.configured).toBe(true);
    expect(saveRes.body.consumerKeyMasked).toBe('*'.repeat(9) + '7890');
    expect(saveRes.body.consumerKeyMasked).not.toContain('ck_123456');
  });

  it('an empty consumerKey/consumerSecret on a later save keeps the existing secret', async () => {
    await request(app)
      .post('/api/admin/woocommerce-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ storeUrl: 'https://shop.example.com', consumerKey: 'ck_1234567890', consumerSecret: 'cs_abcdefghij' });

    const secondSave = await request(app)
      .post('/api/admin/woocommerce-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ storeUrl: 'https://new-shop.example.com', consumerKey: '', consumerSecret: '' });

    expect(secondSave.status).toBe(200);
    expect(secondSave.body.storeUrl).toBe('https://new-shop.example.com');
    expect(secondSave.body.configured).toBe(true); // הסודות הישנים נשמרו
    expect(secondSave.body.consumerKeyMasked).toBe('*'.repeat(9) + '7890');
  });

  it('test-connection reports not configured when nothing was saved', async () => {
    const res = await request(app).post('/api/admin/woocommerce-settings/test').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });

  it('test-connection reports ok when the mocked WooCommerce API responds 200', async () => {
    await request(app)
      .post('/api/admin/woocommerce-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ storeUrl: 'https://shop.example.com', consumerKey: 'ck_1234567890', consumerSecret: 'cs_abcdefghij' });

    global.fetch = async (url) => {
      expect(String(url)).toContain('/wp-json/wc/v3/products');
      return { ok: true, status: 200, json: async () => [] };
    };

    const res = await request(app).post('/api/admin/woocommerce-settings/test').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('test-connection surfaces a network failure as ok:false', async () => {
    await request(app)
      .post('/api/admin/woocommerce-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ storeUrl: 'https://shop.example.com', consumerKey: 'ck_1234567890', consumerSecret: 'cs_abcdefghij' });

    global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };

    const res = await request(app).post('/api/admin/woocommerce-settings/test').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/ENOTFOUND/);
  });

  it('product-status is 400 when WooCommerce is not configured yet', async () => {
    const res = await request(app)
      .get('/api/woocommerce/product-status?sku=ABC-1')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(400);
  });

  it('product-status returns found:true with the product fields for a warehouse_manager', async () => {
    await request(app)
      .post('/api/admin/woocommerce-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ storeUrl: 'https://shop.example.com', consumerKey: 'ck_1234567890', consumerSecret: 'cs_abcdefghij' });

    global.fetch = async (url) => {
      expect(String(url)).toContain('sku=ABC-1');
      return {
        ok: true, status: 200,
        json: async () => [{ id: 42, name: 'מוצר לדוגמה', price: '19.90', stock_status: 'outofstock', permalink: 'https://shop.example.com/p/42' }],
      };
    };

    const res = await request(app)
      .get('/api/woocommerce/product-status?sku=ABC-1')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ found: true, sku: 'ABC-1', stock_status: 'outofstock', price: '19.90' });
  });

  it('product-status returns found:false when no product matches the SKU', async () => {
    await request(app)
      .post('/api/admin/woocommerce-settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ storeUrl: 'https://shop.example.com', consumerKey: 'ck_1234567890', consumerSecret: 'cs_abcdefghij' });

    global.fetch = async () => ({ ok: true, status: 200, json: async () => [] });

    const res = await request(app)
      .get('/api/woocommerce/product-status?sku=NOPE')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false, sku: 'NOPE' });
  });

  it('an agent cannot reach product-status (role gate)', async () => {
    seedUser(db, { username: 'agent1', role: 'agent' });
    const agentToken = await loginAs(request, app, 'agent1');
    const res = await request(app)
      .get('/api/woocommerce/product-status?sku=ABC-1')
      .set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });
});
