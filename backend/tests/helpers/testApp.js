// בונה אפליקציית Express מבודדת לבדיקות, על DB זמני ייחודי (SQLite קובץ ב-tmp) —
// לא נוגע ב-aladin.db האמיתי של הפיתוח, ולא מפעיל polling/websocket אמיתיים
// (server.js לא נטען כאן בכלל, רק routes.js כמו שהוא נטען מתוך express).
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

function createTestApp() {
  const dbPath = path.join(os.tmpdir(), `aladin-test-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

  // חשוב: לדרוש את המודולים האלה רק אחרי שהוגדר DB_PATH, כדי ש-db.js ייפתח
  // מול הקובץ הזמני הנכון (vitest מבודד את registry המודולים בין קבצי בדיקה).
  const { db } = require('../../src/db');
  const routes = require('../../src/routes');

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api', routes);

  const cleanup = () => {
    try { db.close(); } catch (_) { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch (_) { /* ignore */ }
    }
  };

  return { app, db, cleanup };
}

// מודול db.js הוא סינגלטון (נשאר ב-require cache של Node לכל משך קובץ הבדיקה),
// אז אי אפשר "לפתוח DB חדש" בין test-ים באותו קובץ - במקום זה מנקים את כל
// הטבלאות הבנות בין test-ים ומשאירים את אותו חיבור פתוח לאורך כל הקובץ.
function resetDb(db) {
  const tables = [
    'workflow_events', 'scan_events', 'order_items_cache', 'workflow_state', 'orders_cache',
    'pending_orders_cache', 'urgent_requests', 'shipments', 'order_shipments',
    'shipment_events', 'link_exceptions', 'sync_runs', 'audit_log', 'settings', 'item_suppliers', 'users',
  ];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
}

function seedUser(db, { username, password = '1234', role, displayName }) {
  const userId = `u_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(`
    INSERT INTO users (user_id, username, display_name, password, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, username, displayName || username, password, role);
  return userId;
}

function seedOrder(db, {
  orderKey, orderNum, customerName = 'לקוח בדיקה',
  agentId = null, sigmaAgentName = null, status = 'waiting_pick',
}) {
  db.prepare(`
    INSERT INTO orders_cache (order_key, company_id, sidra, order_num, customer_name, sigma_agent_name, synced_at)
    VALUES (?, 3, 0, ?, ?, ?, datetime('now'))
  `).run(orderKey, orderNum, customerName, sigmaAgentName);
  db.prepare(`
    INSERT INTO workflow_state (order_key, status, agent_id, queue_entered_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(orderKey, status, agentId);
}

async function loginAs(request, app, username, password = '1234') {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

module.exports = { createTestApp, seedUser, seedOrder, loginAs, resetDb };
