// סקריפט חד-פעמי לבדיקה: מציג את השורה המלאה (כל העמודות + ערכים) של פריט
// ספציפי בקטלוג (pritim), ובנוסף מחפש שוב טבלת ספקים עצמאית (כמו
// find-suppliers.js) ומדפיס שמות טבלה + שורת דוגמה מלאה לכל אחת - הכל
// בהרצה אחת, כדי לא לאבד מידע בגלל חיתוך אימייל. הרצה: node inspect-item.js 106013
// (בלי ארגומנט - ברירת המחדל 106013).
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

  console.log(`\n===== pritim WHERE prit_code = '${itemCode}' (השורה המלאה) =====`);
  let row = null;
  try {
    const byCode = await pool.request()
      .input('code', sql.VarChar, itemCode)
      .query('SELECT * FROM pritim WHERE prit_code = @code');
    if (byCode.recordset.length > 0) row = byCode.recordset[0];
  } catch (e) {
    console.log('שגיאה בחיפוש לפי prit_code:', e.message);
  }

  if (!row) {
    console.log(`(לא נמצא לפי prit_code, מנסה prit_ID = ${itemCode})`);
    try {
      const byId = await pool.request()
        .input('id', sql.Int, Number(itemCode))
        .query('SELECT * FROM pritim WHERE prit_ID = @id');
      if (byId.recordset.length > 0) row = byId.recordset[0];
    } catch (e) {
      console.log('שגיאה בחיפוש לפי prit_ID:', e.message);
    }
  }

  if (!row) {
    console.log('(הפריט לא נמצא בשום צורה - ראו הודעות השגיאה למעלה)');
  } else {
    console.log(JSON.stringify(row, null, 2));
  }

  console.log('\n===== חיפוש חוזר: טבלת ספקים עצמאית (שם + שורת דוגמה מלאה) =====');
  const tables = await pool.request().query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE '%sapak%' OR TABLE_NAME LIKE '%Sapak%'
       OR TABLE_NAME LIKE '%supplier%' OR TABLE_NAME LIKE '%Supplier%'
       OR TABLE_NAME LIKE '%vendor%' OR TABLE_NAME LIKE '%Vendor%'
       OR TABLE_NAME LIKE '%yatzran%' OR TABLE_NAME LIKE '%Yatzran%'
       OR TABLE_NAME LIKE '%nikui%' OR TABLE_NAME LIKE '%Nikui%'
  `);
  if (tables.recordset.length === 0) {
    console.log('לא נמצאה טבלה בשם ברור.');
  } else {
    for (const t of tables.recordset) {
      console.log(`\n----- טבלה: ${t.TABLE_NAME} -----`);
      try {
        const sample = await pool.request().query(`SELECT TOP 1 * FROM [${t.TABLE_NAME}]`);
        console.log(JSON.stringify(sample.recordset[0], null, 2));
      } catch (e) {
        console.log('(שגיאה בקריאת דוגמה:', e.message, ')');
      }
    }
  }

  await pool.close();
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
