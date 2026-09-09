// תצורת חיבורים אמיתיים — נטענת מ-.env (ר' .env.example). כל עוד המשתנים
// הרלוונטיים לא מוגדרים, המערכת ממשיכה לעבוד עם ה-MOCK הקיים (sigmaBridgeMock,
// webhook בלי אימות Bearer) כדי שסביבת הפיתוח לא תישבר.
require('dotenv').config();

const sigma = {
  enabled: !!process.env.SIGMA_SQL_SERVER,
  server: process.env.SIGMA_SQL_SERVER,
  port: Number(process.env.SIGMA_SQL_PORT || 1433),
  database: process.env.SIGMA_SQL_DATABASE,
  user: process.env.SIGMA_SQL_USER,
  password: process.env.SIGMA_SQL_PASSWORD,
  encrypt: process.env.SIGMA_SQL_ENCRYPT !== 'false',
  trustServerCertificate: process.env.SIGMA_SQL_TRUST_CERT === 'true',
  companyId: Number(process.env.SIGMA_COMPANY_ID || 3),
  sidra: Number(process.env.SIGMA_SIDRA || 0),
  pollIntervalMs: Number(process.env.SIGMA_POLL_INTERVAL_MS || 45000), // "כל 30 עד 60 שניות" (סעיף 8.3)
};

const ups = {
  // OAuth (API משלים, סעיף 9.4) — לא חובה כדי לקבל Webhook, רק לשאילתות סטטוס יזומות
  clientId: process.env.UPS_CLIENT_ID,
  clientSecret: process.env.UPS_CLIENT_SECRET,
  apiBase: process.env.UPS_API_BASE || 'https://onlinetools.ups.com/api',
  reconcileEnabled: !!(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET),
  reconcileIntervalMs: Number(process.env.UPS_RECONCILE_INTERVAL_MS || 60 * 60 * 1000), // "אחת לשעה" (סעיף 9.4)
  // Webhook (הערוץ הראשי) — סוד Bearer שסוכם מול UPS מול hd@ups.co.il (סעיף 9.2, 13)
  webhookBearerSecret: process.env.UPS_WEBHOOK_BEARER_SECRET || null,
};

module.exports = { sigma, ups };
