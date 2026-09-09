import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';

export default function Admin({ user, onOpenOrder }) {
  const [scope, setScope] = useState('all');
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [s, p] = await Promise.all([api.getAgentViewScope(), api.pendingUrgent()]);
    setScope(s.scope);
    setPending(p.requests);
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
    </div>
  );
}
