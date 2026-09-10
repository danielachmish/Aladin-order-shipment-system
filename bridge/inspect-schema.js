// סקריפט חד-פעמי לבדיקה: מציג את שמות העמודות האמיתיים בטבלאות azmana_index
// ו-azmanot, כדי לתקן את השאילתות ב-sync.js לפי המציאות (לא לפי ניחוש).
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

  for (const table of ['maazni', 'pritim']) {
    console.log(`\n===== עמודות בטבלה ${table} =====`);
    const cols = await pool.request()
      .input('t', sql.VarChar, table)
      .query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`);
    if (cols.recordset.length === 0) {
      console.log('(הטבלה לא נמצאה בשם הזה)');
    } else {
      cols.recordset.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
    }
  }

  console.log('\n===== דוגמה: שורה אחת מ-maazni (לקוח 851162) =====');
  try {
    const sample = await pool.request().query('SELECT TOP 1 * FROM maazni');
    console.log(JSON.stringify(sample.recordset[0], null, 2));
  } catch (e) {
    console.log('שגיאה בקריאת דוגמה:', e.message);
  }

  await pool.close();
}

main().catch((e) => {
  console.error('שגיאה:', e.message);
  process.exit(1);
});
