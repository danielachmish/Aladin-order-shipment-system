import React, { useState } from 'react';
import { api } from '../api.js';

// "⚙️ הגדרות הזמנה" — פאנל מהיר משותף (נפתח גם מהרשימה הראשית וגם מתוך
// פרטי ההזמנה, ר' ייעוץ 17.9.2026): עדיפות, אופן משלוח מתוכנן, גוביינא,
// הערה חופשית. מנהל מחסן/מנהל מערכת בלבד. הזמנה מקושרת — הכל חוץ מעדיפות
// משתכפל אוטומטית על כל הקבוצה בשרת (משלוח פיזי אחד).
export default function OrderSettingsModal({ order, onClose, onSaved }) {
  const [priority, setPriority] = useState(order.priority || 'normal');
  const [plannedDeliveryMethod, setPlannedDeliveryMethod] = useState(order.planned_delivery_method || '');
  const [codType, setCodType] = useState(order.cod_type || 'none');
  const [amount, setAmount] = useState(
    order.cod_type === 'custom' || order.cod_type === 'full_plus_extra' ? (order.cod_amount ?? '') : ''
  );
  const [dueDate, setDueDate] = useState(order.cod_due_date || '');
  const [specialInstructions, setSpecialInstructions] = useState(order.special_instructions || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      const res = await api.orderSettings(order.order_key, {
        priority,
        plannedDeliveryMethod: plannedDeliveryMethod || null,
        codType,
        amount: amount !== '' ? Number(amount) : null,
        dueDate: dueDate || null,
        specialInstructions: specialInstructions || null,
      });
      onSaved(res.state);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <h3>⚙️ הגדרות הזמנה {order.order_num}</h3>
        {error && <div className="error-box">{error}</div>}

        <div className="settings-field">
          <label>עדיפות</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="normal">רגילה</option>
            <option value="urgent">דחופה</option>
            <option value="next">הבאה בתור</option>
          </select>
        </div>

        <div className="settings-field">
          <label>אופן משלוח מתוכנן</label>
          <select value={plannedDeliveryMethod} onChange={(e) => setPlannedDeliveryMethod(e.target.value)}>
            <option value="">לא הוגדר</option>
            <option value="ups">🚚 UPS</option>
            <option value="self_pickup">🏠 איסוף עצמי</option>
          </select>
        </div>

        <div className="settings-field">
          <label>גוביינא</label>
          <select value={codType} onChange={(e) => setCodType(e.target.value)}>
            <option value="none">ללא גוביינא</option>
            <option value="full">על סכום ההזמנה</option>
            <option value="custom">סכום אחר</option>
            <option value="full_plus_extra">על ההזמנה + תוספת</option>
          </select>
        </div>
        {(codType === 'custom' || codType === 'full_plus_extra') && (
          <input
            type="number" placeholder={codType === 'custom' ? 'סכום' : 'סכום תוספת'}
            value={amount} onChange={(e) => setAmount(e.target.value)}
            style={{ marginBottom: 8, width: '100%' }}
          />
        )}
        {codType !== 'none' && (
          <input
            type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
            style={{ marginBottom: 8, width: '100%' }}
          />
        )}

        <label style={{ display: 'block', fontWeight: 'bold', marginBottom: 6, fontSize: 14 }}>הערה חופשית</label>
        <textarea
          rows={3} placeholder='למשל: "לא להוציא לפני תשלום" / "איסוף עצמי ותשלום במקום"'
          value={specialInstructions} onChange={(e) => setSpecialInstructions(e.target.value)}
        />

        {order.linked_group_id && (
          <div className="meta" style={{ marginTop: 8 }}>
            🔗 הזמנה מקושרת — משלוח מתוכנן, גוביינא וההערה יחולו על כל ההזמנות בקבוצה (העדיפות נשארת רק על ההזמנה הזו).
          </div>
        )}

        <button className="action-btn" disabled={busy} onClick={save}>שמירה</button>
        <button className="action-btn secondary" onClick={onClose}>ביטול</button>
      </div>
    </div>
  );
}
