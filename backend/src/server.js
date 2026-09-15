const http = require('http');
const express = require('express');
const cors = require('cors');
const { isNew } = require('./db');
const routes = require('./routes');
const { attachRealtime } = require('./realtime');
const { sigma: sigmaCfg, ups: upsCfg, corsOrigins } = require('./config');

if (isNew) {
  console.log('מסד נתונים חדש זוהה — מריץ seed ראשוני...');
  require('./seed');
}

const app = express();
// נדרש כדי ש-req.ip יזהה נכון את כתובת הלקוח האמיתית (לא את ה-proxy הפנימי של
// Render) — קריטי להגבלת הקצב על /auth/login (ר' routes.js loginRateLimit).
app.set('trust proxy', 1);
// תיקון אבטחה (סקירה 14.9.2026): הוגבל למקורות ידועים (ר' config.js corsOrigins)
// במקום cors() פתוח שקיבל בקשות מכל אתר באינטרנט.
app.use(cors({ origin: corsOrigins }));
app.use(express.json());

// PHP-proxy shim לפריסת Cloudways: ה-nginx שם מעביר ל-Apache רק בקשות
// שמסתיימות ב-.php (ר' frontend/public/.htaccess), אז הבקשות מגיעות כ-
// /api.php?_p=<הנתיב האמיתי>. שאר הפריסות (Render וכו') לא עוברות כאן כי
// ה-frontend שלהן בונה כתובות /api רגילות (ר' frontend/src/api.js).
app.use('/api.php', (req, res, next) => {
  const target = req.query._p;
  if (typeof target !== 'string' || !target.startsWith('/')) {
    return res.status(400).json({ error: 'bad proxy request' });
  }
  req.url = target;
  routes(req, res, next);
});

app.use('/api', routes);

const PORT = process.env.PORT || 4310;
const server = http.createServer(app);
attachRealtime(server);

server.listen(PORT, () => {
  console.log(`Aladin backend רץ על http://localhost:${PORT}`);
  console.log(`WebSocket חי על ws://localhost:${PORT}/api/live`);
  console.log(`Sigma: ${sigmaCfg.enabled ? `מחובר (${sigmaCfg.server})` : 'MOCK (לא מוגדר ב-.env)'}`);
  console.log(`UPS webhook auth: ${upsCfg.webhookBearerSecret ? 'פעיל' : 'כבוי (מצב פיתוח, ר\' .env.example)'}`);
  console.log(`UPS API משלים: ${upsCfg.reconcileEnabled ? 'פעיל' : 'כבוי (פועל עם Webhook בלבד)'}`);

  // מתחילים את הפולינג האמיתי רק אחרי שהשרת כבר מאזין, כדי שכשל חיבור לא ימנע עלייה
  require('./realSigmaBridge').startPolling();
  require('./upsClient').startReconciliation();
});
