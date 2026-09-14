import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';

// "חוסרי מלאי" — תצוגה מרוכזת לפי מק"ט למנהל מחסן, לא לפי הזמנה (זה תפקידו
// של דוח החוסרים למזכירה ב"היסטוריה"). המטרה כאן: לדעת מה חסר במלאי בפועל
// כדי להזמין/לטפל מול ספק. ר' PICKING_QC_SPEC.md סעיף 12 (בקשת דניאל 14.9.2026).
export default function InventoryShortages() {
  const [days, setDays] = useState(1);
  const [items, setItems] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const data = await api.inventoryShortages({ days });
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

  // שיתוף בווצאפ — בקשת דניאל 14.9.2026: "לתת ללקוחות שירות פרימיום" כשמוצר
  // שחסר להם חוזר למלאי. אין לנו טלפון של הלקוח שמור במערכת, אז פותחים את
  // wa.me עם הודעה מוכנה מראש והסוכן בוחר בעצמו למי לשלוח (WhatsApp Web/אפליקציה).
  function shareWhatsApp(order, e) {
    e.stopPropagation();
    const text = `שלום, מדברים ממחסן אלדין 🙏\nבהזמנה מספר ${order.order_num} התגלה שהפריט "${order.item_name}" (מק"ט ${order.item_code}) חסר כרגע במלאי.\nמתנצלים על אי הנוחות — נעדכן אתכם ברגע שהוא יחזור.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }

  return (
    <div>
      <div className="section-title">חוסרי מלאי</div>

      <div className="toggle-row">
        <span>טווח:</span>
        <div className="toggle">
          <button className={days === 1 ? 'active' : ''} onClick={() => setDays(1)}>היום</button>
          <button className={days === 7 ? 'active' : ''} onClick={() => setDays(7)}>7 ימים</button>
          <button className={days === 30 ? 'active' : ''} onClick={() => setDays(30)}>30 יום</button>
        </div>
      </div>

      {loading && <div className="empty-state">טוען...</div>}
      {!loading && items.length === 0 && <div className="empty-state">אין חוסרי מלאי בטווח הזה 🎉</div>}

      <div className="list-grid">
        {items.map((it) => (
          <div className="admin-list-item" key={it.item_code} onClick={() => setExpanded(expanded === it.item_code ? null : it.item_code)} style={{ cursor: 'pointer' }}>
            <div className="top">
              <b>{it.item_name}</b>
              <span className="badge status-on_hold">חסר {it.total_missing}</span>
            </div>
            <div className="meta">מק"ט {it.item_code} · ב-{it.orders.length} הזמנות</div>
            {expanded === it.item_code && (
              <div className="shortage-table-wrap">
                <table className="agent-table">
                  <thead><tr><th>הזמנה</th><th>לקוח</th><th>סוכן</th><th>כמות חסרה</th><th></th></tr></thead>
                  <tbody>
                    {it.orders.map((o) => (
                      <tr key={o.order_key}>
                        <td>{o.order_num}</td>
                        <td>{o.customer_name}</td>
                        <td>{o.agent_name || '—'}</td>
                        <td>{o.missing_qty}</td>
                        <td>
                          <button className="action-btn secondary" onClick={(e) => shareWhatsApp(o, e)}>📤 עדכון ללקוח</button>
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
