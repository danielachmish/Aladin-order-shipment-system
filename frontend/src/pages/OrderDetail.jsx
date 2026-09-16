import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { statusLabel, priorityLabel, shipLabel } from '../labels.js';
import { onLive } from '../ws.js';
import OrderTimeline from '../components/OrderTimeline.jsx';
import PickChecklist from '../components/PickChecklist.jsx';
import { shareShortageSummary } from '../shareShortage.js';
import { formatDateSafe } from '../format.js';

const ISSUE_REASONS = ['חוסר במלאי', 'פריט לא נמצא', 'כמות לא תואמת', 'הזמנה מעוכבת', 'אחר'];

// תואם STATUS_INDEX ב-backend/src/workflow.js (assertLinkedGroupReady) — משמש
// רק להתראה מוקדמת בצד לקוח, לא לאכיפה עצמה (זו כבר קיימת בשרת).
const STATUS_INDEX = {
  open: 0, waiting_pick: 1, picking: 2, ready_for_check: 3,
  ready_to_pack: 4, waiting_pickup: 5, delivered_to_ups: 6, closed: 7,
};

export default function OrderDetail({ user, orderKey, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showIssue, setShowIssue] = useState(false);
  const [issueReason, setIssueReason] = useState(ISSUE_REASONS[0]);
  const [issueNote, setIssueNote] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showAddition, setShowAddition] = useState(false);
  const [additionNote, setAdditionNote] = useState('');
  const [showCancel, setShowCancel] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [showLink, setShowLink] = useState(false);
  const [linkOrderNum, setLinkOrderNum] = useState('');
  const [linkResults, setLinkResults] = useState([]);
  const [linkSearching, setLinkSearching] = useState(false);
  const [showPack, setShowPack] = useState(false);
  const [packageCount, setPackageCount] = useState('');
  const [palletCount, setPalletCount] = useState('');

  // חיפוש הזמנה לקישור — גם לפי מספר וגם לפי שם לקוח (בקשת דניאל 14.9.2026:
  // "לא תמיד זוכר את מספר ההזמנה"). מציג את ההזמנות התואמות, ממוינות מהחדשה
  // לישנה, ולחיצה על תוצאה מקשרת ישירות בלי להקליד מספר.
  useEffect(() => {
    if (!showLink || linkOrderNum.trim().length < 2) {
      setLinkResults([]);
      return;
    }
    let cancelled = false;
    setLinkSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.listOrders({ search: linkOrderNum.trim() });
        if (cancelled) return;
        const filtered = res.orders
          .filter((o) => o.order_key !== orderKey)
          .sort((a, b) => b.order_num - a.order_num)
          .slice(0, 8);
        setLinkResults(filtered);
      } catch {
        if (!cancelled) setLinkResults([]);
      } finally {
        if (!cancelled) setLinkSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [linkOrderNum, showLink, orderKey]);

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

  // עדכון מקומי מיידי של שורה בודדת מתשובת ה-API (ליקוט/בדיקה) — בלי לרענן
  // את כל ההזמנה מהשרת. ר' הערה ב-<PickChecklist> על "כל העמוד קופא".
  function updateLocalItem(updatedItem) {
    setData((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.line_no === updatedItem.line_no ? updatedItem : it)),
    }));
  }

  async function act(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      // תיקון (17.9.2026, נתפס ע"י בדיקת E2E): load() בהצלחה מנקה את השגיאה
      // (setError('') בפנים) — לכן חייבים לרענן קודם ורק אז להציג את השגיאה,
      // אחרת הודעת השגיאה "מהבהבת" ונעלמת כמעט מיד לפני שהמשתמש מספיק לקרוא אותה.
      await load();
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // התראה מוקדמת על קישור הזמנות — ברגע "סיום בדיקה" (לא ברגע "סיום אריזה",
  // שזה כבר מאוחר מדי — הקרטון כבר סגור). ר' בקשת דניאל 17.9.2026: האורז
  // צריך לדעת *לפני* שהוא סוגר קרטון שיש הזמנה מקושרת שעדיין לא הגיעה לשלב.
  async function handleFinishCheck() {
    setBusy(true);
    setError('');
    try {
      await api.finishCheck(orderKey, version);
      const fresh = await api.getOrder(orderKey);
      setData(fresh);
      const behind = (fresh.linked_orders || []).filter(
        (lo) => (STATUS_INDEX[lo.status] ?? 0) < STATUS_INDEX.ready_to_pack
      );
      if (behind.length > 0) {
        window.alert(
          `⚠️ הזמנה זו מקושרת ל${behind.map((lo) => `הזמנה ${lo.order_num} (${statusLabel(lo.status)})`).join(', ')} — עדיין לא הגיעה לשלב אריזה.\n\nאל תסגרו את הקרטון עד שהיא תגיע לאותו שלב!`
        );
      }
    } catch (e) {
      await load(); // ר' הערה ב-act() — סדר הפוך כדי שהשגיאה לא תימחק
      setError(e.message);
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

  const { order, items, events, shipments, urgent_requests: urgentReqs, queue_position: queuePos, linked_orders: linkedOrders } = data;
  const version = order.version;
  const isWarehouse = user.role === 'warehouse' || user.role === 'warehouse_manager';
  const isManager = user.role === 'warehouse_manager' || user.role === 'system_admin';
  // "שלי" = שיוך מפורש (agent_id, נדיר) או התאמת השם שלי לשם הסוכן שהגיע
  // מסיגמא (order.agent_name) — כי הזמנות מגיעות עם שם סוכן כטקסט חופשי בלבד,
  // לא מקושרות למשתמש אפליקציה. בלי זה שום סוכן לא רואה כפתורי דחיפות/תוספת
  // על ההזמנות שלו (בקשת דניאל, 14.9.2026).
  const isOwnAgent = user.role === 'agent' && (
    order.agent_id === user.id ||
    (order.agent_name && order.agent_name.trim() === (user.name || '').trim())
  );
  const pendingUrgent = urgentReqs.find((r) => r.status === 'pending');

  // ליקוט לפי מיקום + בדיקה (QC) — ר' PICKING_QC_SPEC.md
  const isPicking = order.status === 'picking';
  const isChecking = order.status === 'ready_for_check';
  const pickDoneCount = items.filter((it) => it.pick_status).length;
  const checkDoneCount = items.filter((it) => it.pick_status === 'missing' || it.checked).length;
  const allPicked = items.length > 0 && pickDoneCount === items.length;
  const allChecked = items.length > 0 && checkDoneCount === items.length;
  const shortageItems = items.filter((it) => it.pick_status === 'partial' || it.pick_status === 'missing');

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
        {order.delivery_method && (
          <div className="meta">אופן משלוח: {order.delivery_method === 'self_pickup' ? 'איסוף עצמי' : 'UPS'}</div>
        )}
        {order.agent_name && <div className="meta">סוכן משויך: {order.agent_name}</div>}
        {order.status === 'on_hold' && <div className="meta" style={{ color: '#c0392b', marginTop: 6 }}>סיבה: {order.hold_reason}</div>}
        {order.pending_addition_note && (
          <div className="live-pill off" style={{ marginTop: 8 }}>⏳ ממתינה תוספת: {order.pending_addition_note}</div>
        )}
        {linkedOrders.length > 0 && (
          <div className="live-pill on" style={{ marginTop: 8 }}>
            🔗 מקושרת ל{linkedOrders.map((lo) => `הזמנה ${lo.order_num} (${statusLabel(lo.status)})`).join(', ')}
          </div>
        )}
      </div>

      {/* ---- באנר: דחיפות + תוספת (סוכן ומנהל) ---- */}
      {(isOwnAgent || isManager) && !['closed', 'cancelled'].includes(order.status) && (
        <div className="btn-row" style={{ marginTop: 10, marginBottom: 4 }}>
          {isManager ? (
            order.priority === 'urgent'
              ? <button className="action-btn warn" disabled={busy} onClick={() => act(() => api.setPriority(orderKey, 'normal'))}>ביטול דחיפות</button>
              : <button className="action-btn warn" disabled={busy} onClick={() => act(() => api.setPriority(orderKey, 'urgent'))}>סמן כדחופה</button>
          ) : (
            pendingUrgent
              ? <div className="live-pill off">בקשת דחיפות ממתינה לאישור מנהל</div>
              : order.priority === 'urgent'
                ? <div className="live-pill on">ההזמנה מסומנת כדחופה</div>
                : <button className="action-btn warn" disabled={busy} onClick={() => act(() => api.requestUrgent(orderKey))}>דחופה</button>
          )}

          {order.pending_addition_note ? (
            <button className="action-btn secondary" disabled={busy} onClick={() => act(() => api.additionReceived(orderKey))}>התוספת הגיעה</button>
          ) : (
            <button className="action-btn secondary" disabled={busy} onClick={() => setShowAddition(true)}>תוספת בדרך</button>
          )}

          {isManager && (
            <button className="action-btn danger" disabled={busy} onClick={() => setShowCancel(true)}>ביטול הזמנה</button>
          )}
        </div>
      )}

      {/* קישור הזמנות — זמין למחסן/סוכן/מנהל, לא רק סוכן/מנהל (בקשת דניאל 14.9.2026) */}
      {(isWarehouse || isOwnAgent || isManager) && !['closed', 'cancelled'].includes(order.status) && (
        <div className="btn-row" style={{ marginBottom: 4 }}>
          {linkedOrders.length > 0 ? (
            <button className="action-btn secondary" disabled={busy} onClick={() => act(() => api.unlinkOrder(orderKey))}>בטל קישור</button>
          ) : (
            <button className="action-btn secondary" disabled={busy} onClick={() => setShowLink(true)}>🔗 קשר להזמנה אחרת</button>
          )}
        </div>
      )}

      {!['cancelled'].includes(order.status) && (
        <OrderTimeline status={order.status} preWaitStatus={order.pre_wait_status} deliveryMethod={order.delivery_method} />
      )}

      <div className="section-title">פריטים</div>

      {isWarehouse && (isPicking || isChecking) ? (
        <>
          <div className="pick-progress">
            <div className="pick-progress-bar">
              <div
                className="pick-progress-fill"
                style={{ width: `${items.length ? Math.round((isPicking ? pickDoneCount : checkDoneCount) / items.length * 100) : 0}%` }}
              />
            </div>
            <div className="pick-progress-label">
              {isPicking ? pickDoneCount : checkDoneCount} מתוך {items.length} שורות הושלמו
            </div>
          </div>
          <PickChecklist
            mode={isPicking ? 'pick' : 'check'}
            order={order}
            items={items}
            onItemUpdated={updateLocalItem}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
          />
        </>
      ) : (
        items.map((it) => (
          <div className="item-row" key={it.line_no}>
            <div>
              <div className="name">{it.item_name}</div>
              <div className="sub">{it.item_code} {it.location ? `· מיקום ${it.location}` : ''} {it.barcode ? `· ברקוד ${it.barcode}` : ''}</div>
            </div>
            <div>{it.quantity} × ₪{it.price}</div>
          </div>
        ))
      )}

      {/* ---- פעולות מחסן ---- */}
      {isWarehouse && order.status === 'waiting_pick' && (
        <button className="action-btn" disabled={busy} onClick={() => act(() => api.claim(orderKey, version))}>התחלת ליקוט</button>
      )}
      {isWarehouse && isPicking && (
        <div className="btn-row">
          <button
            className="action-btn" disabled={busy || !allPicked}
            title={!allPicked ? 'יש עוד שורות שלא סומנו' : undefined}
            onClick={() => act(() => api.finishPicking(orderKey, version))}
          >
            סיום ליקוט{!allPicked ? ` (${pickDoneCount}/${items.length})` : ''}
          </button>
          {allPicked && shortageItems.length > 0 && (
            <button
              className="action-btn warn"
              onClick={() => shareShortageSummary(order, shortageItems).catch((e) => setError(e.message))}
            >
              📤 שתף ללקוח ({shortageItems.length})
            </button>
          )}
        </div>
      )}
      {isWarehouse && isChecking && (
        <button
          className="action-btn" disabled={busy || !allChecked}
          title={!allChecked ? 'יש עוד שורות שלא אושרו בבדיקה' : undefined}
          onClick={handleFinishCheck}
        >
          אישרתי בדיקה — מוכן לאריזה{!allChecked ? ` (${checkDoneCount}/${items.length})` : ''}
        </button>
      )}
      {isWarehouse && order.status === 'ready_to_pack' && (
        <button className="action-btn" disabled={busy} onClick={() => setShowPack(true)}>סיום אריזה</button>
      )}
      {isWarehouse && order.status === 'waiting_pickup' && (
        <div className="btn-row">
          <button className="action-btn" disabled={busy} onClick={() => act(() => api.deliverUps(orderKey, version))}>מסירה ל-UPS</button>
          <button
            className="action-btn secondary"
            disabled={busy || !!order.pending_addition_note}
            title={order.pending_addition_note ? `לא ניתן לסגור — ממתינה תוספת: ${order.pending_addition_note}` : undefined}
            onClick={() => act(() => api.selfPickup(orderKey, version))}
          >
            איסוף עצמי על ידי הלקוח
          </button>
        </div>
      )}
      {(isWarehouse || user.role === 'system_admin') && order.status === 'delivered_to_ups' && (
        <button
          className="action-btn secondary"
          disabled={busy || !!order.pending_addition_note}
          title={order.pending_addition_note ? `לא ניתן לסגור — ממתינה תוספת: ${order.pending_addition_note}` : undefined}
          onClick={() => act(() => api.closeOrder(orderKey))}
        >
          סגירת הזמנה{order.pending_addition_note ? ' (ממתינה תוספת)' : ''}
        </button>
      )}

      {isWarehouse && ['waiting_pick', 'picking', 'ready_for_check', 'ready_to_pack', 'waiting_pickup'].includes(order.status) && (
        <div className="btn-row">
          <button className="action-btn warn" disabled={busy} onClick={() => setShowIssue(true)}>דיווח בעיה</button>
          <button className="action-btn secondary" disabled={busy} onClick={() => act(() => api.requestWait(orderKey))}>ממתין לתשובת לקוח/סוכן</button>
        </div>
      )}

      {order.status === 'waiting_answer' && (isWarehouse || isOwnAgent || user.role === 'system_admin') && (
        <button className="action-btn" disabled={busy} onClick={() => act(() => api.receivedAnswer(orderKey))}>התקבלה תשובה</button>
      )}

      {/* ---- פעולות מנהל ---- */}
      {/* שחרור חסימה: גם מחסן רגיל (לא רק מנהל). ביטול מלא — כפתור "ביטול הזמנה" בבאנר למעלה, מנהל בלבד */}
      {(isWarehouse || user.role === 'system_admin') && order.status === 'on_hold' && (
        <button className="action-btn" disabled={busy} onClick={() => act(() => api.releaseHold(orderKey))}>שחרור חסימה</button>
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
              {s.estimate_delivery && <div className="meta">צפי מסירה: {formatDateSafe(s.estimate_delivery)}</div>}
              {s.delivered_time && <div className="meta">נמסר: {formatDateSafe(s.delivered_time)} {s.received_by ? `(${s.received_by})` : ''}</div>}
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
              <b>{statusLabel(e.to_status)}</b> · {e.user_name || 'מערכת'} · {formatDateSafe(e.created_at)}
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

      {showAddition && (
        <div className="modal-backdrop" onClick={() => setShowAddition(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>תוספת בדרך</h3>
            <div className="meta" style={{ marginBottom: 8 }}>המחסן לא יוכל לסגור את ההזמנה עד שתסמנו שהתוספת הגיעה.</div>
            <textarea placeholder="מה חסר / מה מגיע בהמשך" rows={3} value={additionNote} onChange={(e) => setAdditionNote(e.target.value)} />
            <button
              className="action-btn warn"
              disabled={busy}
              onClick={() => act(async () => {
                await api.requestAddition(orderKey, additionNote);
                setShowAddition(false);
                setAdditionNote('');
              })}
            >
              שמירה
            </button>
            <button className="action-btn secondary" onClick={() => setShowAddition(false)}>ביטול</button>
          </div>
        </div>
      )}

      {showCancel && (
        <div className="modal-backdrop" onClick={() => setShowCancel(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>ביטול הזמנה</h3>
            <div className="meta" style={{ marginBottom: 8 }}>פעולה סופית — נא לציין סיבה.</div>
            <textarea placeholder="סיבת הביטול (חובה)" rows={3} value={cancelNote} onChange={(e) => setCancelNote(e.target.value)} />
            <button
              className="action-btn danger"
              disabled={busy || !cancelNote.trim()}
              onClick={() => act(async () => {
                await api.cancelOrder(orderKey, cancelNote.trim());
                setShowCancel(false);
                setCancelNote('');
              })}
            >
              אישור ביטול
            </button>
            <button className="action-btn secondary" onClick={() => setShowCancel(false)}>סגירה</button>
          </div>
        </div>
      )}

      {showPack && (
        <div className="modal-backdrop" onClick={() => setShowPack(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>כמה יצא בפועל?</h3>
            <div className="meta" style={{ marginBottom: 8 }}>
              כדי שהמזכירה תדע כמה שטרי מטען UPS להפיק. אפשר למלא אחד מהשניים, גם שניהם, או להשאיר ריק ולדלג.
            </div>
            <div className="form-row" style={{ marginBottom: 8 }}>
              <label>חבילות</label>
              <input
                type="number" min="0" placeholder="0"
                value={packageCount}
                onChange={(e) => setPackageCount(e.target.value)}
              />
            </div>
            <div className="form-row" style={{ marginBottom: 8 }}>
              <label>משטחים</label>
              <input
                type="number" min="0" placeholder="0"
                value={palletCount}
                onChange={(e) => setPalletCount(e.target.value)}
              />
            </div>
            <button
              className="action-btn"
              disabled={busy}
              onClick={() => act(async () => {
                await api.packDone(
                  orderKey, version,
                  packageCount.trim() ? Number(packageCount) : null,
                  palletCount.trim() ? Number(palletCount) : null
                );
                setShowPack(false);
                setPackageCount('');
                setPalletCount('');
              })}
            >
              סיום אריזה
            </button>
            <button className="action-btn secondary" onClick={() => setShowPack(false)}>ביטול</button>
          </div>
        </div>
      )}

      {showLink && (
        <div className="modal-backdrop" onClick={() => setShowLink(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>קשר להזמנה אחרת</h3>
            <div className="meta" style={{ marginBottom: 8 }}>
              למשל הזמנת תוספת שהגיעה כהזמנה נפרדת מסיגמא — היא תעלה לאותו מקום בתור.
            </div>
            <input
              type="text" placeholder="מספר הזמנה או שם לקוח" value={linkOrderNum}
              onChange={(e) => setLinkOrderNum(e.target.value)}
              autoFocus
            />
            {linkSearching && <div className="meta">מחפש...</div>}
            {linkResults.length > 0 && (
              <div className="link-search-results">
                {linkResults.map((o) => (
                  <div
                    key={o.order_key}
                    className="link-search-row"
                    onClick={() => act(async () => {
                      await api.linkOrder(orderKey, String(o.order_num));
                      setShowLink(false);
                      setLinkOrderNum('');
                      setLinkResults([]);
                    })}
                  >
                    <b>הזמנה {o.order_num}</b>
                    <span className="meta">{o.customer_name} · {statusLabel(o.status)}</span>
                  </div>
                ))}
              </div>
            )}
            <button
              className="action-btn"
              disabled={busy || !linkOrderNum.trim()}
              onClick={() => act(async () => {
                await api.linkOrder(orderKey, linkOrderNum.trim());
                setShowLink(false);
                setLinkOrderNum('');
              })}
            >
              קישור לפי מספר מדויק
            </button>
            <button className="action-btn secondary" onClick={() => setShowLink(false)}>ביטול</button>
          </div>
        </div>
      )}
    </div>
  );
}
