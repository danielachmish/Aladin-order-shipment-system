// Sigma Bridge מקומי — רץ על השרת הפיזי (איפה שה-SQL Server נמצא), קורא
// הזמנות פעילות/ששונו ודוחף אותן ל-backend של אלדין בענן דרך HTTPS יוצא.
// אף פעם לא נפתח חיבור נכנס אל תוך הרשת המקומית (סעיף 7 באפיון: "סנכרון
// יוצא בלבד"; סעיף 13: "SQL Server של סיגמא אינו חשוף לאינטרנט").
//
// ⚠️ שמות העמודות מסומנים // TODO במקומות שלא אומתו מול הסכימה האמיתית של
// סיגמא (רק CompanyID/sidra/azmana_num/pline/prit_ID/pname/quant/pprice
// מצוינים במפורש באפיון, סעיף 8.2). להריץ פעם אחת ידנית (node sync.js) ולוודא
// שהזמנה 54707 חוזרת נכון לפני שמתקינים כשירות קבוע.

require('dotenv').config();
const sql = require('mssql');

// שם Instance (למשל SQLSIGMA) — נפוץ בהתקנות Sigma. כשיש Instance, לא קובעים
// port קבוע; mssql/tedious פונה ל-SQL Server Browser (UDP 1434) כדי לאתר את
// הפורט האמיתי של ה-instance לבד.
const instanceName = process.env.SIGMA_SQL_INSTANCE || null;

const cfg = {
  server: process.env.SIGMA_SQL_SERVER,
  database: process.env.SIGMA_SQL_DATABASE,
  user: process.env.SIGMA_SQL_USER,
  password: process.env.SIGMA_SQL_PASSWORD,
  options: {
    encrypt: process.env.SIGMA_SQL_ENCRYPT !== 'false',
    trustServerCertificate: process.env.SIGMA_SQL_TRUST_CERT === 'true',
    ...(instanceName ? { instanceName } : {}),
  },
};
if (!instanceName) {
  cfg.port = Number(process.env.SIGMA_SQL_PORT || 1433);
}
const companyId = Number(process.env.SIGMA_COMPANY_ID || 3);
const sidra = Number(process.env.SIGMA_SIDRA || 0);
const targetUrl = process.env.BRIDGE_TARGET_URL;
const bridgeSecret = process.env.SIGMA_BRIDGE_SECRET;
const intervalMs = Number(process.env.SYNC_INTERVAL_MS || 45000);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

if (!cfg.server || !targetUrl || !bridgeSecret) {
  log('חסרים משתני סביבה חובה (SIGMA_SQL_SERVER / BRIDGE_TARGET_URL / SIGMA_BRIDGE_SECRET). ר\' .env.example');
  process.exit(1);
}

let pool = null;
async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(cfg);
  return pool;
}

// "הרצה ראשונה טוענת הזמנות פתוחות וטווח זמן מוסכם בלבד" (סעיף 8.3)
async function fetchOpenOrders() {
  const p = await getPool();
  const headers = await p.request()
    .input('companyId', sql.Int, companyId)
    .input('sidra', sql.Int, sidra)
    .query(`
      SELECT CompanyID, sidra, azmana_num,
             -- TODO: לאמת שמות עמודות אלה מול הסכימה האמיתית של azmana_index
             cust_name AS customer_name, order_date, delivery_date,
             total_amount, notes, source_status
      FROM azmana_index
      WHERE CompanyID = @companyId AND sidra = @sidra
        AND (source_status = 'open' OR order_date >= DATEADD(day, -14, GETDATE()))
    `);

  const orders = [];
  for (const h of headers.recordset) {
    const lines = await p.request()
      .input('companyId', sql.Int, h.CompanyID)
      .input('sidra', sql.Int, h.sidra)
      .input('orderNum', sql.Int, h.azmana_num)
      .query(`
        SELECT pline AS lineNo, prit_ID AS itemCode, pname AS itemName, quant AS quantity, pprice AS price, location
        FROM azmanot WHERE CompanyID = @companyId AND sidra = @sidra AND azmana_num = @orderNum ORDER BY pline
      `);
    orders.push({
      companyId: h.CompanyID, sidra: h.sidra, orderNum: h.azmana_num,
      customerName: h.customer_name, orderDate: h.order_date, deliveryDate: h.delivery_date,
      totalAmount: h.total_amount, notes: h.notes, sourceStatus: h.source_status,
      items: lines.recordset,
    });
  }
  return orders;
}

async function pushOrders(orders) {
  if (orders.length === 0) return { received: 0 };
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bridgeSecret}` },
    body: JSON.stringify({ orders }),
  });
  if (!res.ok) throw new Error(`דחיפה נכשלה: ${res.status} ${await res.text()}`);
  return res.json();
}

async function tick() {
  try {
    const orders = await fetchOpenOrders();
    const result = await pushOrders(orders);
    log(`סונכרנו ${orders.length} הזמנות ->`, result);
  } catch (e) {
    log('שגיאת סנכרון:', e.message);
  }
}

const serverDesc = instanceName ? `${cfg.server}\\${instanceName}` : `${cfg.server}:${cfg.port}`;
log(`Sigma Bridge מקומי מתחיל. שרת SQL: ${serverDesc}/${cfg.database}. יעד: ${targetUrl}. כל ${intervalMs / 1000} שניות.`);
tick();
setInterval(tick, intervalMs);
