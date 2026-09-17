import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';

// "חוסרי מלאי" — תצוגה מרוכזת לפי מק"ט למנהל מחסן, לא לפי הזמנה (זה תפקידו
// של דוח החוסרים למזכירה ב"היסטוריה"). המטרה כאן: לדעת מה חסר במלאי בפועל
// כדי להזמין/לטפל מול ספק. ר' PICKING_QC_SPEC.md סעיף 12 (בקשת דניאל 14.9.2026).
export default function InventoryShortages() {
  const [days, setDays] = useState(1);
  const [view, setView] = useState('item'); // 'item' | 'supplier' — לרכש (ר' ייעוץ 16.9.2026)
  const [items, setItems] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      if (view === 'supplier') {
        const data = await api.inventoryShortagesBySupplier({ days });
        setSuppliers(data.suppliers);
      } else {
        const data = await api.inventoryShortages({ days });
        setItems(data.items);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => { if (evt.type === 'order' || evt.type === '__connected') load(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, view]);

  // שיתוף בווצאפ — בקשת דניאל 14.9.2026: "לתת ללקוחות שירות פרימיום" כשמוצר
  // שחסר להם חוזר למלאי. אין לנו טלפון של הלקוח שמור במערכת, אז פותחים את
  // wa.me עם הודעה מוכנה מראש והסוכן בוחר בעצמו למי לשלוח (WhatsApp Web/אפליקציה).
  function shareWhatsApp(order, e) {
    e.stopPropagation();
    const text = `שלום, מדברים ממחסן אלדין! 🎉\nבהזמנה מספר ${order.order_num} הפריט "${order.item_name}" (מק"ט ${order.item_code}) היה חסר. זכרנו שחיכיתם לו, ושמחים לעדכן שהוא חזר למלאי!\nאם תרצו להזמין אותו, אתם מוזמנים לפנות לסוכן שלכם.`;
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

      <div className="toggle-row">
        <span>תצוגה:</span>
        <div className="toggle">
          <button className={view === 'item' ? 'active' : ''} onClick={() => setView('item')}>לפי מוצר</button>
          <button className={view === 'supplier' ? 'active' : ''} onClick={() => setView('supplier')}>לפי ספק</button>
        </div>
      </div>

      {loading && <div className="empty-state">טוען...</div>}

      {view === 'supplier' ? (
        <>
          {!loading && suppliers.length === 0 && <div className="empty-state">אין חוסרי מלאי בטווח הזה 🎉</div>}
          <div className="list-grid">
            {suppliers.map((s) => (
              <div className="admin-list-item" key={s.supplier_id ?? 'unknown'}>
                <div className="top">
                  <b>{s.supplier_name}</b>
                  <span className="badge status-on_hold">{s.items.length} מוצרים</span>
                </div>
                <table className="agent-table">
                  <thead><tr><th>מק"ט</th><th>שם</th><th>כמות חסרה</th></tr></thead>
                  <tbody>
                    {s.items.map((it) => (
                      <tr key={it.item_code}>
                        <td>{it.item_code}</td>
                        <td>{it.item_name}</td>
                        <td>{it.total_missing}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      ) : (
      <>
      {!loading && items.length === 0 && <div className="empty-state">אין חוסרי מלאי בטווח הזה 🎉</div>}

      <div className="list-grid">
        {items.map((it) => (
          <div className="admin-list-item" key={it.item_code} onClick={() => setExpanded(expanded === it.item_code ? null : it.item_code)} style={{ cursor: 'pointer' }}>
            <div className="top">
              <b>{it.item_name}</b>
              <span className="badge status-on_hold">חסר {it.total_missing}</span>
            </div>
            <div className="meta">
              מק"ט {it.item_code} · ב-{it.orders.length} הזמנות
              {it.supplier_name && <> · ספק: {it.supplier_name}</>}
            </div>
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
                          <button className="action-btn secondary" onClick={(e) => shareWhatsApp(o, e)}>📤 חזר למלאי — עדכון ללקוח</button>
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
      </>
      )}
    </div>
  );
}
