// אימות: pritim.FLinkToMaazni הוא כנראה ה-FK לספק (חשבון maazni), בפורמט
// 6 ספרות כמו 800504 שדניאל ציין. מציג כמה פריטים שכן משוייכים לספק
// (FLinkToMaazni != 0) עם שם הספק מ-maazni, ובנוסף מסתכל ישירות על
// maazni_ID=800504 (הדוגמה שניתנה) כדי לראות איזה עסק זה.
// הרצה: node inspect-supplier-link.js
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

  console.log('===== maazni WHERE maazni_ID = 800504 (הדוגמה שניתנה) =====');
  try {
    const one = await pool.request().query('SELECT * FROM maazni WHERE maazni_ID = 800504');
    if (one.recordset.length === 0) console.log('(לא נמצא חשבון עם ה-ID הזה)');
    else console.log(JSON.stringify(one.recordset[0], null, 2));
  } catch (e) {
    console.log('שגיאה:', e.message);
  }

  console.log('\n===== 10 פריטים שכן משוייכים לספק דרך FLinkToMaazni, עם שם הספק =====');
  try {
    const rows = await pool.request().query(`
      SELECT TOP 10 p.prit_ID, p.prit_code, p.prit_name, p.FLinkToMaazni, m.name AS supplier_name
      FROM pritim p
      LEFT JOIN maazni m ON m.maazni_ID = p.FLinkToMaazni
      WHERE p.FLinkToMaazni IS NOT NULL AND p.FLinkToMaazni <> 0
    `);
    if (rows.recordset.length === 0) {
      console.log('(לא נמצא אף פריט עם FLinkToMaazni != 0 - יכול להיות שזה שדה אחר, או ששם העמודה ב-maazni לשם שונה מ-"name")');
    } else {
      rows.recordset.forEach((r) => console.log(JSON.stringify(r)));
    }
  } catch (e) {
    console.log('שגיאה:', e.message);
  }

  await pool.close();
}

main().catch((e) => { console.error('שגיאה:', e.message); process.exit(1); });
