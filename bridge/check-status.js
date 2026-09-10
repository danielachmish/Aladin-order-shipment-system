// בדיקה חד-פעמית: אילו ערכי st_code / status_ID קיימים בפועל בהזמנות
// האחרונות (לא מבוטלות), כדי לזהות איזה מהם מייצג "0 = אצל המזכירה" /
// "6 = מודפס והועבר למחסן" כפי שתואר.
require('dotenv').config();
const sql = require('mssql');

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
if (!instanceName) cfg.port = Number(process.env.SIGMA_SQL_PORT || 1433);

const companyId = Number(process.env.SIGMA_COMPANY_ID || 3);
const sidra = Number(process.env.SIGMA_SIDRA || 0);

async function main() {
  const pool = await sql.connect(cfg);

  console.log('\n===== התפלגות st_code בהזמנות מה-30 יום האחרונים (לא מבוטלות) =====');
  const stCode = await pool.request()
    .input('companyId', sql.Int, companyId).input('sidra', sql.Int, sidra)
    .query(`
      SELECT st_code, COUNT(*) AS cnt
      FROM azmana_index
      WHERE CompanyID = @companyId AND sidra = @sidra AND canceled = 0
        AND dorder >= DATEADD(day, -30, GETDATE())
      GROUP BY st_code ORDER BY cnt DESC
    `);
  stCode.recordset.forEach((r) => console.log(`  st_code=${r.st_code}  ->  ${r.cnt} הזמנות`));

  console.log('\n===== התפלגות status_ID בהזמנות מה-30 יום האחרונים (לא מבוטלות) =====');
  const statusId = await pool.request()
    .input('companyId', sql.Int, companyId).input('sidra', sql.Int, sidra)
    .query(`
      SELECT status_ID, COUNT(*) AS cnt
      FROM azmana_index
      WHERE CompanyID = @companyId AND sidra = @sidra AND canceled = 0
        AND dorder >= DATEADD(day, -30, GETDATE())
      GROUP BY status_ID ORDER BY cnt DESC
    `);
  statusId.recordset.forEach((r) => console.log(`  status_ID=${r.status_ID}  ->  ${r.cnt} הזמנות`));

  console.log('\n===== 5 הזמנות אחרונות (מספר, תאריך, st_code, status_ID) =====');
  const recent = await pool.request()
    .input('companyId', sql.Int, companyId).input('sidra', sql.Int, sidra)
    .query(`
      SELECT TOP 5 azmana_num, dorder, st_code, status_ID, canceled
      FROM azmana_index
      WHERE CompanyID = @companyId AND sidra = @sidra
      ORDER BY dorder DESC
    `);
  recent.recordset.forEach((r) => console.log(`  #${r.azmana_num}  ${r.dorder}  st_code=${r.st_code}  status_ID=${r.status_ID}  canceled=${r.canceled}`));

  await pool.close();
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
