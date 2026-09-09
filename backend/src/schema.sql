-- Aladin – סכמת מסד נתונים (dev: SQLite, יעד production: PostgreSQL, ר' סעיף 10 באפיון)

CREATE TABLE IF NOT EXISTS users (
  user_id      TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password     TEXT NOT NULL, -- MOCK: טקסט גלוי לצורך דמו בלבד, לא לפרודקשן
  role         TEXT NOT NULL CHECK (role IN ('agent','warehouse','warehouse_manager','system_admin')),
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- עותק קריאה של הזמנות Sigma (בפרודקשן מוזן ע"י Sigma Bridge; כאן מוזן ע"י sigmaBridgeMock)
CREATE TABLE IF NOT EXISTS orders_cache (
  order_key     TEXT PRIMARY KEY, -- company_id|sidra|order_num
  company_id    INTEGER NOT NULL,
  sidra         INTEGER NOT NULL,
  order_num     INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  order_date    TEXT,
  delivery_date TEXT,
  total_amount  REAL,
  line_count    INTEGER,
  notes         TEXT,
  source_status TEXT, -- מצב ב-Sigma, לקריאה בלבד
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items_cache (
  order_key TEXT NOT NULL,
  line_no   INTEGER NOT NULL,
  item_code TEXT,
  item_name TEXT,
  quantity  REAL,
  price     REAL,
  location  TEXT,
  note      TEXT,
  PRIMARY KEY (order_key, line_no)
);

-- מצב עבודה נוכחי של כל הזמנה (המנוע המרכזי של האפליקציה)
CREATE TABLE IF NOT EXISTS workflow_state (
  order_key       TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'open',
    -- open | waiting_pick | picking | ready_to_pack | waiting_pickup | delivered_to_ups | closed
    -- וכן: on_hold (מעוכבת/בוטלה), waiting_answer (ממתינה לתשובת לקוח/סוכן)
  pre_wait_status TEXT,             -- השלב שבו נעצרה ההזמנה לפני waiting_answer, לחזרה מדויקת
  priority        TEXT NOT NULL DEFAULT 'normal', -- normal | urgent | next | held
  agent_id        TEXT,             -- הסוכן ששייך להזמנה
  claimed_by      TEXT,             -- יוזר מחסן שנעל את ההזמנה (claim אטומי)
  queue_entered_at TEXT,            -- שעת כניסה בפועל לתור ממתינה לליקוט (סעיף 5)
  version         INTEGER NOT NULL DEFAULT 1, -- optimistic concurrency
  hold_reason     TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (order_key) REFERENCES orders_cache(order_key)
);

CREATE TABLE IF NOT EXISTS workflow_events (
  event_id    TEXT PRIMARY KEY,
  order_key   TEXT NOT NULL,
  user_id     TEXT,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- בקשות דחיפות מסוכן ואישור מנהל
CREATE TABLE IF NOT EXISTS urgent_requests (
  request_id  TEXT PRIMARY KEY,
  order_key   TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  decided_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT
);

CREATE TABLE IF NOT EXISTS shipments (
  track_no       TEXT PRIMARY KEY,
  status         TEXT,          -- מצב מנורמל, ר' סעיף 4.2
  status_desc_heb TEXT,
  exception_code TEXT,
  exception_desc_heb TEXT,
  estimate_delivery TEXT,
  rts_track_no   TEXT,
  delivered_time TEXT,
  received_by    TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_shipments (
  order_key TEXT NOT NULL,
  track_no  TEXT NOT NULL,
  ref1_raw  TEXT,
  PRIMARY KEY (order_key, track_no)
);

CREATE TABLE IF NOT EXISTS shipment_events (
  event_id       TEXT PRIMARY KEY,
  track_no       TEXT NOT NULL,
  dedupe_key     TEXT UNIQUE NOT NULL,
  raw_body       TEXT,
  normalized_status TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- חריגות קישור (אסמכתא לא תקינה / כפולה) לטיפול מנהל
CREATE TABLE IF NOT EXISTS link_exceptions (
  exception_id TEXT PRIMARY KEY,
  track_no     TEXT,
  bad_ref      TEXT,
  reason       TEXT,
  resolved     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_runs (
  run_id     TEXT PRIMARY KEY,
  source     TEXT NOT NULL, -- sigma | ups
  ok         INTEGER NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id   TEXT PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
