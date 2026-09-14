// סקריפט אבחון ממוקד: מחפש את הפריט "JBL FLIP" (מהצילום מסך של דניאל,
// 14.9.2026) בכל הטבלאות שיש להן עמודת prit_name/pname, ומדפיס את השורה
// המלאה שלו מכל טבלה — במיוחד stock_place ו-barCode/BarCode — כדי לזהות
// באיזו טבלה בדיוק יושבים הערכים האמיתיים (הניסיון הקודם עם TDemoPritim
// לא הראה נתונים באפליקציה, למרות שדניאל מאשר שיש ערכים בסיגמא עצמה).
// קריאה בלבד (SELECT). לא משנה כלום.
//
// הרצה (מתיקיית bridge/):
//   node find-jbl-location.js

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

async function main() {
  const pool = await sql.connect(cfg);

  // שלב 1: מוצאים את ה-prit_ID האמיתי של הפריט מתוך שורת הזמנה אמיתית
  // (azmanot) לפי שם — זה אותו prit_ID שה-Bridge כבר שולף בכל מקרה.
  console.log('===== שלב 1: איתור prit_ID של JBL FLIP מתוך azmanot =====');
  const fromOrders = await pool.request()
    .input('companyId', sql.Int, companyId)
    .query(`
      SELECT DISTINCT TOP 10 prit_ID, pname FROM azmanot
      WHERE CompanyID = @companyId AND pname LIKE '%JBL%FLIP%'
    `);
  fromOrders.recordset.forEach((r) => console.log(`  prit_ID=${r.prit_ID}  pname="${r.pname}"`));

  const pritIds = fromOrders.recordset.map((r) => r.prit_ID);
  if (pritIds.length === 0) {
    console.log('  לא נמצא JBL FLIP בהזמנות של החברה הזו — נסה חיפוש רחב יותר לפי שם בלבד.');
  }

  // שלב 2: מחפשים את אותם prit_ID (ואם לא נמצא — לפי שם) בכל טבלה/view
  // שיש לה עמודת prit_ID/prit_code ועמודת שם, ומדפיסים את כל השורה.
  console.log('\n===== שלב 2: חיפוש כל טבלה/view שיש לה עמודת prit_name/pname =====');
  const tablesWithName = await pool.request().query(`
    SELECT DISTINCT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE COLUMN_NAME IN ('prit_name', 'pname', 'prit_code')
    ORDER BY TABLE_NAME
  `);
  console.log(`  נמצאו ${tablesWithName.recordset.length} טבלאות/views מועמדים:`);
  tablesWithName.recordset.forEach((r) => console.log(`  - ${r.TABLE_NAME}`));

  for (const { TABLE_NAME: t } of tablesWithName.recordset) {
    try {
      const cols = await pool.request()
        .input('t', sql.VarChar, t)
        .query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t`);
      const colNames = cols.recordset.map((c) => c.COLUMN_NAME);
      const nameCol = colNames.includes('prit_name') ? 'prit_name' : (colNames.includes('pname') ? 'pname' : null);
      const idCol = colNames.includes('prit_ID') ? 'prit_ID' : null;
      if (!nameCol && !idCol) continue;

      let query;
      if (idCol && pritIds.length > 0) {
        query = `SELECT TOP 5 * FROM [${t}] WHERE ${idCol} IN (${pritIds.join(',')})`;
      } else if (nameCol) {
        query = `SELECT TOP 5 * FROM [${t}] WHERE ${nameCol} LIKE '%JBL%FLIP%'`;
      } else {
        continue;
      }
      const res = await pool.request().query(query);
      if (res.recordset.length > 0) {
        console.log(`\n----- נמצאו שורות תואמות ב-${t} -----`);
        res.recordset.forEach((row) => console.log('  ', JSON.stringify(row)));
      }
    } catch (e) {
      // מתעלמים משגיאות טבלה בודדת (view לא נגיש וכו') וממשיכים
    }
  }

  await pool.close();
  console.log('\n===== סיום. יש להעתיק את כל הפלט (מומלץ להריץ עם הפניה לקובץ, ר\' הערה למטה) =====');
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
