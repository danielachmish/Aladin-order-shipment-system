import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';
import UserManagement from '../components/UserManagement.jsx';
import { formatDateSafe } from '../format.js';

// כלי ניהול — הגדרות ותצורה בלבד (לא KPI/מדדים/חריגות/בקשות דחיפות —
// אלה עברו לדשבורד, מסך הבית התפעולי של המנהל). ר' בקשת דניאל 14.9.2026.
export default function ManagementTools({ user }) {
  const [scope, setScope] = useState('all');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  async function load() {
    const [s, st] = await Promise.all([api.getAgentViewScope(), api.integrationsStatus().catch(() => null)]);
    setScope(s.scope);
    setStatus(st);
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => { if (evt.type === 'settings' || evt.type === '__connected') load(); });
    return off;
  }, []);

  async function changeScope(v) {
    setBusy(true);
    try {
      await api.setAgentViewScope(v);
      setScope(v);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="settings-card">
        <div className="settings-card-title">👁️ תצוגת הזמנות לסוכנים</div>
        <div className="toggle-row">
          <span>סוכנים רואים:</span>
          <div className="toggle">
            <button className={scope === 'all' ? 'active' : ''} disabled={busy} onClick={() => changeScope('all')}>כל ההזמנות</button>
            <button className={scope === 'own' ? 'active' : ''} disabled={busy} onClick={() => changeScope('own')}>רק שלי</button>
          </div>
        </div>
      </div>

      {status && (
        <div className="settings-card">
          <div className="settings-card-title">🔌 חיבורים חיצוניים</div>
          <div className="admin-list-item">
            <div className="top"><b>Sigma</b>
              <span className={'live-pill ' + (status.sigma.bridgeConfigured ? 'on' : 'off')} style={{ margin: 0 }}>
                {status.sigma.bridgeConfigured ? 'Bridge מקומי מחובר' : 'MOCK — Bridge לא מוגדר'}
              </span>
            </div>
            {status.sigma.lastRun && <div className="meta">סנכרון אחרון: {formatDateSafe(status.sigma.lastRun.created_at)}</div>}
          </div>
          <div className="admin-list-item">
            <div className="top"><b>UPS Webhook</b>
              <span className={'live-pill ' + (status.ups.webhookAuthEnabled ? 'on' : 'off')} style={{ margin: 0 }}>
                {status.ups.webhookAuthEnabled ? 'אימות פעיל' : 'ללא אימות (dev)'}
              </span>
            </div>
          </div>
          <div className="admin-list-item">
            <div className="top"><b>UPS API משלים</b>
              <span className={'live-pill ' + (status.ups.reconcileEnabled ? 'on' : 'off')} style={{ margin: 0 }}>
                {status.ups.reconcileEnabled ? 'פעיל' : 'כבוי'}
              </span>
            </div>
          </div>
          {status.failedRuns24h > 0 && (
            <div className="error-box">{status.failedRuns24h} סנכרונים נכשלו ב-24 השעות האחרונות</div>
          )}
        </div>
      )}

      {user && user.role === 'system_admin' && <MetricsSettings />}

      {user && user.role === 'system_admin' && <WooCommerceSettings />}

      <div className="settings-card">
        <div className="settings-card-title">👥 משתמשים</div>
        <UserManagement />
      </div>
    </div>
  );
}

