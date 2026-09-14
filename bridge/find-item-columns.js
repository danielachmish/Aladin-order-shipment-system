// סקריפט אבחון: מאתר עמודות של "מיקום פיזי במחסן" ו"ברקוד" בסיגמא.
// לא משנה שום דבר בבסיס הנתונים — קריאה בלבד (SELECT).
//
// למה צריך את זה: אנחנו כבר יודעים שסיגמא מחזיקה את שני השדות האלה,
// אבל לא את שם הטבלה/העמודה המדויקים אצל דניאל (יכול להשתנות בין
// גרסאות/התקנות סיגמא). הסקריפט מריץ שני סבבי חיפוש:
//   1. לפי שם עמודה (LIKE על מילים נרדפות בעברית/אנגלית).
//   2. בדיקה ממוקדת על טבלת הפריטים המרכזית אם היא נמצאת (למשל "pratim"),
//      ועל טבלת שורות ההזמנה עצמה (azmanot) — למקרה שהמיקום/ברקוד נשמרים
//      שם ולא בטבלת פריטים נפרדת.
//
// הרצה (מתיקיית bridge/, עם .env מוגדר כמו לריצת sync.js הרגילה):
//   node find-item-columns.js
//
// אחרי שמריצים — מעתיקים את כל הפלט ושולחים לקלוד. משם ההרחבה של
// sync.js + sigmaIngest.js + PickChecklist.jsx היא עניין של דקות.

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

// מילות מפתח לחיפוש עמודות רלוונטיות (עברית מתועתקת + אנגלית נפוצה בסיגמא/ERP)
const LOCATION_PATTERNS = ['%mikum%', '%makom%', '%maadaf%', '%location%', '%shelf%', '%mihsan%', '%warehouse%', '%bin%'];
const BARCODE_PATTERNS = ['%barcode%', '%bar_code%', '%berekod%', '%ean%', '%bar%kod%'];

async function searchColumns(pool, patterns, label) {
  console.log(`\n===== חיפוש עמודות "${label}" לפי שם =====`);
  const likeClauses = patterns.map((_, i) => `COLUMN_NAME LIKE @p${i}`).join(' OR ');
  const req = pool.request();
  patterns.forEach((p, i) => req.input(`p${i}`, sql.VarChar, p));
  const res = await req.query(`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE ${likeClauses}
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);
  if (res.recordset.length === 0) {
    console.log('  (לא נמצא לפי שם עמודה — יכול להיות שם עברי לא-מתועתק, ר\' בדיקת טבלת פריטים למטה)');
  } else {
    res.recordset.forEach((r) => console.log(`  ${r.TABLE_NAME}.${r.COLUMN_NAME}  (${r.DATA_TYPE})`));
  }
  return res.recordset;
}

async function findItemsMasterTable(pool) {
  console.log('\n===== חיפוש טבלת "פריטים" מרכזית (קטלוג מק"טים) =====');
  const res = await pool.request().query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE '%prat%' OR TABLE_NAME LIKE '%item%' OR TABLE_NAME LIKE '%prit%'
       OR TABLE_NAME LIKE '%stock%' OR TABLE_NAME LIKE '%mlai%' OR TABLE_NAME LIKE '%katalog%'
  `);
  res.recordset.forEach((r) => console.log(`  ${r.TABLE_NAME}`));
  return res.recordset.map((r) => r.TABLE_NAME);
}

async function dumpTable(pool, tableName) {
  console.log(`\n----- כל העמודות של ${tableName} -----`);
  const cols = await pool.request()
    .input('t', sql.VarChar, tableName)
    .query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`);
  cols.recordset.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));
  try {
    const sample = await pool.request().query(`SELECT TOP 3 * FROM [${tableName}]`);
    console.log('  -- דוגמה (עד 3 שורות) --');
    sample.recordset.forEach((row) => console.log('  ', JSON.stringify(row)));
  } catch (e) {
    console.log('  (שגיאה בקריאת דוגמה:', e.message, ')');
  }
}

async function main() {
  const pool = await sql.connect(cfg);

  await searchColumns(pool, LOCATION_PATTERNS, 'מיקום פיזי');
  await searchColumns(pool, BARCODE_PATTERNS, 'ברקוד');

  const itemTables = await findItemsMasterTable(pool);
  for (const t of itemTables) {
    await dumpTable(pool, t);
  }

  // בדיקה נקודתית: אולי המיקום/ברקוד נמצאים כבר בטבלת שורות ההזמנה עצמה
  // (azmanot) ולא בטבלת פריטים נפרדת — נדפיס גם אותה במלואה ליתר ביטחון.
  console.log('\n===== לשם השוואה: כל העמודות של azmanot (טבלת שורות ההזמנה שכבר משתמשים בה) =====');
  await dumpTable(pool, 'azmanot');

  await pool.close();
  console.log('\n===== סיום. יש להעתיק את כל הפלט מעלה ולשלוח =====');
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
