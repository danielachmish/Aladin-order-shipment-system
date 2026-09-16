import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';
import { formatDateSafe as fmt } from '../format.js';

// "מוצרים שחזרו למלאי" — מנהל מחסן מסמן שמוצר שאומת כחסר (ר' InventoryShortages
// ו-finish-check) חזר בפועל למלאי. זה מנקה את הסימון האוטומטי מכל ההזמנות
// שעדיין לא לוקטו (ר' ייעוץ 17.9.2026, נושא 4) — לא נוגע בהזמנות שהמלקט כבר
// טיפל בהן בעצמו.
export default function BackInStock() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyCode, setBusyCode] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const data = await api.shortedItems();
      setItems(data.items);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => { if (evt.type === 'order') load(); });
    return off;
  }, []);

  async function clear(itemCode) {
    setBusyCode(itemCode);
    try {
      await api.clearShortedItem(itemCode);
      await load();
    } finally {
      setBusyCode(null);
    }
  }

  return (
    <div>
      <div className="section-title">מוצרים שחזרו למלאי</div>
      <div className="meta" style={{ marginBottom: 8 }}>
        מוצרים שאומתו כחסרים ומשודרים אוטומטית כ"חסר" בכל ההזמנות הפתוחות שעדיין לא לוקטו.
        לחצו "חזר למלאי" ברגע שהמוצר באמת זמין שוב — זה ינקה את הסימון מהזמנות שעוד לא נגעו בו.
      </div>

      {loading && <div className="empty-state">טוען...</div>}
      {!loading && items.length === 0 && <div className="empty-state">אין כרגע מוצרים מסומנים כחסרים 🎉</div>}

      <div className="list-grid">
        {items.map((it) => (
          <div className="admin-list-item" key={it.item_code}>
            <div className="top">
              <b>{it.item_name || it.item_code}</b>
              <span className="badge status-on_hold">{it.affected_orders} הזמנות ממתינות</span>
            </div>
            <div className="meta">
              מק"ט {it.item_code} · סומן {fmt(it.marked_at)}
            </div>
            <button className="action-btn" disabled={busyCode === it.item_code} onClick={() => clear(it.item_code)}>
              ✓ חזר למלאי
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
