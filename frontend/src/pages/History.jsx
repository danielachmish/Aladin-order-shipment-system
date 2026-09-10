import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { statusLabel } from '../labels.js';
import { onLive } from '../ws.js';

function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt.replace(' ', 'T') + 'Z').toLocaleString('he-IL');
}

function durationText(startIso, endIso) {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso.replace(' ', 'T') + 'Z') - new Date(startIso.replace(' ', 'T') + 'Z');
  if (ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} דק'`;
  return `${Math.floor(mins / 60)} שע' ${mins % 60} דק'`;
}

export default function History({ onOpenOrder }) {
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const data = await api.history({ days });
      setOrders(data.orders);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => { if (evt.type === 'order') load(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const filtered = useMemo(() => {
    if (!search.trim()) return orders;
    const s = search.trim().toLowerCase();
    return orders.filter((o) => String(o.order_num).includes(s) || (o.customer_name || '').toLowerCase().includes(s));
  }, [orders, search]);

  return (
    <div>
      <div className="section-title">היסטוריית ליקוט</div>

      <div className="search-box">
        <input placeholder="חיפוש: מספר הזמנה או לקוח" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="toggle-row">
        <span>טווח:</span>
        <div className="toggle">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{d} יום</button>
          ))}
        </div>
      </div>

      {loading && <div className="empty-state">טוען...</div>}
      {!loading && filtered.length === 0 && <div className="empty-state">אין הזמנות שסיימו ליקוט בטווח הזה</div>}

      {filtered.map((o) => (
        <div className="order-card" key={o.order_key} onClick={() => onOpenOrder(o.order_key)}>
          <div className="row1">
            <span className="order-num">הזמנה {o.order_num}</span>
            <span>{o.total_amount ? `₪${o.total_amount}` : ''}</span>
          </div>
          <div className="customer">{o.customer_name}</div>
          <div className="row2">
            <span className={`badge status-${o.status}`}>{statusLabel(o.status)}</span>
            {o.issues.length > 0 && <span className="badge status-on_hold">{o.issues.length} בעיות בדרך</span>}
          </div>
          <div className="meta">
            ליקוט: {fmt(o.pick_started_at)} ← {fmt(o.pick_finished_at)}
            {o.pick_started_at && o.pick_finished_at && <span> ({durationText(o.pick_started_at, o.pick_finished_at)})</span>}
            {o.picked_by && <span> · מלקט: {o.picked_by}</span>}
          </div>
          {o.issues.length > 0 && (
            <div className="meta" style={{ color: '#c0392b', marginTop: 4 }}>
              {o.issues.map((iss, idx) => (
                <div key={idx}>{fmt(iss.created_at)} — {iss.note || 'ללא פירוט'} {iss.user_name ? `(${iss.user_name})` : ''}</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
