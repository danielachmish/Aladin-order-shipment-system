import React, { useState } from 'react';
import { api } from '../api.js';

// ליקוט לפי מיקום + בדיקה (QC) — ר' PICKING_QC_SPEC.md (סוכם עם דניאל 14.9.2026).
// mode='pick': המלקט מסמן כל שורה (נלקט הכל / חלקי / חסר), ממוין לפי מיקום פיזי.
// mode='check': הבודק מאשר כל שורה שנלקטה (לא ניתן לאשר שורה שסומנה 'חסר').

function sortByLocation(items) {
  return [...items].sort((a, b) => {
    const la = a.location || '';
    const lb = b.location || '';
    if (la !== lb) return la < lb ? -1 : 1;
    return a.line_no - b.line_no;
  });
}

export default function PickChecklist({ mode, order, items, onItemUpdated, busy, setBusy, setError }) {
  const sorted = sortByLocation(items);
  const [editingLine, setEditingLine] = useState(null);
  const [editQty, setEditQty] = useState('');
  const [editNote, setEditNote] = useState('');
  const [replaceLine, setReplaceLine] = useState(null);
  const [replaceText, setReplaceText] = useState('');
  const [replaceQty, setReplaceQty] = useState('');

  // תיקון (17.9.2026, בקשת דניאל): לחיצה על שורה בליקוט/בדיקה גרמה לרענון
  // מלא של כל ההזמנה (GET נוסף עם כל השורות/אירועים/משלוחים) על כל לחיצה,
  // מה שהרגיש כאילו "כל העמוד קופא". עכשיו מעדכנים רק את השורה שהשתנתה
  // מהתשובה של ה-API עצמה — בלי בקשת רענון נוספת בכלל.
  async function markPicked(item, pickStatus, qtyPicked, pickNote) {
    setBusy(true);
    setError('');
    try {
      const res = await api.pickItem(order.order_key, item.line_no, { qtyPicked, pickStatus, pickNote: pickNote || null });
      setEditingLine(null);
      onItemUpdated(res.item);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function markChecked(item, checked, checkNote) {
    setBusy(true);
    setError('');
    try {
      const res = await api.checkItem(order.order_key, item.line_no, { checked, checkNote: checkNote || null });
      setEditingLine(null);
      onItemUpdated(res.item);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // "הוחלף צבע" — הלקוח אישר תחליף (SKU/צבע אחר, אותו מחיר) לפריט חסר, עם
  // כמות מפורשת כדי שההוראה למזכירה תהיה חד-משמעית ("X יח' Y"). זמין למלקט
  // וגם לבודק ברגע שמסמנים שורה כחסרה/חלקית — לא רק למנהל בהיסטוריה אחר כך
  // (בקשת דניאל 17.9.2026). לא נכתב לסיגמא, תיעוד בלבד. אם המלקט מזין את
  // זה בשלב הליקוט זה נשאר "ממתין לאימות בודק" עד שהבודק בפועל מאשר (ר'
  // confirmReplace) — כדי לוודא שהתחליף (פריט+כמות) באמת נכון לפני שזה
  // משפיע על חישוב הגוביינא.
  async function saveReplace(item, replacedTo, replacedQty) {
    setBusy(true);
    setError('');
    try {
      const res = await api.replaceItem(order.order_key, item.line_no, replacedTo, replacedQty ? Number(replacedQty) : null);
      setReplaceLine(null);
      onItemUpdated(res.item);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmReplace(item) {
    setBusy(true);
    setError('');
    try {
      const res = await api.confirmReplace(order.order_key, item.line_no);
      onItemUpdated(res.item);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // תיקון בודק: המלקט טעה (סימן "נלקט" אבל בפועל חסר/כמות שונה, או להפך —
  // סימן "חסר" אבל בעצם כן נמצא). ר' PICKING_QC_SPEC.md סעיף 12.
  async function correctPick(item, pickStatus, qtyPicked, checkNote) {
    setBusy(true);
    setError('');
    try {
      const res = await api.correctPickItem(order.order_key, item.line_no, { qtyPicked, pickStatus, checkNote: checkNote || null });
      setEditingLine(null);
      onItemUpdated(res.item);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {sorted.map((it) => {
        const isMissing = it.pick_status === 'missing';
        const isShortage = it.pick_status === 'missing' || it.pick_status === 'partial';
        // צבע כרטיס לפי סטטוס — ירוק ללוקט, טיל-ירוק כהה יותר לשורה שהבודק אישר
        // (כדי להבדיל מ"נלקט" סתם), אדום לחסר. ר' בקשת דניאל 17.9.2026.
        const rowDoneClass = mode === 'pick'
          ? ((it.pick_status === 'picked' || it.pick_status === 'partial') ? ' done' : '')
          : (it.checked ? ' checked' : '');
        const shortfall = Math.max(0, (it.quantity || 0) - (it.qty_picked || 0));
        const replaceBlock = isShortage && (
          replaceLine === it.line_no ? (
            <div className="btn-row" onClick={(e) => e.stopPropagation()}>
              <input
                type="number" min="1" className="text-input" style={{ flex: '0 0 64px' }}
                placeholder="כמות" value={replaceQty} onChange={(e) => setReplaceQty(e.target.value)}
              />
              <input
                autoFocus className="text-input" style={{ flex: '1 1 120px' }}
                placeholder="לאיזה צבע/פריט הוחלף?"
                value={replaceText} onChange={(e) => setReplaceText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveReplace(it, replaceText, replaceQty); }}
              />
              <button className="action-btn small" disabled={busy} onClick={() => saveReplace(it, replaceText, replaceQty)}>שמירה</button>
              <button className="action-btn secondary small" onClick={() => setReplaceLine(null)}>ביטול</button>
            </div>
          ) : it.replaced_to ? (
            <div className="btn-row" style={{ alignItems: 'center' }}>
              <span
                className={'replaced-note' + (it.replaced_confirmed ? '' : ' pending')}
                onClick={() => { setReplaceLine(it.line_no); setReplaceText(it.replaced_to); setReplaceQty(String(it.replaced_qty ?? '')); }}
              >
                🔄 {it.replaced_qty} יח&#39; {it.replaced_to}{it.replaced_confirmed ? ' · מאומת' : ' · ממתין לאימות בודק'}
              </span>
              {!it.replaced_confirmed && mode === 'check' && (
                <button className="action-btn small" disabled={busy} onClick={() => confirmReplace(it)}>✓ אשר תחליף</button>
              )}
            </div>
          ) : (
            <div className="btn-row">
              <button
                className="action-btn secondary small" disabled={busy}
                onClick={() => { setReplaceLine(it.line_no); setReplaceText(''); setReplaceQty(String(shortfall || it.quantity || 1)); }}
              >
                🔄 הוחלף צבע
              </button>
            </div>
          )
        );
        return (
          <div className={'pick-item-card' + rowDoneClass + (isMissing ? ' missing' : '')} key={it.line_no}>
            {it.location && <div className="pick-item-location">📍 {it.location}</div>}
            <div className="pick-item-main-row">
              <div className="pick-item-name">{it.item_name}</div>
              <div className="pick-item-qty">&times;{it.quantity}</div>
            </div>
            <div className="pick-item-barcode">{it.item_code}{it.barcode ? ` · ${it.barcode}` : ''}</div>

            <div className="pick-item-body">
            {mode === 'pick' && (
              <>
                {it.pick_status && (
                  <div className={`meta pick-status-line ${it.pick_status}`}>
                    {it.pick_status === 'picked' && `✓ נלקט הכל`}
                    {it.pick_status === 'partial' && `⚠️ חלקי — ${it.qty_picked} מתוך ${it.quantity}`}
                    {it.pick_status === 'missing' && (it.auto_missing ? `🔒 ידוע כחסר במלאי — דלגו (או לחצו תיקון אם בכל זאת יש)` : `❌ לא נמצא`)}
                    {it.pick_note ? ` · ${it.pick_note}` : ''}
                  </div>
                )}
                {replaceBlock}

                {editingLine === it.line_no ? (
                  <div className="pick-edit-row">
                    <input
                      type="number" min="0" value={editQty}
                      onChange={(e) => setEditQty(e.target.value)}
                      placeholder="כמות בפועל"
                    />
                    <input
                      type="text" value={editNote}
                      onChange={(e) => setEditNote(e.target.value)}
                      placeholder="הערה (לא חובה)"
                    />
                    <div className="btn-row">
                      <button
                        className="action-btn secondary" disabled={busy || editQty === ''}
                        onClick={() => markPicked(it, Number(editQty) >= it.quantity ? 'picked' : 'partial', Number(editQty) || 0, editNote)}
                      >
                        שמירה
                      </button>
                      <button className="action-btn danger" disabled={busy} onClick={() => markPicked(it, 'missing', 0, editNote)}>לא נמצא בכלל</button>
                      <button className="action-btn secondary" onClick={() => setEditingLine(null)}>ביטול</button>
                    </div>
                  </div>
                ) : it.pick_status ? (
                  // תמיד יש אפשרות לחזור ולתקן מה שכבר סומן — לא רק במסך הבדיקה
                  // (בקשת דניאל 17.9.2026: "תמיד יש אפשרות לחזור לשלב הקודם")
                  <div className="btn-row">
                    <button
                      className="action-btn secondary small" disabled={busy}
                      onClick={() => { setEditingLine(it.line_no); setEditQty(it.qty_picked != null ? String(it.qty_picked) : ''); setEditNote(it.pick_note || ''); }}
                    >
                      🔄 תיקון
                    </button>
                  </div>
                ) : (
                  <div className="btn-row">
                    <button className="action-btn" disabled={busy} onClick={() => markPicked(it, 'picked', it.quantity, null)}>✓ ליקטתי הכל</button>
                    <button
                      className="action-btn secondary" disabled={busy}
                      onClick={() => { setEditingLine(it.line_no); setEditQty(it.qty_picked != null ? String(it.qty_picked) : ''); setEditNote(it.pick_note || ''); }}
                    >
                      כמות אחרת / חסר
                    </button>
                  </div>
                )}
              </>
            )}

            {mode === 'check' && (
              <>
                {isMissing ? (
                  <div className="meta pick-status-line missing">❌ לא נמצא בליקוט — אין מה לבדוק{it.pick_note ? ` · ${it.pick_note}` : ''}</div>
                ) : (
                  <div className="meta">נלקט: {it.qty_picked} מתוך {it.quantity}{it.pick_note ? ` · ${it.pick_note}` : ''}</div>
                )}
                {replaceBlock}

                {editingLine === it.line_no ? (
                  // תיקון בודק — יכול לשנות את מה שהמלקט קבע (כולל להפוך "חסר" ל"נמצא" ולהפך)
                  <div className="pick-edit-row">
                    <input
                      type="number" min="0" value={editQty}
                      onChange={(e) => setEditQty(e.target.value)}
                      placeholder="כמות בפועל"
                    />
                    <input
                      type="text" value={editNote}
                      onChange={(e) => setEditNote(e.target.value)}
                      placeholder="הערת בודק (למה תיקנת)"
                    />
                    <div className="btn-row">
                      <button
                        className="action-btn secondary" disabled={busy || editQty === ''}
                        onClick={() => correctPick(it, Number(editQty) >= it.quantity ? 'picked' : 'partial', Number(editQty) || 0, editNote)}
                      >
                        שמירה + אישור
                      </button>
                      <button className="action-btn danger" disabled={busy} onClick={() => correctPick(it, 'missing', 0, editNote)}>לא נמצא בכלל</button>
                      <button className="action-btn secondary" onClick={() => setEditingLine(null)}>ביטול</button>
                    </div>
                  </div>
                ) : isMissing ? (
                  <div className="btn-row">
                    <button
                      className="action-btn secondary" disabled={busy}
                      onClick={() => { setEditingLine(it.line_no); setEditQty(String(it.quantity)); setEditNote(''); }}
                    >
                      תיקון — בעצם כן נמצא
                    </button>
                  </div>
                ) : it.checked ? (
                  <div className="btn-row">
                    <div className="meta pick-status-line picked">✓ מאושר{it.check_note ? ` · ${it.check_note}` : ''}</div>
                    <button
                      className="action-btn secondary" disabled={busy}
                      onClick={() => { setEditingLine(it.line_no); setEditQty(it.qty_picked != null ? String(it.qty_picked) : ''); setEditNote(''); }}
                    >
                      תיקון
                    </button>
                  </div>
                ) : (
                  <div className="btn-row">
                    <button className="action-btn" disabled={busy} onClick={() => markChecked(it, true, null)}>✓ מאשר</button>
                    <button
                      className="action-btn secondary" disabled={busy}
                      onClick={() => { setEditingLine(it.line_no); setEditQty(it.qty_picked != null ? String(it.qty_picked) : ''); setEditNote(''); }}
                    >
                      תיקון
                    </button>
                  </div>
                )}
              </>
            )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
