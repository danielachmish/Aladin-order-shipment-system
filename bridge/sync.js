// Sigma Bridge מקומי — רץ על השרת הפיזי (איפה שה-SQL Server נמצא), קורא
// הזמנות פעילות/ששונו ודוחף אותן ל-backend של אלדין בענן דרך HTTPS יוצא.
// אף פעם לא נפתח חיבור נכנס אל תוך הרשת המקומית (סעיף 7 באפיון: "סנכרון
// יוצא בלבד"; סעיף 13: "SQL Server של סיגמא אינו חשוף לאינטרנט").
//
// שמות העמודות אומתו מול הסכימה האמיתית ב-10.9.2026 (ר' bridge/inspect-schema.js):
// azmana_index: אין cust_name/order_date/source_status — יש dorder, sum (סכום
// כולל מע"מ), canceled (bit), ומאזני מקושר דרך maazni_ID. שם הלקוח מגיע מ-
// maazni.name (JOIN לפי CompanyID+maazni_ID). אין עמודת delivery_date או notes
// גנרית בטבלה — לכן delivery_date ו-notes נשארים ריקים בינתיים.

require('dotenv').config();
const sql = require('mssql');

// שם Instance (למשל SQLSIGMA) — נפוץ בהתקנות Sigma. כשיש Instance, לא קובעים
// port קבוע; mssql/tedious פונה ל-SQL Server Browser (UDP 1434) כדי לאתר את
// הפורט האמיתי של ה-instance לבד.
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
if (!instanceName) {
  cfg.port = Number(process.env.SIGMA_SQL_PORT || 1433);
}
const companyId = Number(process.env.SIGMA_COMPANY_ID || 3);
// גילינו ב-13.9.2026 שיש בסיגמא כמה "סדרות" (sidra) של הזמנות רגילות באותה
// חברה (למשל 0 ו-99) — לא רק סדרה אחת. סינון קשיח ל-sidra יחיד החסיר הזמנות
// אמיתיות מהתור. לכן כברירת מחדל שולפים את כל הסדרות של החברה (בלי סינון
// sidra כלל). אם בעתיד תרצו להגביל לרשימה ספציפית, אפשר למלא SIGMA_SIDRAS
// (רשימה מופרדת בפסיקים, למשל "0,99") — ריק = כל הסדרות.
const sidraFilter = (process.env.SIGMA_SIDRAS || '').trim();
const allowedSidras = sidraFilter ? sidraFilter.split(',').map((s) => Number(s.trim())) : null;
const targetUrl = process.env.BRIDGE_TARGET_URL;
const bridgeSecret = process.env.SIGMA_BRIDGE_SECRET;
const intervalMs = Number(process.env.SYNC_INTERVAL_MS || 45000);

// שעות פעילות: מסתנכרן רק בין השעות האלה (שעון המחשב המקומי — השרת הפיזי
// יושב בישראל, אז זה שעון ישראל). מחוץ לשעות אלה השירות ממשיך לרוץ ברקע
// (לא צריך להפעיל/לכבות ידנית) אבל פשוט מדלג על הסנכרון בפועל.
const activeHourStart = Number(process.env.SYNC_ACTIVE_HOUR_START ?? 8);
const activeHourEnd = Number(process.env.SYNC_ACTIVE_HOUR_END ?? 17);
let wasInActiveWindow = null; // למניעת הצפת לוגים - מדווחים רק על שינוי מצב

function isInActiveWindow() {
  const hour = new Date().getHours();
  return hour >= activeHourStart && hour < activeHourEnd;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

if (!cfg.server || !targetUrl || !bridgeSecret) {
  log('חסרים משתני סביבה חובה (SIGMA_SQL_SERVER / BRIDGE_TARGET_URL / SIGMA_BRIDGE_SECRET). ר\' .env.example');
  process.exit(1);
}

let pool = null;
async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(cfg);
  return pool;
}

