// סקריפט חד-פעמי לבדיקה (ר' ייעוץ 16.9.2026, נושא 5 - "חוסרים לפי ספק"): מציג
// את כל העמודות של pritim (טבלת קטלוג הפריטים - ר' inspect-schema.js) ומסמן
// כל עמודה שיכולה להיות שיוך לספק, ובנוסף מחפש טבלת "ספקים" עצמאית באותה
// שיטה שבה find-agents-table.js מוצא את טבלת הסוכנים. מריצים את זה פעם אחת
// כדי לדעת אם יש בכלל שיוך ספק->פריט לפני שבונים עליו תכונה.
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

// כינויים אפשריים לספק/יצרן בטבלאות ERP ישראליות (עברית מתועתקת + אנגלית)
const SUPPLIER_WORDS = ['sapak', 'supplier', 'vendor', 'yatzran', 'moreh', 'koreh', 'manufacturer'];

async function main() {
  const pool = await sql.connect(cfg);

  console.log('\n===== כל העמודות בטבלת pritim (קטלוג הפריטים) =====');
  const cols = await pool.request()
    .input('t', sql.VarChar, 'pritim')
    .query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`);
  if (cols.recordset.length === 0) {
    console.log('(הטבלה pritim לא נמצאה בשם הזה - יכול להיות ששם הטבלה שונה, ראו inspect-schema.js)');
  } else {
    cols.recordset.forEach((c) => {
      const flag = SUPPLIER_WORDS.some((w) => c.COLUMN_NAME.toLowerCase().includes(w)) ? '  <-- כנראה שיוך לספק' : '';
      console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})${flag}`);
    });
  }

  console.log('\n===== דוגמה: שורה אחת מ-pritim (לראות ערכים אמיתיים) =====');
  try {
    const sample = await pool.request().query('SELECT TOP 1 * FROM pritim');
    console.log(JSON.stringify(sample.recordset[0], null, 2));
  } catch (e) {
    console.log('שגיאה בקריאת דוגמה:', e.message);
  }

  console.log('\n===== חיפוש טבלה עצמאית של ספקים (לפי שם) =====');
  const tables = await pool.request().query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE '%sapak%' OR TABLE_NAME LIKE '%Sapak%'
       OR TABLE_NAME LIKE '%supplier%' OR TABLE_NAME LIKE '%Supplier%'
       OR TABLE_NAME LIKE '%vendor%' OR TABLE_NAME LIKE '%Vendor%'
       OR TABLE_NAME LIKE '%yatzran%' OR TABLE_NAME LIKE '%Yatzran%'
  `);
  if (tables.recordset.length === 0) {
    console.log('לא נמצאה טבלת ספקים עצמאית בשם ברור. אם יש שיוך לספק, כנראה שהוא עמודה בתוך pritim עצמה (ראו למעלה) ולא טבלה נפרדת.');
  } else {
    for (const t of tables.recordset) {
      const tableName = t.TABLE_NAME;
      console.log(`\n----- טבלה: ${tableName} -----`);
      const tcols = await pool.request()
        .input('t', sql.VarChar, tableName)
        .query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`);
      tcols.recordset.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
      try {
        const sample = await pool.request().query(`SELECT TOP 5 * FROM [${tableName}]`);
        console.log('  -- דוגמה (עד 5 שורות) --');
        sample.recordset.forEach((row) => console.log('  ', JSON.stringify(row)));
      } catch (e) {
        console.log('  (שגיאה בקריאת דוגמה:', e.message, ')');
      }
    }
  }

  await pool.close();
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
