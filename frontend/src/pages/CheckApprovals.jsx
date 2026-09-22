import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';
import { statusLabel } from '../labels.js';

// מסך אישורי מנהל לשורות שנלקטו ידנית (בלי סריקת ברקוד) — הכתובת היחידה
// ששחררת הזמנה חסומה על "ממתין לאישור מנהל" (ר' OrderDetail.jsx). זמין
// למנהל מחסן/מנהל מערכת בלבד. ר' בקשת דניאל 22.9.2026.
export default function CheckApprovals({ onOpenOrder }) {
  const [approvals, setApprovals] = useState([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await api.pendingManualPickApprovals();
    setApprovals(r.approvals);
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => {
      if (['order', 'manual_pick_approval', '__connected'].includes(evt.type)) load();
    });
    return off;
  }, []);

  async function approve(orderKey, lineNo) {
    setBusy(true);
    try {
      await api.approveManualPick(orderKey, lineNo);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-card-title">🧾 אישורי בדיקות {approvals.length > 0 && `(${approvals.length})`}</div>
      {approvals.length === 0 && <div className="empty-state">אין פריטים הממתינים לאישור</div>}
      {approvals.map((a) => (
        <div className="admin-list-item" key={`${a.order_key}_${a.line_no}`}>
          <div className="top" onClick={() => onOpenOrder(a.order_key)} style={{ cursor: 'pointer' }}>
            <b>הזמנה {a.order_num}</b>
            <span className="meta">{a.customer_name}</span>
          </div>
          <div className="meta">
            {a.item_name} ({a.item_code}) · נלקט: {a.qty_picked}/{a.quantity}
            {a.location ? ` · מיקום ${a.location}` : ''} · סטטוס: {statusLabel(a.order_status)}
          </div>
          {a.pick_note && <div className="meta">הערה: {a.pick_note}</div>}
          <div className="actions">
            <button className="btn-approve" disabled={busy} onClick={() => approve(a.order_key, a.line_no)}>✓ אישור</button>
          </div>
        </div>
      ))}
    </div>
  );
}