// "הרצה ראשונה טוענת הזמנות פתוחות וטווח זמן מוסכם בלבד" (סעיף 8.3).
// "פתוחה לליקוט" אומתה מול דניאל (10.9.2026): status_ID=0 = ההזמנה עדיין
// אצל המזכירה (לא הודפסה, לא רלוונטית למחסן). status_ID=6 = הודפסה
// והועברה למחסן — זה מה שנכנס לתור "ממתינה לליקוט". חלון 30 יום נשאר
// כרשת ביטחון כדי לא למשוך היסטוריה ישנה בלי גבול.
// ⚠️ ידוע וטרם טופל: חלק מההזמנות שמשורשרות ישר לחשבונית (בלי ליקוט
// פיזי) נשארות תקועות ב-status_ID=6 גם אחרי שהן בפועל סגורות. צריך עוד
// כלל (למשל בדיקת שרשור לחשבונית) כדי לסנן אותן החוצה — לא ממומש עדיין.
async function fetchOpenOrders() {
  const p = await getPool();
  const headers = await p.request()
    .input('companyId', sql.Int, companyId)
    .query(`
      SELECT h.CompanyID, h.sidra, h.azmana_num,
             m.name AS [customer_name],
             h.dorder AS [order_date],
             h.FCreateDate AS [created_at],
             h.sum AS [total_amount],
             h.canceled AS [canceled],
             ag.agent_name AS [agent_name]
      FROM azmana_index h
      LEFT JOIN maazni m ON m.CompanyID = h.CompanyID AND m.maazni_ID = h.maazni_ID
      LEFT JOIN t_agents ag ON ag.agent_ID = h.agent_ID
      WHERE h.CompanyID = @companyId
        -- הוסר סינון sidra יחיד — יש כמה סדרות הזמנות רגילות (0, 99, ...).
        -- אם הוגדר SIGMA_SIDRAS בסביבה, מסננים בקוד למטה לפי הרשימה.
        AND h.canceled = 0
        AND h.status_ID = 6
        -- אומת מול הזמנה 54464 (10.9.2026): אם כל השורות tquan=0, ההזמנה כבר
        -- שורשרה במלואה לחשבונית ואין מה לליקוט למרות שהיא עדיין status_ID=6
        AND EXISTS (
          SELECT 1 FROM azmanot a
          WHERE a.CompanyID = h.CompanyID AND a.sidra = h.sidra AND a.azmana_num = h.azmana_num
            AND a.canceled = 0 AND a.tquan > 0
        )
        AND h.dorder >= DATEADD(day, -30, GETDATE())
    `);

  const filteredHeaders = allowedSidras
    ? headers.recordset.filter((h) => allowedSidras.includes(h.sidra))
    : headers.recordset;

  // כל הסדרות הקיימות בפועל אצל החברה — נדרש כדי לדעת אילו סדרות לנקות
  // (reconcile) גם אם ברגע זה אין בהן אף הזמנה פתוחה (כלומר כולן נסגרו).
  const allSidraRows = await p.request()
    .input('companyId', sql.Int, companyId)
    .query(`SELECT DISTINCT sidra FROM azmana_index WHERE CompanyID = @companyId`);
  const knownSidras = allowedSidras || allSidraRows.recordset.map((r) => r.sidra);

  const orders = [];
  for (const h of filteredHeaders) {
    const lines = await p.request()
      .input('companyId', sql.Int, h.CompanyID)
      .input('sidra', sql.Int, h.sidra)
      .input('orderNum', sql.Int, h.azmana_num)
      .query(`
        -- location/barcode: תוקן 14.9.2026 (בדיקה בפועל מול הזמנה עם JBL FLIP 7) —
        -- הטבלה הנכונה היא "pritim" (טבלת קטלוג הפריטים האמיתית, ממוינת לפי
        -- CompanyID), לא TDemoPritim (שם דומה אבל לא בשימוש בפועל אצל דניאל).
        -- ר' PICKING_QC_SPEC.md סעיף 11. נופל בחזרה ל-azmanot.FBarCode אם אין
        -- ברקוד בקטלוג. stock_place בקטלוג נמצא ריק אצל רוב הפריטים שנבדקו —
        -- ייתכן שהמיקום הפיזי בפועל לא מנוהל בשדה הזה אצל דניאל (בבירור).
        --
        -- itemCode: תוקן 14.9.2026 (דיווח דניאל) — קודם הוצג a.prit_ID, שהוא
        -- מזהה פנימי מספרי חסר משמעות ("19460" וכו'), לא מק"ט אמיתי. עכשיו
        -- מציגים את pritim.prit_code (המק"ט הקריא, למשל "1090010211"), עם
        -- נפילה חזרה למזהה הפנימי רק אם מסיבה כלשהי הפריט לא נמצא בקטלוג.
        SELECT a.pline AS [lineNo], COALESCE(pr.prit_code, CAST(a.prit_ID AS varchar(50))) AS [itemCode], a.pname AS [itemName], a.quant AS [quantity], a.pprice AS [price],
               NULLIF(LTRIM(RTRIM(pr.stock_place)), '') AS [location],
               COALESCE(NULLIF(LTRIM(RTRIM(pr.barCode)), ''), NULLIF(LTRIM(RTRIM(a.FBarCode)), '')) AS [barcode]
        FROM azmanot a
        LEFT JOIN pritim pr ON pr.prit_ID = a.prit_ID AND pr.CompanyID = a.CompanyID
        WHERE a.CompanyID = @companyId AND a.sidra = @sidra AND a.azmana_num = @orderNum
          -- תוקן 14.9.2026 (בדיקה בפועל של דניאל, הזמנה 192821): שורות שכבר
          -- שורשרו במלואן לחשבונית (tquan=0) או בוטלו לא אמורות להופיע
          -- למלקט בכלל — אותו כלל שכבר קיים ברמת ההזמנה (למעלה, ב-fetchOpenOrders)
          -- היה חסר כאן ברמת השורה הבודדת, כך שהזמנה עם שורה אחת פתוחה
          -- הציגה גם את כל השורות הסגורות שלה.
          AND a.canceled = 0 AND a.tquan > 0
        ORDER BY a.pline
      `);
    orders.push({
      companyId: h.CompanyID, sidra: h.sidra, orderNum: h.azmana_num,
      customerName: (h.customer_name || '').trim() || `לקוח ${h.azmana_num}`,
      agentName: (h.agent_name || '').trim() || null,
      orderDate: h.order_date, createdAt: h.created_at, deliveryDate: null,
      totalAmount: h.total_amount, notes: null,
      sourceStatus: h.canceled ? 'cancelled' : 'open',
      items: lines.recordset,
    });
  }
  return { orders, knownSidras };
}

