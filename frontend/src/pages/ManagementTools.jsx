import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';
import UserManagement from '../components/UserManagement.jsx';

// כלי ניהול — הגדרות ותצורה בלבד (לא KPI/מדדים/חריגות/בקשות דחיפות —
// אלה עברו לדשבורד, מסך הבית התפעולי של המנהל). ר' בקשת דניאל 14.9.2026.
export default function ManagementTools() {
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
            {status.sigma.lastRun && <div className="meta">סנכרון אחרון: {new Date(status.sigma.lastRun.created_at).toLocaleString('he-IL')}</div>}
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

      <div className="settings-card">
        <div className="settings-card-title">משתמשים</div>
        <UserManagement />
      </div>
    </div>
  );
}
