import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';
import { shipLabel, statusLabel, priorityLabel } from '../labels.js';
import { formatDateSafe } from '../format.js';
import WarehouseToday from './WarehouseToday.jsx';
import ManagementView from './ManagementView.jsx';

// בלי WebSocket (פריסת Cloudways דרך api.php) אין עדכון חי — מרעננים לבד
const WAREHOUSE_REFRESH_MS = 60 * 1000;
const MANAGEMENT_REFRESH_MS = 5 * 60 * 1000;

function firstName(name) {
  if (!name) return '';
  return name.split(' ')[0];
}

const ACTIVE_SHIP_STATUSES = ['ship_sorting', 'ship_to_pickup_point', 'ship_waiting_pickup', 'ship_out_for_delivery', 'ship_exception', 'ship_unmapped'];

// מסך בית של המנהל — לא רק KPI, אלא "חדר בקרה" מלא: חריגות, בקשות דחיפות
// ומשלוחים פעילים כפאנלים ניתנים לפעולה, בהשראת מסך הבית של UPS Ship
// ששלח דניאל (14.9.2026) — "שהמנהל יוכל להיות רק עליו ולהבין מה קורה".
export default function Dashboard({ user, onOpenOrder }) {
  const isAdmin = user?.role === 'system_admin';
  const [view, setView] = useState('warehouse'); // warehouse | management
  const [d, setD] = useState(null);
  const [mgmt, setMgmt] = useState(null);
  const [days, setDays] = useState(30);
  const [exceptions, setExceptions] = useState(null);
  const [pendingUrgent, setPendingUrgent] = useState([]);
  const [shipments, setShipments] = useState([]);
  const [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loadError, setLoadError] = useState(null);

  async function load() {
    try {
      const [dash, exc, pu, ship, ord] = await Promise.all([
        api.warehouseDashboard(),
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
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message || 'שגיאה בטעינת הדשבורד');
    }
  }

  async function loadManagement(n = days) {
    try {
      setMgmt(await api.managementDashboard(n));
      setLastUpdated(new Date());
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message || 'שגיאה בטעינת תמונת ההנהלה');
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => {
      if (['order', 'urgent_request', 'shipment', '__connected'].includes(evt.type)) load();
    });
    const timer = setInterval(load, WAREHOUSE_REFRESH_MS);
    return () => { off(); clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (view !== 'management') return undefined;
    loadManagement(days);
    const timer = setInterval(() => loadManagement(days), MANAGEMENT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [view, days]);

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

  if (!d) return loadError ? <div className="error-box">{loadError}</div> : null;

  const onHold = exceptions?.onHold || [];
  const linkExceptions = exceptions?.linkExceptions || [];
  const shipmentExceptions = exceptions?.shipmentExceptions || [];
  const activeShipments = shipments.filter((s) => ACTIVE_SHIP_STATUSES.includes(s.status));
  const activeOrders = orders
    .filter((o) => !['closed', 'cancelled'].includes(o.status))
    .sort((a, b) => (a.queue_position ? a.queue_position.position : Infinity) - (b.queue_position ? b.queue_position.position : Infinity))
    .slice(0, 12);
  const activeTotal = orders.filter((o) => !['closed', 'cancelled'].includes(o.status)).length;
  const exceptionsTotal = onHold.length + linkExceptions.length + shipmentExceptions.length;

  return (
    <div>
      <div className="dashboard-greeting">
        <div className="dashboard-greeting-text">שלום, {firstName(user?.name)} 👋</div>
        {lastUpdated && <div className="dashboard-updated">עודכן לאחרונה: {lastUpdated.toLocaleTimeString('he-IL')}</div>}
      </div>

      {isAdmin && (
        <div className="dashboard-tabs toggle">
          <button className={view === 'warehouse' ? 'active' : ''} onClick={() => setView('warehouse')}>🏭 המחסן היום</button>
          <button className={view === 'management' ? 'active' : ''} onClick={() => setView('management')}>📊 תמונת הנהלה</button>
        </div>
      )}
      {loadError && <div className="error-box">{loadError}</div>}

      {view === 'management' ? (
        mgmt ? <ManagementView data={mgmt} days={days} onChangeDays={setDays} /> : <div className="empty-state">טוען…</div>
      ) : (
      <>
      <WarehouseToday data={d} onOpenOrder={onOpenOrder} />

      {/* ---- הזמנות פעילות ---- */}
      <div className="settings-card">
        <div className="settings-card-title">📦 הזמנות פעילות {activeTotal > 0 && `(${activeTotal})`}</div>
        {activeOrders.length === 0 && <div className="empty-state">אין הזמנות פעילות כרגע</div>}
        {activeOrders.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <div className="scroll-panel">
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
            </div>
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
        {pendingUrgent.length > 0 && (
          <div className="scroll-panel">
            {pendingUrgent.map((r) => (
              <div className="admin-list-item" key={r.request_id}>
                <div className="top" onClick={() => onOpenOrder(r.order_key)} style={{ cursor: 'pointer' }}>
                  <b>הזמנה {r.order_num}</b>
                  <span className="meta">{r.customer_name}</span>
                </div>
                <div className="meta">סוכן: {r.agent_name} · {formatDateSafe(r.created_at)}</div>
                <div className="actions">
                  <button className="btn-approve" disabled={busy} onClick={() => decide(r.request_id, true)}>אשר דחיפות</button>
                  <button className="btn-reject" disabled={busy} onClick={() => decide(r.request_id, false)}>דחה</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- חריגות ---- */}
      <div className="settings-card">
        <div className="settings-card-title">⚠️ חריגות {exceptionsTotal > 0 && `(${exceptionsTotal})`}</div>
        {exceptionsTotal === 0 && <div className="empty-state">אין חריגות כרגע 🎉</div>}

        {exceptionsTotal > 0 && (
          <div className="scroll-panel">
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
                      <span className="meta">{formatDateSafe(le.created_at)}</span>
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
        )}
      </div>

      {/* ---- משלוחים פעילים ---- */}
      <div className="settings-card">
        <div className="settings-card-title">🚚 משלוחים פעילים {activeShipments.length > 0 && `(${activeShipments.length})`}</div>
        {activeShipments.length === 0 && <div className="empty-state">אין משלוחים פעילים כרגע</div>}
        {activeShipments.length > 0 && (
          <div className="scroll-panel">
            {activeShipments.map((s) => (
              <div className="admin-list-item" key={s.track_no}>
                <div className="top">
                  <b>{s.track_no}</b>
                  <span className={`badge ship-${s.status}`}>{shipLabel(s.status)}</span>
                </div>
                {s.status_desc_heb && <div className="meta">{s.status_desc_heb}</div>}
                {s.estimate_delivery && <div className="meta">צפי מסירה: {formatDateSafe(s.estimate_delivery)}</div>}
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
        )}
      </div>

      </>
      )}
    </div>
  );
}