// הזמנות status_ID=0 ("ללא סטטוס" — עדיין אצל המזכירה, לא הודפסו). נשלפות
// בנפרד לתצוגה בלבד (לא נכנסות לתור הליקוט) — ר' bridge/sync.js תיעוד מעלה.
async function fetchPendingOrders() {
  const p = await getPool();
  const headers = await p.request()
    .input('companyId', sql.Int, companyId)
    .query(`
      SELECT h.CompanyID, h.sidra, h.azmana_num,
             m.name AS [customer_name],
             h.dorder AS [order_date],
             h.FCreateDate AS [created_at],
             h.sum AS [total_amount],
             ag.agent_name AS [agent_name]
      FROM azmana_index h
      LEFT JOIN maazni m ON m.CompanyID = h.CompanyID AND m.maazni_ID = h.maazni_ID
      LEFT JOIN t_agents ag ON ag.agent_ID = h.agent_ID
      WHERE h.CompanyID = @companyId
        AND h.canceled = 0
        AND h.status_ID = 0
        AND h.dorder >= DATEADD(day, -30, GETDATE())
    `);

  const filteredHeaders = allowedSidras
    ? headers.recordset.filter((h) => allowedSidras.includes(h.sidra))
    : headers.recordset;

  return filteredHeaders.map((h) => ({
    companyId: h.CompanyID, sidra: h.sidra, orderNum: h.azmana_num,
    customerName: (h.customer_name || '').trim() || `לקוח ${h.azmana_num}`,
    agentName: (h.agent_name || '').trim() || null,
    orderDate: h.order_date, createdAt: h.created_at, totalAmount: h.total_amount,
  }));
}

