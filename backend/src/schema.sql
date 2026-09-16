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
  sigma_agent_name TEXT, -- שם הסוכן האמיתי מ-Sigma (t_agents.agent_name), תצוגה בלבד
  sigma_created_at TEXT, -- FCreateDate מסיגמא (תאריך+שעה מדויקים), לסידור התור
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- הזמנות שעדיין אצל המזכירה (status_ID=0 בסיגמא — טרם הודפסו/אושרו, לא נכנסות
-- לתור הליקוט). תצוגה בלבד למנהל/מנהל מחסן/סוכנים, כדי לדעת מה מגיע בהמשך —
-- לא חלק ממנוע ה-workflow (אין להן claim/priority/סטטוס עבודה).
CREATE TABLE IF NOT EXISTS pending_orders_cache (
  order_key     TEXT PRIMARY KEY, -- company_id|sidra|order_num
  company_id    INTEGER NOT NULL,
  sidra         INTEGER NOT NULL,
  order_num     INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  order_date    TEXT,
  sigma_created_at TEXT,
  total_amount  REAL,
  sigma_agent_name TEXT,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ליקוט לפי מיקום + בדיקה (QC) — ר' PICKING_QC_SPEC.md (סוכם עם דניאל 14.9.2026)
CREATE TABLE IF NOT EXISTS order_items_cache (
  order_key   TEXT NOT NULL,
  line_no     INTEGER NOT NULL,
  item_code   TEXT,
  item_name   TEXT,
  quantity    REAL,
  price       REAL,
  location    TEXT, -- מיקום פיזי במחסן (סיגמא: pratim/QryIndexPritim.stock_place, ר' סעיף 11 ב-PICKING_QC_SPEC.md)
  barcode     TEXT, -- ברקוד הפריט (סיגמא: pratim/QryIndexPritim.barCode, אותו מקור)
  note        TEXT,
  qty_picked  REAL,    -- כמות שנלקטה בפועל; NULL = עוד לא טופלה
  pick_status TEXT,    -- 'picked' | 'partial' | 'missing'
  pick_note   TEXT,    -- הערת מלקט (בעיקר לחוסר)
  checked     INTEGER NOT NULL DEFAULT 0, -- 0/1 — האם הבודק אישר את השורה
  check_note  TEXT,    -- הערת בודק אם תיקן משהו
  pick_marked_at TEXT, -- מתי סומן pick_status לאחרונה (מלקט או תיקון בודק) — לדוח "חוסרי מלאי היום"
  auto_missing INTEGER NOT NULL DEFAULT 0, -- 1 = סומן אוטומטית "חסר" כי אומת כחוסר בהזמנה אחרת (ר' item_shortage_status), לא ע"י המלקט עצמו
  PRIMARY KEY (order_key, line_no)
);

-- מוצרים שאומתו כחסרים במלאי בפועל (ר' ייעוץ 17.9.2026, נושא 4) — ע"י בודק
-- QC שהשאיר שורה 'missing' עד finishCheck. משדר את הסימון "חסר" לכל שאר
-- ההזמנות הפתוחות עם אותו item_code שעוד לא לוקטו, כדי שהמלקטת תדלג עליהן
-- (עם כפתור תיקון קיים ב-UI). מנוקה ידנית ע"י מנהל מחסן דרך מסך "חזר למלאי".
CREATE TABLE IF NOT EXISTS item_shortage_status (
  item_code  TEXT PRIMARY KEY,
  marked_by  TEXT,
  marked_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
  pending_addition_note TEXT, -- לא NULL = יש "תוספת" בדרך; חוסם סגירת ההזמנה (סעיף בקשת דניאל, 14.9.2026)
  delivery_method TEXT, -- ups | self_pickup — נקבע ב-waiting_pickup (סעיף בקשת דניאל, 14.9.2026)
  linked_group_id TEXT, -- הזמנות מקושרות ידנית (למשל תוספת שהגיעה כהזמנה נפרדת) —
                         -- כל ההזמנות עם אותו group id "נצמדות" לאותו מקום בתור. ר' בקשת דניאל 14.9.2026.
  shortage_invoiced_at TEXT, -- מזכירה סימנה שהוציאה חשבונית מתוקנת על החוסרים (ר' PICKING_QC_SPEC.md סעיף 12)
  shortage_invoiced_by TEXT,
  package_count   INTEGER, -- כמה חבילות יצאו בפועל, מוזן ב-pack-done (בקשת דניאל 17.9.2026 — כדי שהמזכירה תדע כמה שטרי מטען UPS להפיק)
  pallet_count    INTEGER, -- כמה משטחים יצאו בפועל, מוזן ב-pack-done
  cod_type        TEXT NOT NULL DEFAULT 'none', -- none | full | custom | full_plus_extra (גוביינא, ר' בקשת דניאל 17.9.2026)
  cod_amount      REAL, -- סכום מפורש: עבור custom = הסכום כולו, עבור full_plus_extra = התוספת בלבד
  cod_due_date    TEXT, -- תאריך פירעון השיק
  cod_set_by      TEXT,
  cod_set_at      TEXT,
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

-- מיפוי פריט -> ספק, מסונכרן מ-Sigma (pritim.FLinkToMaazni -> maazni.name,
-- מאומת ידנית מול הזמנה אמיתית 106013 בייעוץ 16.9.2026). קטלוג שמשתנה לאט —
-- מסונכרן בנפרד מהזמנות, לא בכל סבב (ר' bridge/sync.js syncSuppliersOnce).
CREATE TABLE IF NOT EXISTS item_suppliers (
  item_code     TEXT PRIMARY KEY,
  supplier_id   INTEGER,
  supplier_name TEXT,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
