import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { shipLabel } from '../labels.js';
import { onLive } from '../ws.js';

export default function Exceptions({ user, onOpenOrder }) {
  const [data, setData] = useState(null);
  const isManager = user.role === 'warehouse_manager' || user.role === 'system_admin';

  async function load() {
    const d = await api.exceptions();
    setData(d);
  }

  useEffect(() => {
    load();
    const off = onLive(() => load());
    return off;
  }, []);

  if (!data) return <div className="empty-state">טוען...</div>;

  const total = data.onHold.length + data.linkExceptions.length + data.shipmentExceptions.length;

  return (
    <div>
      {total === 0 && <div className="empty-state">אין חריגות כרגע 🎉</div>}

      {data.onHold.length > 0 && (
        <>
          <div className="section-title">הזמנות מעוכבות</div>
          {data.onHold.map((o) => (
            <div className="admin-list-item" key={o.order_key} onClick={() => onOpenOrder(o.order_key)} style={{ cursor: 'pointer' }}>
              <div className="top">
                <b>הזמנה {o.order_num}</b>
                <span className="meta">{o.customer_name}</span>
              </div>
              <div className="meta" style={{ color: '#c0392b' }}>{o.hold_reason}</div>
            </div>
          ))}
        </>
      )}

      {data.linkExceptions.length > 0 && (
        <>
          <div className="section-title">חריגות קישור UPS (אסמכתא שגויה)</div>
          {data.linkExceptions.map((le) => (
            <div className="admin-list-item" key={le.exception_id}>
              <div className="top">
                <b>שטר {le.track_no}</b>
                <span className="meta">{new Date(le.created_at).toLocaleString('he-IL')}</span>
              </div>
              <div className="meta">מספר לא תקין: {le.bad_ref} — {le.reason}</div>
              {isManager && (
                <div className="actions">
                  <button className="btn-approve" onClick={async () => { await api.resolveLinkException(le.exception_id); load(); }}>סמן כטופל</button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {data.shipmentExceptions.length > 0 && (
        <>
          <div className="section-title">חריגות משלוח UPS</div>
          {data.shipmentExceptions.map((s) => (
            <div className="admin-list-item" key={s.track_no}>
              <div className="top">
                <b>{s.track_no}</b>
                <span className={`badge ship-${s.status}`}>{shipLabel(s.status)}</span>
              </div>
              {s.exception_desc_heb && <div className="meta" style={{ color: '#c0392b' }}>{s.exception_desc_heb}</div>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