async function pushPending(orders) {
  const res = await fetch(targetUrl.replace(/\/sigma-sync$/, '/sigma-sync/pending'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bridgeSecret}` },
    body: JSON.stringify({ orders }),
  });
  if (!res.ok) throw new Error(`דחיפת ממתינות נכשלה: ${res.status} ${await res.text()}`);
  return res.json();
}

async function reconcilePending(orders, knownSidras) {
  const bySidra = new Map();
  for (const o of orders) {
    if (!bySidra.has(o.sidra)) bySidra.set(o.sidra, []);
    bySidra.get(o.sidra).push(o.orderNum);
  }
  for (const s of knownSidras || []) {
    if (!bySidra.has(s)) bySidra.set(s, []);
  }
  const url = targetUrl.replace(/\/sigma-sync$/, '/sigma-sync/pending/reconcile');
  let totalChecked = 0, totalRemoved = 0;
  for (const [s, validOrderNums] of bySidra) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bridgeSecret}` },
      body: JSON.stringify({ companyId, sidra: s, validOrderNums }),
    });
    if (!res.ok) throw new Error(`ניקוי ממתינות נכשל (סדרה ${s}): ${res.status} ${await res.text()}`);
    const r = await res.json();
    totalChecked += r.checked || 0;
    totalRemoved += r.removed || 0;
  }
  return { checked: totalChecked, removed: totalRemoved };
}

const BATCH_SIZE = 50; // דוחפים בחבילות קטנות כדי לא לחרוג ממגבלת גודל בקשה

async function pushBatch(orders) {
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bridgeSecret}` },
    body: JSON.stringify({ orders }),
  });
  if (!res.ok) throw new Error(`דחיפה נכשלה: ${res.status} ${await res.text()}`);
  return res.json();
}

async function pushOrders(orders) {
  if (orders.length === 0) return { received: 0, created: 0, updated: 0 };
  let created = 0, updated = 0;
  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const batch = orders.slice(i, i + BATCH_SIZE);
    const result = await pushBatch(batch);
    created += result.created || 0;
    updated += result.updated || 0;
  }
  return { received: orders.length, created, updated };
}

// סוגר אוטומטית בענן הזמנות "ממתינות לליקוט" שכבר לא ברשימת ה-orders הנוכחית
// (למשל שורשרו במלואה לחשבונית, בוטלו, או חזרו סטטוס). לא נוגע בהזמנות בעבודה.
// מאז שביטלנו סינון sidra יחיד, ה-orders עשויים להשתייך למספר סדרות — מריצים
// ניקוי בנפרד לכל סדרה (אחרת "מנקים" בטעות הזמנות מסדרה שלא סונכרנה בכלל בסבב הזה).
const reconcileUrl = targetUrl.replace(/\/sigma-sync$/, '/sigma-sync/reconcile');
async function reconcile(orders, knownSidras) {
  const bySidra = new Map();
  for (const o of orders) {
    if (!bySidra.has(o.sidra)) bySidra.set(o.sidra, []);
    bySidra.get(o.sidra).push(o.orderNum);
  }
  // גם אם אין הזמנות פתוחות באחת הסדרות הידועות בסבב הזה (כולן נסגרו/שורשרו),
  // עדיין צריך לנקות אותה — לא רק סדרות שיש בהן כרגע הזמנות פתוחות.
  for (const s of knownSidras || []) {
    if (!bySidra.has(s)) bySidra.set(s, []);
  }

  let totalChecked = 0, totalClosed = 0;
  for (const [s, validOrderNums] of bySidra) {
    const res = await fetch(reconcileUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bridgeSecret}` },
      body: JSON.stringify({ companyId, sidra: s, validOrderNums }),
    });
    if (!res.ok) throw new Error(`ניקוי נכשל (סדרה ${s}): ${res.status} ${await res.text()}`);
    const r = await res.json();
    totalChecked += r.checked || 0;
    totalClosed += r.closed || 0;
  }
  return { checked: totalChecked, closed: totalClosed };
}

