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

export default function PickChecklist({ mode, order, items, onChanged, busy, setBusy, setError }) {
  const sorted = sortByLocation(items);
  const [editingLine, setEditingLine] = useState(null);
  const [editQty, setEditQty] = useState('');
  const [editNote, setEditNote] = useState('');

  async function markPicked(item, pickStatus, qtyPicked, pickNote) {
    setBusy(true);
    setError('');
    try {
      await api.pickItem(order.order_key, item.line_no, { qtyPicked, pickStatus, pickNote: pickNote || null });
      setEditingLine(null);
      await onChanged();
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
      await api.checkItem(order.order_key, item.line_no, { checked, checkNote: checkNote || null });
      setEditingLine(null);
      await onChanged();
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
      await api.correctPickItem(order.order_key, item.line_no, { qtyPicked, pickStatus, checkNote: checkNote || null });
      setEditingLine(null);
      await onChanged();
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
        const rowDoneClass = mode === 'pick' ? (it.pick_status ? ' done' : '') : ((isMissing || it.checked) ? ' done' : '');
        return (
          <div className={'pick-item-card' + rowDoneClass + (isMissing ? ' missing' : '')} key={it.line_no}>
            <div className="pick-item-top">
              {it.location && <span className="pick-location-badge">{it.location}</span>}
              <div className="pick-item-name">{it.item_name}</div>
            </div>
            <div className="meta">{it.item_code} · הוזמן: {it.quantity}{it.barcode ? ` · ברקוד: ${it.barcode}` : ''}</div>

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
        );
      })}
    </div>
  );
}
