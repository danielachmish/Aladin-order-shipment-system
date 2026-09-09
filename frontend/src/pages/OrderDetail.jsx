import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { statusLabel, priorityLabel, shipLabel } from '../labels.js';
import { onLive } from '../ws.js';

const ISSUE_REASONS = ['חוסר במלאי', 'פריט לא נמצא', 'כמות לא תואמת', 'הזמנה מעוכבת', 'אחר'];

export default function OrderDetail({ user, orderKey, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showIssue, setShowIssue] = useState(false);
  const [issueReason, setIssueReason] = useState(ISSUE_REASONS[0]);
  const [issueNote, setIssueNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  async function load() {
    try {
      const d = await api.getOrder(orderKey);
      setData(d);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => {
      if (evt.payload && evt.payload.order_key === orderKey) load();
      if (evt.type === 'shipment' && evt.payload.linked && evt.payload.linked.includes(orderKey)) load();
      if (evt.type === '__connected') load();
    });
    return off;
  }, [orderKey]);

  async function act(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return (
    <div>
      <button className="action-btn secondary" onClick={onBack}>→ חזרה</button>
      <div className="error-box" style={{ marginTop: 12 }}>{error}</div>
    </div>
  );
  if (!data) return <div className="empty-state">טוען...</div>;

  const { order, items, events, shipments, urgent_requests: urgentReqs, queue_position: queuePos } = data;
  const version = order.version;
  const isWarehouse = user.role === 'warehouse' || user.role === 'warehouse_manager';
  const isManager = user.role === 'warehouse_manager' || user.role === 'system_admin';
  const isOwnAgent = user.role === 'agent' && order.agent_id === user.id;
  const pendingUrgent = urgentReqs.find((r) => r.status === 'pending');

  return (
    <div>
      <button className="action-btn secondary" onClick={onBack} style={{ marginBottom: 12 }}>→ חזרה לרשימה</button>
      {error && <div className="error-box">{error}</div>}

      <div className="detail-header">
        <div className="num">הזמנה {order.order_num}</div>
        <div className="customer">{order.customer_name}</div>
        <div className="row2" style={{ marginTop: 8 }}>
          <span className={`badge status-${order.status}`}>{statusLabel(order.status)}</span>
          {order.priority !== 'normal' && <span className={`badge priority-${order.priority}`}>{priorityLabel(order.priority)}</span>}
        </div>
        <div className="amounts">
          <span>שורות: {order.line_count}</span>
          <span>סכום: ₪{order.total_amount}</span>
        </div>
        {order.notes && <div className="meta" style={{ marginTop: 6 }}>הערה: {order.notes}</div>}
        {order.status === 'waiting_pick' && queuePos && (
          <div className="queue-pos">בתור {queuePos.position} מתוך {queuePos.total} · {queuePos.ahead} הזמנות לפניה</div>
        )}
        {order.status === 'picking' && <div className="meta" style={{ marginTop: 6 }}>מטפל: {order.claimed_by_name}</div>}
        {order.agent_name && <div className="meta">סוכן משויך: {order.agent_name}</div>}
        {order.status === 'on_hold' && <div className="meta" style={{ color: '#c0392b', marginTop: 6 }}>סיבה: {order.hold_reason}</div>}
      </div>

      <div className="section-title">פריטים</div>
      {items.map((it) => (
        <div className="item-row" key={it.line_no}>
          <div>
            <div className="name">{it.item_name}</div>
            <div className="sub">{it.item_code} {it.location ? `· מיקום ${it.location}` : ''}</div>
          </div>
          <div>{it.quantity} × ₪{it.price}</div>
        </div>
      ))}

      {/* ---- פעולות מחסן ---- */}
      {isWarehouse && order.status === 'waiting_pick' && (
        <button className="action-btn" disabled={busy} onClick={() => act(() => api.claim(orderKey, version))}>התחלת ליקוט</button>
      )}
      {isWarehouse && order.status === 'picking' && (
        <button className="action-btn" disabled={busy} onClick={() => act(() => api.finishPicking(orderKey, version))}>סיום ליקוט</button>
      )}
      {isWarehouse && order.status === 'ready_to_pack' && (
        <button className="action-btn" disabled={busy} onClick={() => act(() => api.packDone(orderKey, version))}>סיום אריזה</button>
      )}
      {isWarehouse && order.status === 'waiting_pickup' && (
        <button className="action-btn" disabled={busy} onClick={() => act(() => api.deliverUps(orderKey, version))}>מסירה ל-UPS</button>
      )}
      {(isWarehouse || user.role === 'system_admin') && order.status === 'delivered_to_ups' && (
        <button className="action-btn secondary" disabled={busy} onClick={() => act(() => api.closeOrder(orderKey))}>סגירת הזמנה</button>
      )}

      {isWarehouse && ['waiting_pick', 'picking', 'ready_to_pack', 'waiting_pickup'].includes(order.status) && (
        <div className="btn-row">
          <button className="action-btn warn" disabled={busy} onClick={() => setShowIssue(true)}>דיווח בעיה</button>
          <button className="action-btn secondary" disabled={busy} onClick={() => act(() => api.requestWait(orderKey))}>ממתין לתשובת לקוח/סוכן</button>
        </div>
      )}

      {order.status === 'waiting_answer' && (isWarehouse || isOwnAgent || user.role === 'system_admin') && (
        <button className="action-btn" disabled={busy} onClick={() => act(() => api.receivedAnswer(orderKey))}>התקבלה תשובה</button>
      )}

      {/* ---- פעולות מנהל ---- */}
      {isManager && order.status === 'on_hold' && (
        <div className="btn-row">
          <button className="action-btn" disabled={busy} onClick={() => act(() => api.releaseHold(orderKey))}>שחרור חסימה</button>
          <button className="action-btn danger" disabled={busy} onClick={() => act(() => api.cancelOrder(orderKey, 'בוטל על ידי מנהל'))}>ביטול הזמנה</button>
        </div>
      )}

      {isManager && order.status === 'waiting_pick' && (
        <div className="btn-row">
          {order.priority !== 'next' && (
            <button className="action-btn secondary" disabled={busy} onClick={() => act(() => api.setPriority(orderKey, 'next'))}>קבע כהזמנה הבאה</button>
          )}
          {order.priority !== 'normal' && (
            <button className="action-btn secondary" disabled={busy} onClick={() => act(() => api.setPriority(orderKey, 'normal'))}>החזר לתור רגיל</button>
          )}
        </div>
      )}

      {/* ---- בקשת דחיפות לסוכן ---- */}
      {isOwnAgent && ['waiting_pick', 'picking', 'ready_to_pack', 'waiting_pickup'].includes(order.status) && (
        pendingUrgent
          ? <div className="live-pill off" style={{ marginTop: 12 }}>בקשת דחיפות ממתינה לאישור מנהל</div>
          : order.priority === 'urgent'
            ? <div className="live-pill on" style={{ marginTop: 12 }}>ההזמנה מסומנת כדחופה</div>
            : <button className="action-btn warn" disabled={busy} onClick={() => act(() => api.requestUrgent(orderKey))}>בקשת דחיפות</button>
      )}

      {/* ---- משלוח ---- */}
      {shipments.length > 0 && (
        <>
          <div className="section-title">משלוח</div>
          {shipments.map((s) => (
            <div className="shipment-card" key={s.track_no}>
              <div className="track">{s.track_no}</div>
              <div style={{ marginTop: 6 }}><span className={`badge ship-${s.status}`}>{shipLabel(s.status)}</span></div>
              {s.status_desc_heb && <div className="meta">{s.status_desc_heb}</div>}
              {s.exception_desc_heb && <div className="meta" style={{ color: '#c0392b' }}>חריגה: {s.exception_desc_heb}</div>}
              {s.estimate_delivery && <div className="meta">צפי מסירה: {new Date(s.estimate_delivery).toLocaleString('he-IL')}</div>}
              {s.delivered_time && <div className="meta">נמסר: {new Date(s.delivered_time).toLocaleString('he-IL')} {s.received_by ? `(${s.received_by})` : ''}</div>}
            </div>
          ))}
        </>
      )}

      <div className="section-title" onClick={() => setShowHistory(!showHistory)} style={{ cursor: 'pointer' }}>
        היסטוריה {showHistory ? '▲' : '▼'}
      </div>
      {showHistory && (
        events.length === 0
          ? <div className="empty-state">אין עדיין היסטוריה</div>
          : events.map((e) => (
            <div className="history-row" key={e.event_id}>
              <b>{statusLabel(e.to_status)}</b> · {e.user_name || 'מערכת'} · {new Date(e.created_at).toLocaleString('he-IL')}
              {e.note ? ` · ${e.note}` : ''}
            </div>
          ))
      )}

      {showIssue && (
        <div className="modal-backdrop" onClick={() => setShowIssue(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>דיווח בעיה</h3>
            <select value={issueReason} onChange={(e) => setIssueReason(e.target.value)}>
              {ISSUE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <textarea placeholder="הערה (לא חובה)" rows={3} style={{ marginTop: 8 }} value={issueNote} onChange={(e) => setIssueNote(e.target.value)} />
            <button
              className="action-btn danger"
              disabled={busy}
              onClick={() => act(async () => {
                await api.reportIssue(orderKey, issueNote ? `${issueReason} — ${issueNote}` : issueReason);
                setShowIssue(false);
                setIssueNote('');
              })}
            >
              שמירת דיווח
            </button>
            <button className="action-btn secondary" onClick={() => setShowIssue(false)}>ביטול</button>
          </div>
        </div>
      )}
    </div>
  );
}
