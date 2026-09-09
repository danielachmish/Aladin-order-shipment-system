// חיבור אמיתי ל-Sigma (SQL Server, קריאה בלבד) — סעיפים 6.1, 7.1, 8 באפיון.
// פועל רק כאשר SIGMA_SQL_SERVER מוגדר ב-.env (ר' .env.example); אחרת server.js
// ממשיך להשתמש ב-sigmaBridgeMock כדי שסביבת הפיתוח תישאר עובדת.
//
// ⚠️ שמות העמודות המדויקים (מלבד CompanyID, sidra, azmana_num, pline, prit_ID,
// pname, quant, pprice שצוינו במפורש באפיון סעיף 8.2) הם ההשערה הכי קרובה למה
// שמתואר במסמך, אבל לא אומתו מול הסכימה האמיתית של Sigma בסביבה הזו (אין לי
// גישה לרשת החברה). לפני הרצה בפועל: להריץ testConnection() ו-fetchOrderByKey
// על הזמנה 54707 (סעיף 17.1 "שער Sigma"), להשוות שורה-שורה מול הדפסת Sigma,
// ולתקן כל שם עמודה מסומן ב-TODO למטה בהתאם לתוצאה.

const sql = require('mssql');
const { db } = require('./db');
const { sigma: cfg } = require('./config');

let pool = null;