// מיפוי פריט->ספק (ר' ייעוץ 16.9.2026, נושא 5 "חוסרים לפי ספק"; אומת ידנית
// מול פריט 106013 -> maazni_ID 800504 "אנביטק גרופ בע״מ"). קטלוג שמשתנה לאט —
// מסתנכרן בנפרד מהזמנות, על מרווח זמן משלו (SUPPLIER_SYNC_INTERVAL_MS), לא
// בכל tick של הזמנות.
const supplierSyncIntervalMs = Number(process.env.SUPPLIER_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6 שעות

async function fetchItemSuppliers() {
  const p = await getPool();
  const rows = await p.request()
    .input('companyId', sql.Int, companyId)
    .query(`
      SELECT pr.prit_code AS [itemCode], pr.FLinkToMaazni AS [supplierId], m.name AS [supplierName]
      FROM pritim pr
      JOIN maazni m ON m.CompanyID = pr.CompanyID AND m.maazni_ID = pr.FLinkToMaazni
      WHERE pr.CompanyID = @companyId AND pr.FLinkToMaazni IS NOT NULL AND pr.FLinkToMaazni <> 0
    `);
  return rows.recordset.map((r) => ({
    itemCode: r.itemCode, supplierId: r.supplierId, supplierName: (r.supplierName || '').trim() || null,
  }));
}

const supplierSyncUrl = targetUrl.replace(/\/sigma-sync$/, '/sigma-sync/suppliers');
async function pushItemSuppliers(items) {
  const res = await fetch(supplierSyncUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bridgeSecret}` },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`דחיפת ספקים נכשלה: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supplierTick() {
  try {
    const items = await fetchItemSuppliers();
    const result = await pushItemSuppliers(items);
    log(`מיפוי ספקים: ${items.length} פריטים משוייכים ->`, result);
  } catch (e) {
    log('שגיאת סנכרון ספקים:', e.message);
  }
}

async function tick() {
  const active = isInActiveWindow();
  if (active !== wasInActiveWindow) {
    log(active
      ? `נכנס לשעות פעילות (${activeHourStart}:00–${activeHourEnd}:00) — מתחיל לסנכרן`
      : `מחוץ לשעות פעילות (${activeHourStart}:00–${activeHourEnd}:00) — משהה סנכרון עד שעה ${activeHourStart}:00`);
    wasInActiveWindow = active;
  }
  if (!active) return;

  try {
    const { orders, knownSidras } = await fetchOpenOrders();
    const result = await pushOrders(orders);
    const recon = await reconcile(orders, knownSidras);
    log(`סונכרנו ${orders.length} הזמנות (סדרות: ${knownSidras.join(',')}) ->`, result, `| ניקוי: ${recon.closed} נסגרו מתוך ${recon.checked} שנבדקו`);

    const pending = await fetchPendingOrders();
    const pendingResult = await pushPending(pending);
    const pendingRecon = await reconcilePending(pending, knownSidras);
    log(`ממתינות לאישור: ${pending.length} ->`, pendingResult, `| ניקוי: ${pendingRecon.removed} הוסרו מתוך ${pendingRecon.checked} שנבדקו`);
  } catch (e) {
    log('שגיאת סנכרון:', e.message);
  }
}

const serverDesc = instanceName ? `${cfg.server}\\${instanceName}` : `${cfg.server}:${cfg.port}`;
log(`Sigma Bridge מקומי מתחיל. שרת SQL: ${serverDesc}/${cfg.database}. יעד: ${targetUrl}. כל ${intervalMs / 1000} שניות, בין השעות ${activeHourStart}:00–${activeHourEnd}:00.`);
tick();
setInterval(tick, intervalMs);

log(`מיפוי ספקים (pritim/maazni) יסתנכרן כל ${supplierSyncIntervalMs / 1000 / 60} דקות, לא כפוף לשעות פעילות (קטלוג, לא תור עבודה).`);
supplierTick();
setInterval(supplierTick, supplierSyncIntervalMs);
