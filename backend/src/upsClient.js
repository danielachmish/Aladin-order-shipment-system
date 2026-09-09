// לקוח UPS אמיתי ל-API המשלים (סעיף 9.4) — הזדהות בצד שרת, בדיקת סטטוס לפי
// trackingNumber, ובדיקת התאמה תקופתית. פועל רק אם UPS_CLIENT_ID/SECRET מוגדרים
// ב-.env (ר' .env.example); אחרת מדלג בשקט (המערכת ממשיכה לעבוד עם ה-Webhook
// בלבד, שהוא הערוץ הראשי ולא תלוי בזה).
//
// ⚠️ לא נבדק מול UPS אמיתי בסביבה הזו (אין credentials). נתיבי ה-API (/security/v1/oauth/token,
// /api/track/v1/details/{trackingNumber}) הם הנתיבים המתועדים הרשמיים של UPS
// Tracking API; יש לוודא גרסה מדויקת מול ה-onboarding שסופק על ידי UPS.

const { ups: cfg } = require('./config');
const { db } = require('./db');

let cachedToken = null; // { access_token, expires_at }

async function getToken() {
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('UPS_CLIENT_ID/UPS_CLIENT_SECRET לא מוגדרים');
  if (cachedToken && cachedToken.expires_at > Date.now() + 30000) return cachedToken.access_token;

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetch(`${cfg.apiBase}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`UPS OAuth נכשל: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (Number(data.expires_in || 3599) * 1000),
  };
  return cachedToken.access_token;
}

// --- מגבלת קצב פשוטה: 100/דקה לשירות, 1000/שעה סה"כ (סעיף 9.4) ---
const callLog = [];
function checkRateLimit() {
  const now = Date.now();
  while (callLog.length && now - callLog[0] > 3600000) callLog.shift();
  const lastMinute = callLog.filter((t) => now - t < 60000).length;
  if (lastMinute >= 100) throw new Error('חריגת מכסה: 100 קריאות בדקה');
  if (callLog.length >= 1000) throw new Error('חריגת מכסה: 1000 קריאות בשעה');
  callLog.push(now);
}

async function getShipmentStatus(trackingNumber) {
  checkRateLimit();
  const token = await getToken();
  const res = await fetch(`${cfg.apiBase}/api/track/v1/details/${encodeURIComponent(trackingNumber)}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'transId': `aladin-${Date.now()}`, 'transactionSrc': 'aladin' },
  });
  if (!res.ok) throw new Error(`UPS wb-status נכשל (${trackingNumber}): ${res.status}`);
  return res.json();
}

// בדיקת התאמה תקופתית: לא לשאול על משלוח שנאסף לפני יותר מחודש, ולהפסיק אחרי מצב סופי (סעיף 9.4)
const TERMINAL = ['ship_delivered', 'ship_returned'];
async function reconcileActiveShipments() {
  if (!cfg.reconcileEnabled) return { skipped: true };
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT track_no, status FROM shipments
    WHERE (status IS NULL OR status NOT IN (${TERMINAL.map(() => '?').join(',')}))
      AND updated_at >= ?
  `).all(...TERMINAL, monthAgo);

  let checked = 0, failed = 0;
  for (const row of rows) {
    try {
      await getShipmentStatus(row.track_no);
      checked++;
      // הערה: מיפוי התשובה חזרה לפורמט webhook-like ועדכון shipments מושאר
      // ל-upsWebhook.normalizeStatus כשתתאמת סכימת התשובה האמיתית מול ה-API.
    } catch (e) {
      failed++;
      console.error('UPS reconcile נכשל:', row.track_no, e.message);
    }
  }
  db.prepare(`INSERT INTO sync_runs (run_id, source, ok, detail) VALUES (?, 'ups', 1, ?)`)
    .run(`run_${Date.now()}`, JSON.stringify({ checked, failed, total: rows.length }));
  return { checked, failed, total: rows.length };
}

function startReconciliation() {
  if (!cfg.reconcileEnabled) {
    console.log('UPS: API משלים לא מוגדר (.env) — פועל רק עם Webhook (הערוץ הראשי)');
    return;
  }
  console.log(`UPS: בדיקת התאמה תקופתית כל ${cfg.reconcileIntervalMs / 3600000} שעות`);
  const tick = () => reconcileActiveShipments().catch((e) => console.error('UPS reconcile שגיאה:', e.message));
  tick();
  setInterval(tick, cfg.reconcileIntervalMs);
}

module.exports = { getToken, getShipmentStatus, reconcileActiveShipments, startReconciliation };
