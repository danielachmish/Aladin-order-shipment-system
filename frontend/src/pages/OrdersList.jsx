import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { statusLabel, priorityLabel } from '../labels.js';
import { onLive } from '../ws.js';

const METRICS = [
  { key: 'waiting_pick', label: 'ממתינות לליקוט' },
  { key: 'picking', label: 'בליקוט' },
  { key: 'shipping', label: 'מוכנות למשלוח', statuses: ['ready_to_pack', 'waiting_pickup', 'delivered_to_ups'] },
  { key: 'exceptions', label: 'חריגות', statuses: ['on_hold', 'waiting_answer'] },
];

export default function OrdersList({ user, onOpenOrder }) {
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [activeMetric, setActiveMetric] = useState(null);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState('all');
  const [flashKeys, setFlashKeys] = useState(new Set());
  const prevVersions = useRef({});

  async function load() {
    try {
      const data = await api.listOrders({});
      const changed = new Set();
      for (const o of data.orders) {
        const prev = prevVersions.current[o.order_key];
        if (prev !== undefined && (prev.status !== o.status || prev.version !== o.version)) {
          changed.add(o.order_key);
        }
        prevVersions.current[o.order_key] = { status: o.status, version: o.version };
      }
      if (changed.size > 0) {
        setFlashKeys(changed);
        setTimeout(() => setFlashKeys(new Set()), 1400);
      }
      setOrders(data.orders);
      setScope(data.agent_view_scope);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => {
      if (evt.type === 'order' || evt.type === 'urgent_request' || evt.type === 'shipment' || evt.type === 'settings') load();
    });
    return off;
  }, []);

  const counts = useMemo(() => {
    const c = { waiting_pick: 0, picking: 0, shipping: 0, exceptions: 0 };
    for (const o of orders) {
      if (o.status === 'waiting_pick') c.waiting_pick++;
      else if (o.status === 'picking') c.picking++;
      else if (['ready_to_pack', 'waiting_pickup', 'delivered_to_ups'].includes(o.status)) c.shipping++;
      else if (['on_hold', 'waiting_answer'].includes(o.status)) c.exceptions++;
    }
    return c;
  }, [orders]);

  const filtered = useMemo(() => {
    let list = orders.filter((o) => !['closed', 'cancelled'].includes(o.status));
    if (activeMetric) {
      const m = METRICS.find((x) => x.key === activeMetric);
      const statuses = m.statuses || [m.key];
      list = list.filter((o) => statuses.includes(o.status));
    }
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter((o) => String(o.order_num).includes(s) || (o.customer_name || '').toLowerCase().includes(s));
    }
    return list;
  }, [orders, activeMetric, search]);

  return (
    <div>
      <div className="search-box">
        <input placeholder="חיפוש: מספר הזמנה או לקוח (למשל 54707)" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {user.role === 'agent' && scope === 'own' && (
        <div className="live-pill on" style={{ marginRight: 0, marginBottom: 10 }}>מוצגות רק ההזמנות שלך</div>
      )}

      <div className="metrics-row">
        {METRICS.map((m) => (
          <div
            key={m.key}
            className={'metric-chip' + (activeMetric === m.key ? ' active' : '')}
            onClick={() => setActiveMetric(activeMetric === m.key ? null : m.key)}
          >
            <b>{counts[m.key]}</b>
            {m.label}
          </div>
        ))}
      </div>

      {loading && <div className="empty-state">טוען...</div>}
      {!loading && filtered.length === 0 && <div className="empty-state">אין הזמנות להצגה</div>}

      <div className="list-grid">
      {filtered.map((o) => (
        <div
          className={'order-card' + (flashKeys.has(o.order_key) ? ' flash-update' : '')}
          key={o.order_key}
          onClick={() => onOpenOrder(o.order_key)}
        >
          <div className="row1">
            <span className="order-num">הזמנה {o.order_num}</span>
            <span>{o.total_amount ? `₪${o.total_amount}` : ''}</span>
          </div>
          <div className="customer">{o.customer_name} · {o.line_count} שורות</div>
          <div className="row2">
            <span className={`badge status-${o.status}`}>{statusLabel(o.status)}</span>
            {o.priority !== 'normal' && <span className={`badge priority-${o.priority}`}>{priorityLabel(o.priority)}</span>}
          </div>
          <div className="meta">
            {o.status === 'waiting_pick' && o.queue_position && (
              <span>בתור {o.queue_position.position} מתוך {o.queue_position.total} · {o.queue_position.ahead} הזמנות לפניה</span>
            )}
            {o.status === 'picking' && <span>מלקט: {o.claimed_by_name || '—'}</span>}
            {o.agent_name && <span> · סוכן: {o.agent_name}</span>}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}
