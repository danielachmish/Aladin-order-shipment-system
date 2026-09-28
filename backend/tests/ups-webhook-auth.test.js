const request = require('supertest');
const { createTestApp, resetDb } = require('./helpers/testApp');

// אימות ה-Webhook של UPS: Bearer או רשימת IP מורשים (UPS ישראל לא שולחים אימות).
describe('UPS webhook auth', () => {
  let app, db, cleanup, upsCfg;
  const body = { trackNo: '1Z999', statusCode: 9, ref1: '' };

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
    // כמו ב-server.js: X-Forwarded-For נחשב רק כשהחיבור מגיע מ-loopback (ה-api.php)
    app.set('trust proxy', 'loopback');
    upsCfg = require('../src/config').ups;
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    resetDb(db);
    upsCfg.webhookBearerSecret = null;
    upsCfg.webhookAllowedIps = [];
    delete process.env.ALLOW_UNAUTHENTICATED_UPS_WEBHOOK;
  });

  it('is blocked when neither a secret nor an IP list is configured', async () => {
    const res = await request(app).post('/api/webhooks/ups').send(body);
    expect(res.status).toBe(503);
    expect(res.body.returnCode).toBe(0);
  });

  it('accepts a request from an allowed UPS IP without any Authorization header', async () => {
    upsCfg.webhookAllowedIps = ['212.199.66.34', '199.203.87.37', '141.226.184.123'];
    const res = await request(app).post('/api/webhooks/ups')
      .set('X-Forwarded-For', '199.203.87.37')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trackNo: '1Z999', returnCode: 1, errorCode: 0, errorMessage: '' });
    expect(db.prepare('SELECT status FROM shipments WHERE track_no = ?').get('1Z999').status).toBe('ship_sorting');
  });

  it('rejects a request from an IP that is not on the list, and reports the IP it saw', async () => {
    upsCfg.webhookAllowedIps = ['212.199.66.34'];
    const res = await request(app).post('/api/webhooks/ups')
      .set('X-Forwarded-For', '8.8.8.8')
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.returnCode).toBe(0);
    expect(res.body.errorMessage).toContain('8.8.8.8');
    expect(db.prepare('SELECT COUNT(*) c FROM shipments').get().c).toBe(0);
  });

  it('uses the address set by the local proxy, not one the caller prepended', async () => {
    upsCfg.webhookAllowedIps = ['212.199.66.34'];
    // המתקשר ניסה להוסיף כתובת של UPS; ה-proxy המקומי הוסיף את הכתובת האמיתית בסוף
    const res = await request(app).post('/api/webhooks/ups')
      .set('X-Forwarded-For', '212.199.66.34, 8.8.8.8')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('still accepts a valid Bearer from any IP when a secret is configured', async () => {
    upsCfg.webhookBearerSecret = 's3cret';
    upsCfg.webhookAllowedIps = ['212.199.66.34'];
    const ok = await request(app).post('/api/webhooks/ups')
      .set('X-Forwarded-For', '8.8.8.8')
      .set('Authorization', 'Bearer s3cret')
      .send(body);
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/api/webhooks/ups')
      .set('X-Forwarded-For', '8.8.8.8')
      .set('Authorization', 'Bearer wrong')
      .send(body);
    expect(bad.status).toBe(401);
  });

  it('ignores the dev bypass flag once an IP list is configured', async () => {
    process.env.ALLOW_UNAUTHENTICATED_UPS_WEBHOOK = 'true';
    upsCfg.webhookAllowedIps = ['212.199.66.34'];
    const res = await request(app).post('/api/webhooks/ups')
      .set('X-Forwarded-For', '8.8.8.8')
      .send(body);
    expect(res.status).toBe(401);
  });
});
