// Sigma Bridge מקומי — רץ על השרת הפיזי (איפה שה-SQL Server נמצא), קורא
// הזמנות פעילות/ששונו ודוחף אותן ל-backend של אלדין בענן דרך HTTPS יוצא.
// אף פעם לא נפתח חיבור נכנס אל תוך הרשת המקומית (סעיף 7 באפיון: "סנכרון
// יוצא בלבד"; סעיף 13: "SQL Server של סיגמא אינו חשוף לאינטרנט").
//
// שמות העמודות אומתו מול הסכימה האמיתית ב-10.9.2026 (ר' bridge/inspect-schema.js):
// azmana_index: אין cust_name/order_date/source_status — יש dorder, sum (סכום
// כולל מע"מ), canceled (bit), ומאזני מקושר דרך maazni_ID. שם הלקוח מגיע מ-
// maazni.name (JOIN לפי CompanyID+maazni_ID). אין עמודת delivery_date או notes
// גנרית בטבלה — לכן delivery_date ו-notes נשארים ריקים בינתיים.

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

// "הרצה ראשונה טוענת הזמנות פתוחות וטווח זמן מוסכם בלבד" (סעיף 8.3).
// "פתוחה לליקוט" אומתה מול דניאל (10.9.2026): status_ID=0 = ההזמנה עדיין
// אצל המזכירה (לא הודפסה, לא רלוונטית למחסן). status_ID=6 = הודפסה
// והועברה למחסן — זה מה שנכנס לתור "ממתינה לליקוט". חלון 30 יום נשאר
// כרשת ביטחון כדי לא למשוך היסטוריה ישנה בלי גבול.
// ⚠️ ידוע וטרם טופל: חלק מההזמנות שמשורשרות ישר לחשבונית (בלי ליקוט
// פיזי) נשארות תקועות ב-status_ID=6 גם אחרי שהן בפועל סגורות. צריך עוד
// כלל (למשל בדיקת שרשור לחשבונית) כדי לסנן אותן החוצה — לא ממומש עדיין.
async function fetchOpenOrders() {
  const p = await getPool();
  const headers = await p.request()
    .input('companyId', sql.Int, companyId)
    .input('sidra', sql.Int, sidra)
    .query(`
      SELECT h.CompanyID, h.sidra, h.azmana_num,
             m.name AS [customer_name],
             h.dorder AS [order_date],
             h.FCreateDate AS [created_at],
             h.sum AS [total_amount],
             h.canceled AS [canceled],
             ag.agent_name AS [agent_name]
      FROM azmana_index h
      LEFT JOIN maazni m ON m.CompanyID = h.CompanyID AND m.maazni_ID = h.maazni_ID
      LEFT JOIN t_agents ag ON ag.agent_ID = h.agent_ID
      WHERE h.CompanyID = @companyId AND h.sidra = @sidra
        AND h.canceled = 0
        AND h.status_ID = 6
        -- אומת מול הזמנה 54464 (10.9.2026): אם כל השורות tquan=0, ההזמנה כבר
        -- שורשרה במלואה לחשבונית ואין מה לליקוט למרות שהיא עדיין status_ID=6
        AND EXISTS (
          SELECT 1 FROM azmanot a
          WHERE a.CompanyID = h.CompanyID AND a.sidra = h.sidra AND a.azmana_num = h.azmana_num
            AND a.canceled = 0 AND a.tquan > 0
        )
        AND h.dorder >= DATEADD(day, -30, GETDATE())
    `);

  const orders = [];
  for (const h of headers.recordset) {
    const lines = await p.request()
      .input('companyId', sql.Int, h.CompanyID)
      .input('sidra', sql.Int, h.sidra)
      .input('orderNum', sql.Int, h.azmana_num)
      .query(`
        SELECT pline AS [lineNo], prit_ID AS [itemCode], pname AS [itemName], quant AS [quantity], pprice AS [price]
        FROM azmanot WHERE CompanyID = @companyId AND sidra = @sidra AND azmana_num = @orderNum ORDER BY pline
      `);
    orders.push({
      companyId: h.CompanyID, sidra: h.sidra, orderNum: h.azmana_num,
      customerName: (h.customer_name || '').trim() || `לקוח ${h.azmana_num}`,
      agentName: (h.agent_name || '').trim() || null,
      orderDate: h.order_date, createdAt: h.created_at, deliveryDate: null,
      totalAmount: h.total_amount, notes: null,
      sourceStatus: h.canceled ? 'cancelled' : 'open',
      items: lines.recordset,
    });
  }
  return orders;
}

const BATCH_SIZE = 50; // דוחפים בחבילות קטנות כדי לא לחרוג ממגבלת גודל בקשה

async function pushBatch(orders) {
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bridgeSecret}` },
    body: JSON.stringify({ orders }),
  });
  if (!res.ok) throw new Error(`דחיפה נכשלה: ${res.status} ${await res.text()}`);
  return res.json();
}

async function pushOrders(orders) {
  if (orders.length === 0) return { received: 0, created: 0, updated: 0 };
  let created = 0, updated = 0;
  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const batch = orders.slice(i, i + BATCH_SIZE);
    const result = await pushBatch(batch);
    created += result.created || 0;
    updated += result.updated || 0;
  }
  return { received: orders.length, created, updated };
}

// סוגר אוטומטית בענן הזמנות "ממתינות לליקוט" שכבר לא ברשימת ה-orders הנוכחית
// (למשל שורשרו במלואה לחשבונית, בוטלו, או חזרו סטטוס). לא נוגע בהזמנות בעבודה.
const reconcileUrl = targetUrl.replace(/\/sigma-sync$/, '/sigma-sync/reconcile');
async function reconcile(orders) {
  const validOrderNums = orders.map((o) => o.orderNum);
  const res = await fetch(reconcileUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bridgeSecret}` },
    body: JSON.stringify({ companyId, sidra, validOrderNums }),
  });
  if (!res.ok) throw new Error(`ניקוי נכשל: ${res.status} ${await res.text()}`);
  return res.json();
}

async function tick() {
  try {
    const orders = await fetchOpenOrders();
    const result = await pushOrders(orders);
    const recon = await reconcile(orders);
    log(`סונכרנו ${orders.length} הזמנות ->`, result, `| ניקוי: ${recon.closed} נסגרו מתוך ${recon.checked} שנבדקו`);
  } catch (e) {
    log('שגיאת סנכרון:', e.message);
  }
}

const serverDesc = instanceName ? `${cfg.server}\\${instanceName}` : `${cfg.server}:${cfg.port}`;
log(`Sigma Bridge מקומי מתחיל. שרת SQL: ${serverDesc}/${cfg.database}. יעד: ${targetUrl}. כל ${intervalMs / 1000} שניות.`);
tick();
setInterval(tick, intervalMs);
