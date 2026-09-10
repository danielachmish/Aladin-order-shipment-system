const crypto = require('crypto');
const { db } = require('./db');
const { seedOrders } = require('./sigmaBridgeMock');
const { sigma: sigmaCfg } = require('./config');

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function upsertUser({ user_id, username, display_name, password, role }) {
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return;
  db.prepare(`
    INSERT INTO users (user_id, username, display_name, password, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(user_id, username, display_name, password, role);
}

function run() {
  // MOCK: סיסמאות טקסט-גלוי לצורך דמו בלבד. ר' auth.js.
  upsertUser({ user_id: uid('u'), username: 'agent1', display_name: 'נועה כהן (סוכנת)', password: '1234', role: 'agent' });
  upsertUser({ user_id: uid('u'), username: 'agent2', display_name: 'איתי לוי (סוכן)', password: '1234', role: 'agent' });
  upsertUser({ user_id: uid('u'), username: 'warehouse', display_name: 'מחסן', password: '1234', role: 'warehouse' });
  upsertUser({ user_id: uid('u'), username: 'manager', display_name: 'דנה (מנהלת מחסן)', password: '1234', role: 'warehouse_manager' });
  upsertUser({ user_id: uid('u'), username: 'admin', display_name: 'מנהל מערכת', password: '1234', role: 'system_admin' });

  if (sigmaCfg.enabled || sigmaCfg.bridgeSecret) {
    console.log('Sigma מחובר (pull או bridge) — מדלג על הזמנות דמו, ה-Sigma Bridge האמיתי יסנכרן הזמנות אמיתיות.');
  } else {
    seedOrders(db);
  }

  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('agent_view_scope', 'all')`).run();

  console.log('Seed complete.');
  console.log('Users: agent1/1234, agent2/1234, warehouse/1234, manager/1234, admin/1234');
}

run();
