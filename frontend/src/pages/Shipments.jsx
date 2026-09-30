import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { shipLabel } from '../labels.js';
import { onLive } from '../ws.js';
import { formatDateSafe as fmt } from '../format.js';
import { showToast } from '../toast.js';
import ShipmentLinker from '../components/ShipmentLinker.jsx';

// serviceLevel לפי מסמך ה-Webhook של UPS
const SERVICE_LEVELS = { 31: 'עד הבית', 50: 'חנות', 51: 'לוקר', 53: 'דרופ' };

export default function Shipments({ user, onOpenOrder }) {
  const [shipments, setShipments] = useState([]);
  const [search, setSearch] = useState('');
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  const isManager = user && (user.role === 'warehouse_manager' || user.role === 'system_admin');
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
    const off = onLive((evt) => { if (evt.type === 'shipment' || evt.type === '__connected') load(); });
    return off;
  }, []);

  async function unlink(trackNo, order) {
    if (!window.confirm(`לבטל את הקישור של שטר ${trackNo} להזמנה ${order.order_num}?`)) return;
    try {
      await api.unlinkShipment(trackNo, order.order_key);
      load();
    } catch (e) {
      showToast(e.message);
    }
  }

  const unlinkedCount = shipments.filter((s) => s.orders.length === 0).length;

  const filtered = shipments.filter((s) => {
    if (onlyUnlinked && s.orders.length > 0) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return s.track_no.toLowerCase().includes(q)
      || (s.ref1 || '').toLowerCase().includes(q)
      || (s.ref2 || '').toLowerCase().includes(q)
      || s.orders.some((o) => String(o.order_num).includes(q) || (o.customer_name || '').toLowerCase().includes(q));
  });

  return (
    <div>
      <div className="section-title">משלוחים (UPS)</div>
      <div className="search-box">
        <input placeholder="חיפוש: מספר שטר, הזמנה, לקוח או אסמכתא" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {unlinkedCount > 0 && (
        <label className="unlinked-filter">
          <input type="checkbox" checked={onlyUnlinked} onChange={(e) => setOnlyUnlinked(e.target.checked)} />
          הצג רק משלוחים לא מקושרים ({unlinkedCount})
        </label>
      )}

      {loading && <div className="empty-state">טוען...</div>}
      {!loading && filtered.length === 0 && <div className="empty-state">אין עדיין משלוחים שנמסרו ל-UPS</div>}

      <div className="list-grid">
        {filtered.map((s) => (
          <div className={`shipment-card${s.orders.length === 0 ? ' unlinked' : ''}`} key={s.track_no}>
            <div className="row1">
              <span className="track">{s.track_no}</span>
              <span>
                {s.orders.length === 0 && <span className="badge ship-unlinked">לא מקושר</span>}{' '}
                <span className={`badge ship-${s.status}`}>{shipLabel(s.status)}</span>
              </span>
            </div>
            {s.status_desc_heb && <div className="meta">{s.status_desc_heb}</div>}
            {s.exception_desc_heb && <div className="meta" style={{ color: '#c0392b' }}>חריגה: {s.exception_desc_heb}</div>}
            {s.estimate_delivery && <div className="meta">צפי מסירה: {fmt(s.estimate_delivery)}</div>}
            {s.delivered_time && <div className="meta">נמסר: {fmt(s.delivered_time)} {s.received_by ? `(${s.received_by})` : ''}</div>}
            {(s.ref2 || s.service_level) && (
              <div className="meta">
                {s.ref2 && <>נמען: {s.ref2}</>}
                {s.ref2 && s.service_level && ' · '}
                {s.service_level && (SERVICE_LEVELS[s.service_level] || `שירות ${s.service_level}`)}
              </div>
            )}
            {s.rts_track_no && <div className="meta">שטר החזרה: {s.rts_track_no}</div>}
            {s.orders.length === 0 && <div className="meta">אסמכתא: {s.ref1 || '(ריקה)'}</div>}
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
                    {isManager && (
                      <button className="btn-unlink" title="בטל קישור" onClick={() => unlink(s.track_no, o)}>✕</button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {s.orders.length === 0 && isManager && <ShipmentLinker trackNo={s.track_no} onLinked={load} />}
          </div>
        ))}
      </div>
    </div>
  );
}
