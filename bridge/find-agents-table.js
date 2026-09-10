// מחפש טבלה שקשורה לסוכנים, ואז מציג את העמודות שלה + כמה שורות דוגמה.
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

  console.log('\n===== טבלאות שהשם שלהן מרמז על "סוכן" =====');
  const tables = await pool.request().query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE '%sochen%' OR TABLE_NAME LIKE '%sochnim%'
       OR TABLE_NAME LIKE '%agent%' OR TABLE_NAME LIKE '%Agent%'
       OR TABLE_NAME LIKE '%sohen%'
  `);
  if (tables.recordset.length === 0) {
    console.log('לא נמצאה טבלה עם שם כזה. מריץ חיפוש רחב יותר לפי עמודה agent_ID...');
    const byColumn = await pool.request().query(`
      SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE COLUMN_NAME LIKE '%agent%' OR COLUMN_NAME LIKE '%Agent%'
    `);
    byColumn.recordset.forEach((r) => console.log(`  ${r.TABLE_NAME}.${r.COLUMN_NAME}`));
    await pool.close();
    return;
  }

  for (const t of tables.recordset) {
    const tableName = t.TABLE_NAME;
    console.log(`\n----- טבלה: ${tableName} -----`);
    const cols = await pool.request()
      .input('t', sql.VarChar, tableName)
      .query(`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`);
    cols.recordset.forEach((c) => console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`));

    try {
      const sample = await pool.request().query(`SELECT TOP 5 * FROM [${tableName}]`);
      console.log(`  -- דוגמה (עד 5 שורות) --`);
      sample.recordset.forEach((row) => console.log('  ', JSON.stringify(row)));
    } catch (e) {
      console.log('  (שגיאה בקריאת דוגמה:', e.message, ')');
    }
  }

  await pool.close();
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
