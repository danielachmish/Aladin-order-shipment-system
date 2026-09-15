import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { shipLabel } from '../labels.js';
import { onLive } from '../ws.js';
import { formatDateSafe as fmt } from '../format.js';

export default function Shipments({ onOpenOrder }) {
  const [shipments, setShipments] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const data = await api.shipments();
      setShipments(data.shipments);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => { if (evt.type === 'shipment') load(); });
    return off;
  }, []);

  const filtered = shipments.filter((s) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return s.track_no.toLowerCase().includes(q) || s.orders.some((o) => String(o.order_num).includes(q) || (o.customer_name || '').toLowerCase().includes(q));
  });

  return (
    <div>
      <div className="section-title">משלוחים (UPS)</div>
      <div className="search-box">
        <input placeholder="חיפוש: מספר שטר, הזמנה או לקוח" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {loading && <div className="empty-state">טוען...</div>}
      {!loading && filtered.length === 0 && <div className="empty-state">אין עדיין משלוחים שנמסרו ל-UPS</div>}

      <div className="list-grid">
        {filtered.map((s) => (
          <div className="shipment-card" key={s.track_no}>
            <div className="row1">
              <span className="track">{s.track_no}</span>
              <span className={`badge ship-${s.status}`}>{shipLabel(s.status)}</span>
            </div>
            {s.status_desc_heb && <div className="meta">{s.status_desc_heb}</div>}
            {s.exception_desc_heb && <div className="meta" style={{ color: '#c0392b' }}>חריגה: {s.exception_desc_heb}</div>}
            {s.estimate_delivery && <div className="meta">צפי מסירה: {fmt(s.estimate_delivery)}</div>}
            {s.delivered_time && <div className="meta">נמסר: {fmt(s.delivered_time)} {s.received_by ? `(${s.received_by})` : ''}</div>}
            <div className="meta">עודכן: {fmt(s.updated_at)}</div>
            {s.orders.length > 0 && (
              <div className="meta" style={{ marginTop: 6 }}>
                הזמנות:{' '}
                {s.orders.map((o, i) => (
                  <span key={o.order_key}>
                    {i > 0 && ', '}
                    <a href="#" onClick={(e) => { e.preventDefault(); onOpenOrder(o.order_key); }}>
                      {o.order_num} ({o.customer_name})
                    </a>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
