// אינטגרציית WooCommerce (אתר המכירות) — ר' ייעוץ 16-17.9.2026. שונה לגמרי
// מ-Sigma: זה אתר המכירות (מקור אמת לתצוגה ללקוחות), לא ה-ERP. פרטי החיבור
// מנוהלים ע"י system_admin בלבד, נשמרים בטבלת settings הקיימת - לא ב-env,
// כי דניאל ביקש שדה שאפשר למלא ולעדכן מה-UI.
//
// עדכון 17.9.2026: סגירת מוצר (stock_status=outofstock) כן קורית אוטומטית —
// אבל ורק ברגע שהבודק (לא המלקט) מאשר סופית שהפריט חסר (ר' workflow.js
// propagateConfirmedShortages, נקרא מ-finishCheck). פתיחה מחדש נשארת ידנית
// לגמרי (מסך "חזר למלאי") — כי מחירים יכולים להשתנות בינתיים.
const { db } = require('./db');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

function getConfig() {
  return {
    storeUrl: getSetting('woocommerce_store_url'),
    consumerKey: getSetting('woocommerce_consumer_key'),
    consumerSecret: getSetting('woocommerce_consumer_secret'),
  };
}

function isConfigured(cfg = getConfig()) {
  return !!(cfg.storeUrl && cfg.consumerKey && cfg.consumerSecret);
}

function mask(secret) {
  if (!secret) return null;
  if (secret.length <= 4) return '*'.repeat(secret.length);
  return '*'.repeat(secret.length - 4) + secret.slice(-4);
}

function getMaskedSettings() {
  const cfg = getConfig();
  return {
    storeUrl: cfg.storeUrl || null,
    consumerKeyMasked: mask(cfg.consumerKey),
    consumerSecretMasked: mask(cfg.consumerSecret),
    configured: isConfigured(cfg),
  };
}

// storeUrl ריק מפורשות (מחרוזת ריקה) מוחק אותו; consumerKey/consumerSecret
// ריקים = "לא לשנות" (כדי שאפשר לעדכן רק את ה-URL בלי להקליד מחדש סודות
// שכבר שמורים בכל פעם — הם ממילא לא חוזרים גלויים מה-GET).
function saveSettings({ storeUrl, consumerKey, consumerSecret }) {
  if (storeUrl != null) setSetting('woocommerce_store_url', String(storeUrl).trim().replace(/\/+$/, ''));
  if (consumerKey) setSetting('woocommerce_consumer_key', String(consumerKey).trim());
  if (consumerSecret) setSetting('woocommerce_consumer_secret', String(consumerSecret).trim());
  return getMaskedSettings();
}

function authHeader(cfg) {
  const token = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
  return `Basic ${token}`;
}

async function testConnection() {
  const cfg = getConfig();
  if (!isConfigured(cfg)) return { ok: false, message: 'חסרים פרטי חיבור (כתובת חנות / מפתחות)' };
  try {
    const res = await fetch(`${cfg.storeUrl}/wp-json/wc/v3/products?per_page=1`, {
      headers: { Authorization: authHeader(cfg) },
    });
    if (!res.ok) return { ok: false, message: `WooCommerce החזיר שגיאה (${res.status})` };
    return { ok: true, message: 'החיבור תקין' };
  } catch (e) {
    return { ok: false, message: `שגיאת רשת: ${e.message}` };
  }
}

// סטטוס מוצר לפי SKU - GET בלבד, לא כותב כלום באתר. משמש מסך "חוסרי מלאי"
// למנהל מחסן כדי להחליט אם לסגור/לפתוח את המוצר ידנית (ר' ייעוץ 16.9.2026,
// סעיף 2: "לא רוצה שזה יפתח אוטומט... אלא שיציג למנהל מחסן שהמוצר סגור").
async function getProductStatusBySku(sku) {
  const cfg = getConfig();
  if (!isConfigured(cfg)) throw Object.assign(new Error('WooCommerce לא מוגדר'), { status: 400 });
  const url = `${cfg.storeUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}`;
  const res = await fetch(url, { headers: { Authorization: authHeader(cfg) } });
  if (!res.ok) throw Object.assign(new Error(`WooCommerce החזיר שגיאה (${res.status})`), { status: 502 });
  const list = await res.json();
  if (!Array.isArray(list) || list.length === 0) return { found: false, sku };
  const p = list[0];
  return {
    found: true, sku, id: p.id, name: p.name, price: p.price,
    stock_status: p.stock_status, permalink: p.permalink,
  };
}

// סגירת מוצר באתר (stock_status=outofstock) לפי SKU — נקראת רק אחרי אישור
// סופי של בודק QC (ר' workflow.js). לא זורקת אם WooCommerce לא מוגדר או אם
// המוצר לא נמצא באתר — פשוט מדווחת "skipped", כדי שקריאה אוטומטית לא תרעיש
// לוגים אצל לקוחות בלי חיבור מוגדר.
async function closeProductBySku(sku) {
  const cfg = getConfig();
  if (!isConfigured(cfg)) return { skipped: true, reason: 'WooCommerce לא מוגדר' };

  const lookupRes = await fetch(`${cfg.storeUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}`, {
    headers: { Authorization: authHeader(cfg) },
  });
  if (!lookupRes.ok) throw new Error(`חיפוש מוצר נכשל (${lookupRes.status})`);
  const list = await lookupRes.json();
  if (!Array.isArray(list) || list.length === 0) return { skipped: true, reason: 'מוצר לא נמצא באתר' };

  const productId = list[0].id;
  const updateRes = await fetch(`${cfg.storeUrl}/wp-json/wc/v3/products/${productId}`, {
    method: 'PUT',
    headers: { Authorization: authHeader(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({ stock_status: 'outofstock' }),
  });
  if (!updateRes.ok) throw new Error(`עדכון מוצר נכשל (${updateRes.status})`);
  return { closed: true, sku, productId };
}

module.exports = {
  getConfig, isConfigured, getMaskedSettings, saveSettings, testConnection,
  getProductStatusBySku, closeProductBySku,
};
