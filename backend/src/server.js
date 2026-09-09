const http = require('http');
const express = require('express');
const cors = require('cors');
const { isNew } = require('./db');
const routes = require('./routes');
const { attachRealtime } = require('./realtime');
const { sigma: sigmaCfg, ups: upsCfg } = require('./config');

if (isNew) {
  console.log('מסד נתונים חדש זוהה — מריץ seed ראשוני...');
  require('./seed');
}

const app = express();
app.use(cors());
app.use(express.json());
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
