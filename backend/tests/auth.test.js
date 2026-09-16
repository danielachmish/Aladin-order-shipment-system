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
});
