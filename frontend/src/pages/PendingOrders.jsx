import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt.replace(' ', 'T') + 'Z').toLocaleString('he-IL');
}

function ageText(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (ms < 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} דק'`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} שע'`;
  return `${Math.floor(hours / 24)} ימים`;
}

export default function PendingOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const data = await api.pendingOrders();
      setOrders(data.orders);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="section-title">ממתינות לאישור/הדפסה</div>
      <div className="empty-state" style={{ padding: '8px 4px', textAlign: 'right', background: 'none' }}>
        הזמנות שעדיין אצל המזכירה בסיגמא — טרם הודפסו ולא נכנסו לתור הליקוט. תצוגת מידע בלבד.
      </div>

      {loading && <div className="empty-state">טוען...</div>}
      {!loading && orders.length === 0 && <div className="empty-state">אין הזמנות הממתינות לאישור כרגע</div>}

      <div className="list-grid">
        {orders.map((o) => (
          <div className="order-card" key={o.order_key}>
            <div className="row1">
              <span className="order-num">הזמנה {o.order_num}</span>
              <span>{o.total_amount ? `₪${o.total_amount}` : ''}</span>
            </div>
            <div className="customer">{o.customer_name}</div>
            <div className="meta">
              נוצרה: {fmt(o.sigma_created_at || o.order_date)}
              {(o.sigma_created_at || o.order_date) && <span> · ממתינה כבר {ageText(o.sigma_created_at || o.order_date)}</span>}
              {o.agent_name && <span> · סוכן: {o.agent_name}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
