// תיקון: הרשומה הקודמת שמשכנו על 106013 הייתה מ-CompanyID=4, אבל המערכת
// אצל דניאל מוגדרת על CompanyID=3 (ר' SIGMA_COMPANY_ID ב-.env). כנראה יש
// רשומת pritim נפרדת לאותו prit_code תחת CompanyID=3, ושם FLinkToMaazni
// כן מלא (הצילום מסך מסיגמא הראה "מס' כרטיס" = 800504, לא 0).
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

  console.log('===== כל השורות ב-pritim עם prit_code = \'106013\' (בכל החברות) =====');
  const all = await pool.request().query(`SELECT prit_ID, prit_code, CompanyID, FLinkToMaazni FROM pritim WHERE prit_code = '106013'`);
  all.recordset.forEach((r) => console.log(JSON.stringify(r)));

  console.log('\n===== השורה תחת CompanyID=3 במלואה =====');
  const row3 = await pool.request().query(`SELECT * FROM pritim WHERE prit_code = '106013' AND CompanyID = 3`);
  if (row3.recordset.length === 0) {
    console.log('(אין רשומה כזו תחת CompanyID=3)');
  } else {
    console.log(JSON.stringify(row3.recordset[0], null, 2));
  }

  console.log('\n===== maazni WHERE maazni_ID = 800504 =====');
  try {
    const m = await pool.request().query('SELECT * FROM maazni WHERE maazni_ID = 800504');
    if (m.recordset.length === 0) console.log('(לא נמצא)');
    else console.log(JSON.stringify(m.recordset[0], null, 2));
  } catch (e) {
    console.log('שגיאה:', e.message);
  }

  await pool.close();
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
