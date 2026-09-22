const request = require('supertest');
const { createTestApp, seedUser, loginAs, resetDb } = require('./helpers/testApp');

describe('auth', () => {
  let app, db, cleanup;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    resetDb(db);
    seedUser(db, { username: 'agent1', role: 'agent' });
    seedUser(db, { username: 'manager1', role: 'warehouse_manager' });
  });

  it('logs in with correct credentials and returns a token + role', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'agent1', password: '1234' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({ name: 'agent1', role: 'agent' });
  });

  it('rejects a wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'agent1', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it('rejects an unknown username', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'ghost', password: '1234' });
    expect(res.status).toBe(401);
  });

  it('blocks a protected route with no token', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('blocks a protected route with a garbage token', async () => {
    const res = await request(app).get('/api/users').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('enforces role checks: an agent cannot reach a warehouse_manager-only route', async () => {
    const token = await loginAs(request, app, 'agent1');
    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows the correct role through', async () => {
    const token = await loginAs(request, app, 'manager1');
    const res = await request(app).get('/api/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users || res.body)).toBe(true);
  });

  // תיקון אבטחה (בקשת דניאל 22.9.2026): סיסמאות לא נשמרות יותר כטקסט גלוי.
  it('migrates a legacy plaintext password to a bcrypt hash on first successful login', async () => {
    const before = db.prepare("SELECT password FROM users WHERE username = 'agent1'").get();
    expect(before.password).toBe('1234'); // seedUser עדיין כותב טקסט גלוי ישירות ל-DB, בכוונה, כדי לבדוק את המעבר

    const res = await request(app).post('/api/auth/login').send({ username: 'agent1', password: '1234' });
    expect(res.status).toBe(200);

    const after = db.prepare("SELECT password FROM users WHERE username = 'agent1'").get();
    expect(after.password).not.toBe('1234');
    expect(after.password).toMatch(/^\$2[aby]\$/);

    // ההתחברות הבאה עובדת מול ה-hash החדש בדיוק כמו קודם
    const res2 = await request(app).post('/api/auth/login').send({ username: 'agent1', password: '1234' });
    expect(res2.status).toBe(200);
  });

  it('stores a hashed password (not plaintext) when an admin creates a new user', async () => {
    const token = await loginAs(request, app, 'manager1');
    await request(app).post('/api/users').set('Authorization', `Bearer ${token}`)
      .send({ username: 'newagent', display_name: 'סוכן חדש', password: 'my-secret', role: 'agent' });

    const stored = db.prepare("SELECT password FROM users WHERE username = 'newagent'").get();
    expect(stored.password).not.toBe('my-secret');
    expect(stored.password).toMatch(/^\$2[aby]\$/);

    const login = await request(app).post('/api/auth/login').send({ username: 'newagent', password: 'my-secret' });
    expect(login.status).toBe(200);
  });
});
