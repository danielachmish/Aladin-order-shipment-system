// המשך ל-inspect-item.js: עכשיו שיודעים ש-QAmSapak / QAmSapakChilufi הן
// טבלאות תעודות קבלה מספק (יש בהן prit_ID + maazni_ID + name), מציג את כל
// היסטוריית הקבלות של פריט ספציפי מכל הספקים, מהחדש לישן - כדי לראות אם יש
// ספק "נוכחי" ברור (השורה האחרונה) או שזה מתחלף. הרצה: node inspect-item-supplier.js 106013
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

const itemCode = process.argv[2] || '106013';

async function main() {
  const pool = await sql.connect(cfg);

  const pritRow = await pool.request()
    .input('code', sql.VarChar, itemCode)
    .query('SELECT prit_ID, prit_code, prit_name, CompanyID FROM pritim WHERE prit_code = @code');
  if (pritRow.recordset.length === 0) {
    console.log(`הפריט ${itemCode} לא נמצא ב-pritim`);
    await pool.close();
    return;
  }
  const { prit_ID, prit_name, CompanyID } = pritRow.recordset[0];
  console.log(`פריט: ${prit_ID} — ${prit_name} (CompanyID ${CompanyID})`);

  for (const table of ['QAmSapak', 'QAmSapakChilufi']) {
    console.log(`\n===== ${table} — כל הקבלות של הפריט הזה, מהחדש לישן =====`);
    try {
      const rows = await pool.request()
        .input('pid', sql.Int, prit_ID)
        .query(`SELECT TOP 10 * FROM ${table} WHERE prit_ID = @pid ORDER BY cdate DESC`);
      if (rows.recordset.length === 0) {
        console.log('(אין קבלות רשומות לפריט הזה בטבלה הזו)');
      } else {
        rows.recordset.forEach((r) => console.log(JSON.stringify(r)));
      }
    } catch (e) {
      console.log('שגיאה:', e.message);
    }
  }

  await pool.close();
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
