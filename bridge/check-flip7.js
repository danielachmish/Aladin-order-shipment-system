// בדיקה ממוקדת מאוד: prit_ID 18813 ו-18815 (JBL FLIP 7 מהצילום מסך של דניאל,
// 14.9.2026) — בטבלה "pritim" שזוהתה כטבלת הפריטים האמיתית (CompanyID=3),
// כדי לוודא אם stock_place באמת מכיל ערך לפריטים האלה ספציפית.
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

async function main() {
  const pool = await sql.connect(cfg);

  console.log('===== pritim: prit_ID 18813, 18815 =====');
  const r1 = await pool.request().query(`SELECT * FROM pritim WHERE prit_ID IN (18813, 18815)`);
  r1.recordset.forEach((row) => console.log(JSON.stringify(row)));

  console.log('\n===== לוודא: כל הפריטים ששמם מכיל FLIP 7 =====');
  const r2 = await pool.request().query(`SELECT prit_ID, prit_code, prit_name, stock_place, barCode FROM pritim WHERE prit_name LIKE '%FLIP 7%'`);
  r2.recordset.forEach((row) => console.log(JSON.stringify(row)));

  console.log('\n===== מדגם: כמה פריטים אחרים עם stock_place לא ריק (כדי לדעת אם השדה בשימוש בכלל) =====');
  const r3 = await pool.request().query(`SELECT TOP 10 prit_ID, prit_code, prit_name, stock_place FROM pritim WHERE CompanyID = 3 AND stock_place IS NOT NULL AND LTRIM(RTRIM(stock_place)) <> ''`);
  console.log(`  נמצאו ${r3.recordset.length} דוגמאות עם stock_place מלא (מתוך כל הקטלוג):`);
  r3.recordset.forEach((row) => console.log(JSON.stringify(row)));

  await pool.close();
  console.log('\n===== סיום =====');
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
