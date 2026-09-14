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

export default function History({ user, onOpenOrder }) {
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState('open'); // 'open' = דורש טיפול | 'all' = הכל
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);

  const canMarkInvoiced = user && (user.role === 'warehouse_manager' || user.role === 'system_admin');

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
    let list = orders;
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter((o) => String(o.order_num).includes(s) || (o.customer_name || '').toLowerCase().includes(s));
    }
    if (tab === 'open') {
      // "דורש טיפול" — רק הזמנות עם חוסר שעוד לא סומן כטופל (בקשת דניאל 14.9.2026)
      list = list.filter((o) => o.shortages && o.shortages.length > 0 && !o.shortage_invoiced_at);
    }
    return list;
  }, [orders, search, tab]);

  const openCount = useMemo(
    () => orders.filter((o) => o.shortages && o.shortages.length > 0 && !o.shortage_invoiced_at).length,
    [orders]
  );

  async function toggleInvoiced(e, order, invoiced) {
    e.stopPropagation();
    setBusyKey(order.order_key);
    try {
      if (invoiced) await api.unmarkShortageInvoiced(order.order_key);
      else await api.markShortageInvoiced(order.order_key);
      await load();
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div>
      <div className="section-title">היסטוריית ליקוט</div>

      <div className="search-box">
        <input placeholder="חיפוש: מספר הזמנה או לקוח" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="toggle-row">
        <div className="toggle">
          <button className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>דורש טיפול {openCount > 0 ? `(${openCount})` : ''}</button>
          <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>הכל</button>
        </div>
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
      {!loading && filtered.length === 0 && tab === 'open' && <div className="empty-state">אין חוסרים שדורשים טיפול 🎉</div>}
      {!loading && filtered.length === 0 && tab === 'all' && <div className="empty-state">אין הזמנות שסיימו ליקוט בטווח הזה</div>}

      <div className="list-grid">
      {filtered.map((o) => {
        const hasShortage = o.shortages && o.shortages.length > 0;
        const invoiced = !!o.shortage_invoiced_at;
        return (
        <div
          className={'order-card' + (hasShortage && !invoiced ? ' shortage-needs-attention' : '')}
          key={o.order_key}
          onClick={() => onOpenOrder(o.order_key)}
        >
          <div className="row1">
            <span className="order-num">הזמנה {o.order_num}</span>
            <span>{o.total_amount ? `₪${o.total_amount}` : ''}</span>
          </div>
          <div className="customer">{o.customer_name}</div>
          <div className="row2">
            <span className={`badge status-${o.status}`}>{statusLabel(o.status)}</span>
            {o.issues.length > 0 && <span className="badge status-on_hold">{o.issues.length} בעיות בדרך</span>}
            {hasShortage && !invoiced && <span className="badge status-on_hold">⚠️ {o.shortages.length} פריטים חסרים</span>}
            {hasShortage && invoiced && <span className="badge status-closed">✓ טופל</span>}
          </div>
          <div className="meta">
            ליקוט: {fmt(o.pick_started_at)} ← {fmt(o.pick_finished_at)}
            {o.pick_started_at && o.pick_finished_at && <span> ({durationText(o.pick_started_at, o.pick_finished_at)})</span>}
            {o.picked_by && <span> · מלקט: {o.picked_by}</span>}
          </div>
          {hasShortage && (
            <div className="shortage-table-wrap">
              <table className="agent-table">
                <thead><tr><th>מק"ט</th><th>שם</th><th>הוזמן</th><th>נלקט</th><th>הערת מלקט</th><th>הערת בודק</th></tr></thead>
                <tbody>
                  {o.shortages.map((s, idx) => (
                    <tr key={idx}>
                      <td>{s.item_code}</td>
                      <td>{s.item_name}</td>
                      <td>{s.qty_ordered}</td>
                      <td>{s.qty_picked}</td>
                      <td>{s.pick_note || '—'}</td>
                      <td>{s.check_note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {canMarkInvoiced && (
                invoiced ? (
                  <div className="meta" style={{ marginTop: 6 }}>
                    ✓ טופל ע"י {o.shortage_invoiced_by_name || '—'} · {fmt(o.shortage_invoiced_at)}
                    {' '}
                    <button className="action-btn secondary" disabled={busyKey === o.order_key} onClick={(e) => toggleInvoiced(e, o, true)}>בטל סימון</button>
                  </div>
                ) : (
                  <button
                    className="action-btn" style={{ marginTop: 6 }}
                    disabled={busyKey === o.order_key}
                    onClick={(e) => toggleInvoiced(e, o, false)}
                  >
                    ✓ סימנתי שהוצאתי חשבונית מתוקנת
                  </button>
                )
              )}
            </div>
          )}
          {o.issues.length > 0 && (
            <div className="meta" style={{ color: '#c0392b', marginTop: 4 }}>
              {o.issues.map((iss, idx) => (
                <div key={idx}>{fmt(iss.created_at)} — {iss.note || 'ללא פירוט'} {iss.user_name ? `(${iss.user_name})` : ''}</div>
              ))}
            </div>
          )}
        </div>
        );
      })}
      </div>
    </div>
  );
}
