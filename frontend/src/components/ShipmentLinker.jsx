import React, { useState } from 'react';
import { api } from '../api.js';
import { showToast } from '../toast.js';

// קישור ידני של משלוח UPS להזמנה (למנהל) — הצעות חכמות מהשרת + הזנת מספר הזמנה.
// ר' backend/src/shipmentLinking.js.
export default function ShipmentLinker({ trackNo, onLinked }) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [orderNum, setOrderNum] = useState('');
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && suggestions === null) {
      try {
        const data = await api.shipmentLinkSuggestions(trackNo);
        setSuggestions(data.suggestions);
      } catch (e) {
        setSuggestions([]);
        showToast(e.message);
      }
    }
  }

  async function link(orderRef, label) {
    setBusy(true);
    try {
      const res = await api.linkShipment(trackNo, orderRef);
      showToast(`שטר ${trackNo} קושר להזמנה ${label}${res.closed ? ' — ההזמנה נסגרה (המשלוח כבר נמסר)' : ''}`);
      setOpen(false);
      setOrderNum('');
      onLinked && onLinked();
    } catch (e) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ship-linker">
      <button className="btn-link-toggle" onClick={toggle}>{open ? 'ביטול' : 'חבר להזמנה'}</button>
      {open && (
        <div className="ship-linker-panel">
          {suggestions === null && <div className="meta">מחפש הזמנות מתאימות...</div>}
          {suggestions && suggestions.length === 0 && <div className="meta">אין הצעות — הזן מספר הזמנה ידנית</div>}
          {suggestions && suggestions.map((s) => (
            <div className="ship-suggestion" key={s.order_key}>
              <div>
                <b>הזמנה {s.order_num}</b> <span className="meta">{s.customer_name}</span>
                <div className="meta">{s.reasons.join(' · ')}</div>
              </div>
              <button className="btn-approve" disabled={busy} onClick={() => link(s.order_key, s.order_num)}>חבר</button>
            </div>
          ))}
          <div className="ship-linker-manual">
            <input
              inputMode="numeric"
              placeholder="מספר הזמנה"
              value={orderNum}
              onChange={(e) => setOrderNum(e.target.value.replace(/\D/g, ''))}
            />
            <button className="btn-approve" disabled={busy || !orderNum} onClick={() => link(orderNum, orderNum)}>חבר</button>
          </div>
        </div>
      )}
    </div>
  );
}