async function getPool() {
  if (!cfg.enabled) throw new Error('Sigma לא מוגדר (.env) — ר\' .env.example');
  if (pool) return pool;
  pool = await sql.connect({
    server: cfg.server,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: {
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate,
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  });
  return pool;
}

async function testConnection() {
  const p = await getPool();
  const r = await p.request().query('SELECT 1 AS ok');
  return r.recordset[0].ok === 1;
}

// שער Sigma (סעיף 17.1): קריאת הזמנה בודדת לפי המפתח המלא, להשוואה מול הדפסת Sigma
async function fetchOrderByKey(companyId, sidra, orderNum) {
  const p = await getPool();
  const header = await p.request()
    .input('companyId', sql.Int, companyId)
    .input('sidra', sql.Int, sidra)
    .input('orderNum', sql.Int, orderNum)
    .query(`
      SELECT CompanyID, sidra, azmana_num,
             -- TODO: לאמת שמות עמודות אלה מול הסכימה האמיתית של azmana_index
             cust_name    AS customer_name,
             order_date   AS order_date,
             delivery_date AS delivery_date,
             total_amount AS total_amount,
             notes        AS notes,
             source_status AS source_status
      FROM azmana_index
      WHERE CompanyID = @companyId AND sidra = @sidra AND azmana_num = @orderNum
    `);
  if (header.recordset.length === 0) return null;

  const lines = await p.request()
    .input('companyId', sql.Int, companyId)
    .input('sidra', sql.Int, sidra)
    .input('orderNum', sql.Int, orderNum)
    .query(`
      SELECT pline, prit_ID AS item_code, pname AS item_name, quant AS quantity, pprice AS price,
             -- TODO: לאמת שם עמודת מיקום מחסן (אם קיים מקור אמין, סעיף 8.4)
             location
      FROM azmanot
      WHERE CompanyID = @companyId AND sidra = @sidra AND azmana_num = @orderNum
      ORDER BY pline
    `);

  return { header: header.recordset[0], lines: lines.recordset };
}

// "הזמנות ששונו מאז הסנכרון האחרון" (סעיף 8.3) — אם אין שדה שינוי אמין, נופל
// חזרה לחלון זמן + מצבים פעילים, כפי שהמסמך עצמו ממליץ.
async function fetchChangedOrders(sinceIso) {
  const p = await getPool();
  const result = await p.request()
    .input('companyId', sql.Int, cfg.companyId)
    .input('sidra', sql.Int, cfg.sidra)
    .input('since', sql.DateTime, sinceIso ? new Date(sinceIso) : new Date(Date.now() - 24 * 3600 * 1000))
    .query(`
      SELECT CompanyID, sidra, azmana_num,
             cust_name AS customer_name, order_date, delivery_date,
             total_amount, notes, source_status
      FROM azmana_index
      WHERE CompanyID = @companyId AND sidra = @sidra
        -- TODO: להחליף לשדה שינוי אמיתי (למשל last_modified) אם קיים; כרגע חלון זמן + מצב פעיל
        AND (order_date >= @since OR source_status IN ('open', 'active'))
    `);
  return result.recordset;
}

function orderKey(companyId, sidra, num) {
  return `${companyId}|${sidra}|${num}`;
}

// upsert לפי המפתח CompanyID+sidra+מספר הזמנה (סעיף 6.1.3), בלי לגעת בהזמנות שכבר בטיפול
async function syncOnce() {
  const headers = await fetchChangedOrders();
  const p = await getPool();
  let synced = 0;

  const insertOrder = db.prepare(`
    INSERT INTO orders_cache (order_key, company_id, sidra, order_num, customer_name, order_date, delivery_date, total_amount, line_count, notes, source_status, synced_at)
    VALUES (@order_key, @company_id, @sidra, @order_num, @customer_name, @order_date, @delivery_date, @total_amount, @line_count, @notes, @source_status, datetime('now'))
    ON CONFLICT(order_key) DO UPDATE SET
      customer_name = excluded.customer_name, order_date = excluded.order_date,
      delivery_date = excluded.delivery_date, total_amount = excluded.total_amount,
      line_count = excluded.line_count, notes = excluded.notes,
      source_status = excluded.source_status, synced_at = datetime('now')
  `);
  const insertItem = db.prepare(`
    INSERT OR REPLACE INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, location, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWorkflowIfNew = db.prepare(`
    INSERT OR IGNORE INTO workflow_state (order_key, status, priority, queue_entered_at)
    VALUES (?, 'waiting_pick', 'normal', datetime('now'))
  `);

  for (const h of headers) {
    const key = orderKey(h.CompanyID, h.sidra, h.azmana_num);
    const lines = await p.request()
      .input('companyId', sql.Int, h.CompanyID)
      .input('sidra', sql.Int, h.sidra)
      .input('orderNum', sql.Int, h.azmana_num)
      .query(`
        SELECT pline, prit_ID AS item_code, pname AS item_name, quant AS quantity, pprice AS price, location
        FROM azmanot WHERE CompanyID = @companyId AND sidra = @sidra AND azmana_num = @orderNum ORDER BY pline
      `);

    insertOrder.run({
      order_key: key, company_id: h.CompanyID, sidra: h.sidra, order_num: h.azmana_num,
      customer_name: h.customer_name, order_date: h.order_date, delivery_date: h.delivery_date,
      total_amount: h.total_amount, line_count: lines.recordset.length, notes: h.notes,
      source_status: h.source_status,
    });
    lines.recordset.forEach((it) => {
      insertItem.run(key, it.pline, it.item_code, it.item_name, it.quantity, it.price, it.location, null);
    });
    // "הזמנה חדשה נכנסת למצב פתוחה או ממתינה לליקוט לפי כלל מנהל ומופיעה מיד בתור" (סעיף 6.1.4)
    insertWorkflowIfNew.run(key);
    synced++;
  }

  db.prepare(`INSERT INTO sync_runs (run_id, source, ok, detail) VALUES (?, 'sigma', 1, ?)`)
    .run(`run_${Date.now()}`, JSON.stringify({ synced }));

  return { synced };
}

function startPolling() {
  if (!cfg.enabled) {
    console.log('Sigma: לא מוגדר (.env) — ממשיך עם sigmaBridgeMock');
    return;
  }
  console.log(`Sigma: מתחבר ל-${cfg.server}:${cfg.port}/${cfg.database}, סנכרון כל ${cfg.pollIntervalMs / 1000} שניות`);
  const tick = async () => {
    try {
      const res = await syncOnce();
      console.log(`Sigma sync: ${res.synced} הזמנות עודכנו`);
    } catch (e) {
      console.error('Sigma sync נכשל:', e.message);
      db.prepare(`INSERT INTO sync_runs (run_id, source, ok, detail) VALUES (?, 'sigma', 0, ?)`)
        .run(`run_${Date.now()}`, e.message);
    }
  };
  tick();
  setInterval(tick, cfg.pollIntervalMs);
}

module.exports = { testConnection, fetchOrderByKey, fetchChangedOrders, syncOnce, startPolling, orderKey };