// חיבור לאתר המכירות (WooCommerce) — למנהל מערכת בלבד (בקשת דניאל 16.9.2026).
// עדכון 17.9.2026: המערכת כן סוגרת מוצר אוטומטית (stock_status=outofstock)
// ברגע שבודק QC מאשר סופית שהפריט חסר — אבל פתיחה מחדש נשארת תמיד ידנית
// (מחירים יכולים להשתנות בינתיים). הסודות עצמם לא חוזרים גלויים מה-GET.
function WooCommerceSettings() {
  const [settings, setSettings] = useState(null);
  const [storeUrl, setStoreUrl] = useState('');
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    const s = await api.getWooCommerceSettings();
    setSettings(s);
    setStoreUrl(s.storeUrl || '');
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setBusy(true);
    setTestResult(null);
    setSaved(false);
    try {
      const s = await api.saveWooCommerceSettings({ storeUrl, consumerKey, consumerSecret });
      setSettings(s);
      setConsumerKey('');
      setConsumerSecret('');
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await api.testWooCommerceConnection();
      setTestResult(r);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-card-title">🛒 חיבור לאתר המכירות (WooCommerce)</div>
      <div className="meta" style={{ marginBottom: 12 }}>
        סוגר אוטומטית מוצר באתר ברגע שבודק QC מאשר סופית שהוא חסר. פתיחה מחדש נשארת תמיד ידנית (מחירים יכולים להשתנות בינתיים).
      </div>

      <div className="form-stack">
        <input className="text-input" placeholder="כתובת החנות: https://shop.example.com" value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} />
        <input
          className="text-input"
          type="password"
          placeholder={settings?.consumerKeyMasked ? `Consumer Key — שמור: ${settings.consumerKeyMasked} (השאירו ריק ללא שינוי)` : 'Consumer Key (ck_...)'}
          value={consumerKey}
          onChange={(e) => setConsumerKey(e.target.value)}
        />
        <input
          className="text-input"
          type="password"
          placeholder={settings?.consumerSecretMasked ? `Consumer Secret — שמור: ${settings.consumerSecretMasked} (השאירו ריק ללא שינוי)` : 'Consumer Secret (cs_...)'}
          value={consumerSecret}
          onChange={(e) => setConsumerSecret(e.target.value)}
        />
      </div>

      <div className="btn-row">
        <button className="action-btn" disabled={busy || !storeUrl} onClick={save}>שמירה</button>
        <button className="action-btn secondary" disabled={busy || !settings?.configured} onClick={testConnection}>בדיקת חיבור</button>
      </div>
      {saved && <div className="live-pill on" style={{ marginTop: 8 }}>✓ נשמר</div>}

      {testResult && (
        <div className={testResult.ok ? 'live-pill on' : 'error-box'} style={{ marginTop: 8 }}>
          {testResult.ok ? '✓ ' : '⚠️ '}{testResult.message}
        </div>
      )}

      <div className="meta" style={{ marginTop: 10 }}>
        סטטוס חיבור: <b>{settings?.configured ? 'מוגדר ✓' : 'לא מוגדר'}</b>
      </div>
    </div>
  );
}

// הגדרות מדידה לדשבורד (מנהל מערכת בלבד, בקשת דניאל 23.9.2026): שעת הסגירה
// שעד אליה הזמנה עוד יכולה לצאת באותו יום, ימי עבודה, ועלות עבודה חודשית
// של צוות המחסן — ממנה מחושבת "עלות עבודה להזמנה" בתמונת ההנהלה.
const WEEKDAY_NAMES = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

function MetricsSettings() {
  const [cutoffTime, setCutoffTime] = useState('12:00');
  const [workdays, setWorkdays] = useState([0, 1, 2, 3, 4]);
  const [laborCost, setLaborCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getMetricsSettings().then((s) => {
      setCutoffTime(s.cutoffTime);
      setWorkdays(s.workdays);
      setLaborCost(s.monthlyLaborCost != null ? String(s.monthlyLaborCost) : '');
    }).catch(() => {});
  }, []);

  function toggleDay(d) {
    setSaved(false);
    setWorkdays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  }

  async function save() {
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      await api.saveMetricsSettings({ cutoffTime, workdays, monthlyLaborCost: laborCost === '' ? null : Number(laborCost) });
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-card-title">📏 הגדרות מדידה (דשבורד)</div>
      <div className="form-stack">
        <label className="field-row">
          <span>שעת סגירה — עד מתי הזמנה צריכה להיכנס כדי לצאת באותו יום</span>
          <input className="text-input" type="time" value={cutoffTime} onChange={(e) => { setCutoffTime(e.target.value); setSaved(false); }} style={{ maxWidth: 140 }} />
        </label>
        <div className="field-row">
          <span>ימי עבודה</span>
          <div className="toggle">
            {WEEKDAY_NAMES.map((n, i) => (
              <button key={i} type="button" className={workdays.includes(i) ? 'active' : ''} onClick={() => toggleDay(i)}>{n}</button>
            ))}
          </div>
        </div>
        <label className="field-row">
          <span>עלות עבודה חודשית של צוות המחסן (₪, כולל עלות מעביד) — לא חובה</span>
          <input className="text-input" type="number" min="0" inputMode="numeric" placeholder="למשל 24000" value={laborCost}
            onChange={(e) => { setLaborCost(e.target.value); setSaved(false); }} style={{ maxWidth: 180 }} />
        </label>
      </div>
      <div className="btn-row">
        <button className="action-btn" disabled={busy || workdays.length === 0} onClick={save}>שמירה</button>
      </div>
      {saved && <div className="live-pill on" style={{ marginTop: 8 }}>✓ נשמר</div>}
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
