import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';

export default function Admin({ user, onOpenOrder }) {
  const [scope, setScope] = useState('all');
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  async function load() {
    const [s, p, st] = await Promise.all([api.getAgentViewScope(), api.pendingUrgent(), api.integrationsStatus().catch(() => null)]);
    setScope(s.scope);
    setPending(p.requests);
    setStatus(st);
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => {
      if (evt.type === 'urgent_request' || evt.type === 'settings') load();
    });
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

  async function decide(id, approve) {
    setBusy(true);
    try {
      await api.decideUrgent(id, approve);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="section-title">תצוגת הזמנות לסוכנים</div>
      <div className="toggle-row">
        <span>סוכנים רואים:</span>
        <div className="toggle">
          <button className={scope === 'all' ? 'active' : ''} disabled={busy} onClick={() => changeScope('all')}>כל ההזמנות</button>
          <button className={scope === 'own' ? 'active' : ''} disabled={busy} onClick={() => changeScope('own')}>רק שלי</button>
        </div>
      </div>

      <div className="section-title">בקשות דחיפות ממתינות</div>
      {pending.length === 0 && <div className="empty-state">אין בקשות ממתינות</div>}
      {pending.map((r) => (
        <div className="admin-list-item" key={r.request_id}>
          <div className="top" onClick={() => onOpenOrder(r.order_key)} style={{ cursor: 'pointer' }}>
            <b>הזמנה {r.order_num}</b>
            <span className="meta">{r.customer_name}</span>
          </div>
          <div className="meta">סוכן: {r.agent_name} · {new Date(r.created_at).toLocaleString('he-IL')}</div>
          <div className="actions">
            <button className="btn-approve" disabled={busy} onClick={() => decide(r.request_id, true)}>אשר דחיפות</button>
            <button className="btn-reject" disabled={busy} onClick={() => decide(r.request_id, false)}>דחה</button>
          </div>
        </div>
      ))}

      {status && (
        <>
          <div className="section-title">מצב חיבורים</div>
          <div className="admin-list-item">
            <div className="top"><b>Sigma</b>
              <span className={'live-pill ' + (status.sigma.enabled ? 'on' : 'off')} style={{ margin: 0 }}>
                {status.sigma.enabled ? `מחובר (${status.sigma.server})` : 'MOCK — לא מוגדר'}
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
        </>
      )}
    </div>
  );
}
