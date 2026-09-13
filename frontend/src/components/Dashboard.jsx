import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';
import { shipLabel, statusLabel, priorityLabel } from '../labels.js';

function trend(today, yesterday) {
  if (yesterday === 0 && today === 0) return null;
  const diff = today - yesterday;
  if (diff === 0) return <span className="kpi-trend">ללא שינוי מאתמול</span>;
  const up = diff > 0;
  return <span className={`kpi-trend ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(diff)} מאתמול</span>;
}

function firstName(name) {
  if (!name) return '';
  return name.split(' ')[0];
}

const ACTIVE_SHIP_STATUSES = ['ship_sorting', 'ship_to_pickup_point', 'ship_waiting_pickup', 'ship_out_for_delivery', 'ship_exception', 'ship_unmapped'];

// מסך בית של המנהל — לא רק KPI, אלא "חדר בקרה" מלא: חריגות, בקשות דחיפות
// ומשלוחים פעילים כפאנלים ניתנים לפעולה, בהשראת מסך הבית של UPS Ship
// ששלח דניאל (14.9.2026) — "שהמנהל יוכל להיות רק עליו ולהבין מה קורה".
export default function Dashboard({ user, onOpenOrder }) {
  const [d, setD] = useState(null);
  const [exceptions, setExceptions] = useState(null);
  const [pendingUrgent, setPendingUrgent] = useState([]);
  const [shipments, setShipments] = useState([]);
  const [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  async function load() {
    try {
      const [dash, exc, pu, ship, ord] = await Promise.all([
        api.dashboard(),
        api.exceptions(),
        api.pendingUrgent(),
        api.shipments(),
        api.listOrders({}),
      ]);
      setD(dash);
      setExceptions(exc);
      setPendingUrgent(pu.requests);
      setShipments(ship.shipments);
      setOrders(ord.orders);
      setLastUpdated(new Date());
    } catch {
      // שקט: אם השרת עדיין לא עודכן, פשוט לא מציגים דשבורד
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => {
      if (['order', 'urgent_request', 'shipment'].includes(evt.type)) load();
    });
    return off;
  }, []);

  async function decide(id, approve) {
    setBusy(true);
    try {
      await api.decideUrgent(id, approve);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function resolveLink(id) {
    setBusy(true);
    try {
      await api.resolveLinkException(id);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!d) return null;

  const activeTotal = Object.values(d.counts).reduce((a, b) => a + b, 0);
  const onHold = exceptions?.onHold || [];
  const linkExceptions = exceptions?.linkExceptions || [];
  const shipmentExceptions = exceptions?.shipmentExceptions || [];
  const activeShipments = shipments.filter((s) => ACTIVE_SHIP_STATUSES.includes(s.status));
  const activeOrders = orders
    .filter((o) => !['closed', 'cancelled'].includes(o.status))
    .sort((a, b) => (a.queue_position ? a.queue_position.position : Infinity) - (b.queue_position ? b.queue_position.position : Infinity))
    .slice(0, 12);
  const exceptionsTotal = onHold.length + linkExceptions.length + shipmentExceptions.length;

  return (
    <div>
      <div className="dashboard-greeting">
        <div className="dashboard-greeting-text">שלום, {firstName(user?.name)} 👋</div>
        {lastUpdated && <div className="dashboard-updated">עודכן לאחרונה: {lastUpdated.toLocaleTimeString('he-IL')}</div>}
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">📦 הזמנות פעילות כרגע</div>
          <div className="kpi-value">{activeTotal}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">✅ נסגרו היום</div>
          <div className="kpi-value">{d.closedToday}</div>
          {trend(d.closedToday, d.closedYesterday)}
        </div>
        <div className="kpi-card">
          <div className="kpi-label">⏱️ זמן ליקוט ממוצע (7 ימים)</div>
          <div className="kpi-value">{d.avgPickMinutes != null ? `${d.avgPickMinutes} דק'` : '—'}</div>
        </div>
        <div className={'kpi-card' + (d.stuck.length > 0 ? ' alert' : '')}>
          <div className="kpi-label">⚠️ תקועות בליקוט מעל {d.stuckThresholdMinutes / 60} שעות</div>
          <div className="kpi-value">{d.stuck.length}</div>
        </div>
        <div className="kpi-card wide">
          <div className="kpi-label">💰 שווי כספי בצנרת (הזמנות פעילות)</div>
          <div className="kpi-value">₪{Math.round(d.pipelineValue).toLocaleString('he-IL')}</div>
        </div>
        <div className="kpi-card wide">
          <div className="kpi-label">🎯 עמידה ביעד — נסגר תוך 24 שעות (30 ימים, {d.slaSampleSize} הזמנות)</div>
          <div className="kpi-value">{d.slaPercent != null ? `${d.slaPercent}%` : 'אין עדיין נתונים'}</div>
        </div>
      </div>

      {/* ---- הזמנות פעילות ---- */}
      <div className="settings-card">
        <div className="settings-card-title">📦 הזמנות פעילות {activeTotal > 0 && `(${activeTotal})`}</div>
        {activeOrders.length === 0 && <div className="empty-state">אין הזמנות פעילות כרגע</div>}
        {activeOrders.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="agent-table">
              <thead>
                <tr><th>הזמנה</th><th>לקוח</th><th>סטטוס</th><th>עדיפות</th><th>סוכן</th></tr>
              </thead>
              <tbody>
                {activeOrders.map((o) => (
                  <tr key={o.order_key} onClick={() => onOpenOrder(o.order_key)} style={{ cursor: 'pointer' }}>
                    <td>{o.order_num}</td>
                    <td>{o.customer_name}</td>
                    <td><span className={`badge status-${o.status}`}>{statusLabel(o.status)}</span></td>
                    <td>{o.priority !== 'normal' ? priorityLabel(o.priority) : '—'}</td>
                    <td>{o.agent_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {orders.length > activeOrders.length && (
              <div className="meta" style={{ marginTop: 6 }}>מוצגות {activeOrders.length} מתוך {activeTotal} הזמנות פעילות</div>
            )}
          </div>
        )}
      </div>

      {/* ---- בקשות דחיפות ממתינות ---- */}
      <div className="settings-card">
        <div className="settings-card-title">🔴 בקשות דחיפות ממתינות {pendingUrgent.length > 0 && `(${pendingUrgent.length})`}</div>
        {pendingUrgent.length === 0 && <div className="empty-state">אין בקשות ממתינות</div>}
        {pendingUrgent.map((r) => (
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

      {/* ---- חריגות ---- */}
      <div className="settings-card">
        <div className="settings-card-title">⚠️ חריגות {exceptionsTotal > 0 && `(${exceptionsTotal})`}</div>
        {exceptionsTotal === 0 && <div className="empty-state">אין חריגות כרגע 🎉</div>}

        {onHold.length > 0 && (
          <>
            <div className="meta" style={{ fontWeight: 'bold', marginBottom: 4 }}>הזמנות מעוכבות</div>
            {onHold.map((o) => (
              <div className="admin-list-item" key={o.order_key} onClick={() => onOpenOrder(o.order_key)} style={{ cursor: 'pointer' }}>
                <div className="top"><b>הזמנה {o.order_num}</b><span className="meta">{o.customer_name}</span></div>
                <div className="meta" style={{ color: '#c0392b' }}>{o.hold_reason}</div>
              </div>
            ))}
          </>
        )}

        {linkExceptions.length > 0 && (
          <>
            <div className="meta" style={{ fontWeight: 'bold', margin: '10px 0 4px' }}>חריגות קישור UPS (אסמכתא שגויה)</div>
            {linkExceptions.map((le) => (
              <div className="admin-list-item" key={le.exception_id}>
                <div className="top">
                  <b>שטר {le.track_no}</b>
                  <span className="meta">{new Date(le.created_at).toLocaleString('he-IL')}</span>
                </div>
                <div className="meta">מספר לא תקין: {le.bad_ref} — {le.reason}</div>
                <div className="actions">
                  <button className="btn-approve" disabled={busy} onClick={() => resolveLink(le.exception_id)}>סמן כטופל</button>
                </div>
              </div>
            ))}
          </>
        )}

        {shipmentExceptions.length > 0 && (
          <>
            <div className="meta" style={{ fontWeight: 'bold', margin: '10px 0 4px' }}>חריגות משלוח UPS</div>
            {shipmentExceptions.map((s) => (
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

      {/* ---- משלוחים פעילים ---- */}
      <div className="settings-card">
        <div className="settings-card-title">🚚 משלוחים פעילים {activeShipments.length > 0 && `(${activeShipments.length})`}</div>
        {activeShipments.length === 0 && <div className="empty-state">אין משלוחים פעילים כרגע</div>}
        {activeShipments.map((s) => (
          <div className="admin-list-item" key={s.track_no}>
            <div className="top">
              <b>{s.track_no}</b>
              <span className={`badge ship-${s.status}`}>{shipLabel(s.status)}</span>
            </div>
            {s.status_desc_heb && <div className="meta">{s.status_desc_heb}</div>}
            {s.estimate_delivery && <div className="meta">צפי מסירה: {new Date(s.estimate_delivery).toLocaleString('he-IL')}</div>}
            {s.orders?.length > 0 && (
              <div className="meta">
                הזמנות:{' '}
                {s.orders.map((o, i) => (
                  <span key={o.order_key}>
                    {i > 0 && ', '}
                    <a href="#" onClick={(e) => { e.preventDefault(); onOpenOrder(o.order_key); }}>{o.order_num}</a>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {d.stuck.length > 0 && (
        <div className="settings-card">
          <div className="settings-card-title">🐢 הזמנות תקועות בליקוט</div>
          {d.stuck.map((o) => (
            <div className="admin-list-item" key={o.order_key} onClick={() => onOpenOrder(o.order_key)} style={{ cursor: 'pointer' }}>
              <div className="top"><b>הזמנה {o.order_num}</b><span className="meta">{o.customer_name}</span></div>
              <div className="meta" style={{ color: '#c0392b' }}>{Math.round(o.minutes_in_status / 60 * 10) / 10} שעות בליקוט</div>
            </div>
          ))}
        </div>
      )}

      {d.byAgent.length > 0 && (
        <div className="settings-card">
          <div className="settings-card-title">👤 פילוח לפי סוכן</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="agent-table">
              <thead>
                <tr><th>סוכן</th><th>הזמנות פעילות</th><th>ממתין לתשובה</th></tr>
              </thead>
              <tbody>
                {d.byAgent.map((a) => (
                  <tr key={a.agent_name}>
                    <td>{a.agent_name}</td>
                    <td>{a.active_count}</td>
                    <td>{a.waiting_answer_count || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
