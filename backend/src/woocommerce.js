// אינטגרציית קריאה-בלבד מול WooCommerce (אתר המכירות) — ר' ייעוץ 16.9.2026.
// שונה לגמרי מ-Sigma: זה אתר המכירות (מקור אמת לתצוגה ללקוחות), לא ה-ERP.
// בכוונה לא סוגר/פותח מוצרים אוטומטית — רק שולפת סטטוס (GET) כדי שמנהל
// מחסן יחליט בעצמו. פרטי החיבור מנוהלים ע"י system_admin בלבד (settings.js
// בפרונט), נשמרים בטבלת settings הקיימת - לא ב-env, כי דניאל ביקש שדה
// שאפשר למלא ולעדכן מה-UI, לא רק דרך משתני סביבה בשרת.
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

module.exports = { getConfig, isConfigured, getMaskedSettings, saveSettings, testConnection, getProductStatusBySku };
