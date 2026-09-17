const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DB_PATH ניתן לדריסה (למשל ':memory:' או קובץ זמני) כדי לבודד ריצות בדיקות
// מה-DB האמיתי של הפיתוח, בלי לשנות שום דבר בהתנהגות הרגילה בפרודקשן/dev.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'aladin.db');
const isNew = DB_PATH === ':memory:' || !fs.existsSync(DB_PATH);

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
ensureColumn('orders_cache', 'sigma_created_at', 'TEXT');
ensureColumn('workflow_state', 'pending_addition_note', 'TEXT');
ensureColumn('workflow_state', 'delivery_method', 'TEXT');
ensureColumn('order_items_cache', 'qty_picked', 'REAL');
ensureColumn('order_items_cache', 'pick_status', 'TEXT');
ensureColumn('order_items_cache', 'pick_note', 'TEXT');
ensureColumn('order_items_cache', 'checked', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('order_items_cache', 'check_note', 'TEXT');
ensureColumn('workflow_state', 'linked_group_id', 'TEXT');
ensureColumn('order_items_cache', 'barcode', 'TEXT'); // ר' PICKING_QC_SPEC.md סעיף 11
ensureColumn('order_items_cache', 'pick_marked_at', 'TEXT');
ensureColumn('workflow_state', 'shortage_invoiced_at', 'TEXT');
ensureColumn('workflow_state', 'shortage_invoiced_by', 'TEXT');
ensureColumn('workflow_state', 'package_count', 'INTEGER');
ensureColumn('workflow_state', 'pallet_count', 'INTEGER');
ensureColumn('workflow_state', 'cod_type', "TEXT NOT NULL DEFAULT 'none'");
ensureColumn('workflow_state', 'cod_amount', 'REAL');
ensureColumn('workflow_state', 'cod_due_date', 'TEXT');
ensureColumn('workflow_state', 'cod_set_by', 'TEXT');
ensureColumn('workflow_state', 'cod_set_at', 'TEXT');
ensureColumn('order_items_cache', 'auto_missing', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'sigma_agent_id', 'INTEGER');
ensureColumn('orders_cache', 'sigma_agent_id', 'INTEGER');
ensureColumn('item_shortage_status', 'woocommerce_status', 'TEXT');
ensureColumn('item_shortage_status', 'woocommerce_detail', 'TEXT');
ensureColumn('workflow_state', 'planned_delivery_method', 'TEXT');
ensureColumn('workflow_state', 'special_instructions', 'TEXT');
ensureColumn('order_items_cache', 'replaced_to', 'TEXT');
ensureColumn('order_items_cache', 'replaced_qty', 'REAL');
ensureColumn('order_items_cache', 'replaced_confirmed', 'INTEGER NOT NULL DEFAULT 0');

module.exports = { db, isNew };
