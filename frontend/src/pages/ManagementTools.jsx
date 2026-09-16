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
    const off = onLive((evt) => { if (evt.type === 'settings') load(); });
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
        <div className="settings-card-title">תצוגת הזמנות לסוכנים</div>
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
          <div className="settings-card-title">חיבורים חיצוניים</div>
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

      {user && user.role === 'system_admin' && <WooCommerceSettings />}

      <div className="settings-card">
        <div className="settings-card-title">משתמשים</div>
        <UserManagement />
      </div>
    </div>
  );
}

// חיבור לאתר המכירות (WooCommerce) — למנהל מערכת בלבד (בקשת דניאל 16.9.2026).
// קריאה-בלבד: המערכת לא סוגרת/פותחת מוצרים אוטומטית, רק שולפת סטטוס להצגה
// למנהל מחסן. הסודות עצמם לא חוזרים גלויים מה-GET, רק ממוסכים.
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
      <div className="settings-card-title">חיבור לאתר המכירות (WooCommerce)</div>
      <div className="meta" style={{ marginBottom: 8 }}>
        קריאה בלבד — משמש להצגת סטטוס מוצר למנהל מחסן, לא סוגר/פותח מוצרים אוטומטית.
      </div>

      <div className="actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <input placeholder="כתובת החנות: https://shop.example.com" value={storeUrl} onChange={(e) => setStoreUrl(e.target.value)} />
        <input
          type="password"
          placeholder={settings?.consumerKeyMasked ? `Consumer Key — שמור: ${settings.consumerKeyMasked} (השאירו ריק ללא שינוי)` : 'Consumer Key (ck_...)'}
          value={consumerKey}
          onChange={(e) => setConsumerKey(e.target.value)}
        />
        <input
          type="password"
          placeholder={settings?.consumerSecretMasked ? `Consumer Secret — שמור: ${settings.consumerSecretMasked} (השאירו ריק ללא שינוי)` : 'Consumer Secret (cs_...)'}
          value={consumerSecret}
          onChange={(e) => setConsumerSecret(e.target.value)}
        />
      </div>

      <div className="toggle-row">
        <button className="btn-approve" disabled={busy || !storeUrl} onClick={save}>שמירה</button>
        <button className="btn-reject" disabled={busy || !settings?.configured} onClick={testConnection}>בדיקת חיבור</button>
        {saved && <span className="live-pill on">נשמר</span>}
      </div>

      {testResult && (
        <div className={testResult.ok ? 'meta' : 'error-box'} style={{ marginTop: 6 }}>
          {testResult.ok ? '✓ ' : '⚠️ '}{testResult.message}
        </div>
      )}

      <div className="meta" style={{ marginTop: 6 }}>
        סטטוס: {settings?.configured ? 'מוגדר' : 'לא מוגדר'}
      </div>
    </div>
  );
}
