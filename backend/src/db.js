const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'aladin.db');
const isNew = !fs.existsSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// מיגרציות קלות: CREATE TABLE IF NOT EXISTS לא מוסיף עמודות לטבלה קיימת,
// אז עמודות חדשות שנוספו אחרי הפריסה הראשונה מתווספות כאן בעדינות.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('orders_cache', 'sigma_agent_name', 'TEXT');

module.exports = { db, isNew };
