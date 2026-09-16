import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';

// "החוסרים שלי" — מסך פרטי לסוכן: רק חוסרים בהזמנות שלו (לפי agent_id אמיתי,
// ר' ייעוץ 17.9.2026 נושא 6), לא של סוכנים אחרים. אפשר לעדכן לקוח שהמוצר
// חזר למלאי וליצור מולו הזמנה חדשה.
export default function MyShortages() {
  const [days, setDays] = useState(7);
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const data = await api.myShortages({ days });
      setItems(data.items);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => { if (evt.type === 'order') load(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  function shareWhatsApp(order, item, e) {
    e.stopPropagation();
    const text = `שלום, מדברים ממחסן אלדין! 🎉\nבהזמנה מספר ${order.order_num} הפריט "${item.item_name}" (מק"ט ${item.item_code}) היה חסר. שמחים לעדכן שהוא חזר למלאי!\nרוצים להזמין אותו עכשיו?`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }

  return (
    <div>
      <div className="section-title">החוסרים שלי</div>

      <div className="toggle-row">
        <span>טווח:</span>
        <div className="toggle">
          <button className={days === 1 ? 'active' : ''} onClick={() => setDays(1)}>היום</button>
          <button className={days === 7 ? 'active' : ''} onClick={() => setDays(7)}>7 ימים</button>
          <button className={days === 30 ? 'active' : ''} onClick={() => setDays(30)}>30 יום</button>
        </div>
      </div>

      {loading && <div className="empty-state">טוען...</div>}
      {!loading && items.length === 0 && <div className="empty-state">אין חוסרים בהזמנות שלכם בטווח הזה 🎉</div>}

      <div className="list-grid">
        {items.map((it) => (
          <div className="admin-list-item" key={it.item_code} onClick={() => setExpanded(expanded === it.item_code ? null : it.item_code)} style={{ cursor: 'pointer' }}>
            <div className="top">
              <b>{it.item_name}</b>
              <span className="badge status-on_hold">חסר {it.total_missing}</span>
            </div>
            <div className="meta">מק"ט {it.item_code} · ב-{it.orders.length} הזמנות שלכם</div>
            {expanded === it.item_code && (
              <div className="shortage-table-wrap">
                <table className="agent-table">
                  <thead><tr><th>הזמנה</th><th>לקוח</th><th>כמות חסרה</th><th></th></tr></thead>
                  <tbody>
                    {it.orders.map((o) => (
                      <tr key={o.order_key}>
                        <td>{o.order_num}</td>
                        <td>{o.customer_name}</td>
                        <td>{o.missing_qty}</td>
                        <td>
                          <button className="action-btn secondary" onClick={(e) => shareWhatsApp(o, it, e)}>📤 חזר למלאי — עדכון ללקוח</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
