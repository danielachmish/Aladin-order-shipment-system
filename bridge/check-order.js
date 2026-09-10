// בדיקה חד-פעמית: מציג את כל השדות של הזמנה ספציפית (כותרת + שורות),
// כדי לזהות איזה שדה מייצג "יתרה לשרשור" (חשבונית).
// שימוש: node check-order.js 54464
require('dotenv').config();
const sql = require('mssql');

const orderNum = Number(process.argv[2]);
if (!orderNum) {
  console.log('שימוש: node check-order.js <מספר הזמנה>');
  process.exit(1);
}

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

  console.log(`\n===== כותרת הזמנה ${orderNum} =====`);
  const header = await pool.request()
    .input('c', sql.Int, companyId).input('s', sql.Int, sidra).input('n', sql.Int, orderNum)
    .query('SELECT * FROM azmana_index WHERE CompanyID=@c AND sidra=@s AND azmana_num=@n');
  console.log(JSON.stringify(header.recordset[0], null, 2));

  console.log(`\n===== שורות הזמנה ${orderNum} =====`);
  const lines = await pool.request()
    .input('c', sql.Int, companyId).input('s', sql.Int, sidra).input('n', sql.Int, orderNum)
    .query('SELECT * FROM azmanot WHERE CompanyID=@c AND sidra=@s AND azmana_num=@n ORDER BY pline');
  lines.recordset.forEach((row) => console.log(JSON.stringify(row, null, 2)));

  await pool.close();
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
