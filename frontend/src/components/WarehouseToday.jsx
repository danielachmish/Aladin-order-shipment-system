import React from 'react';
import { statusLabel } from '../labels.js';
import { BarList, StageBar, fmtMinutes } from './charts.jsx';

// "המחסן היום" — מנהל מחסן + מנהל מערכת. שמות עובדים מגיעים מהשרת רק
// למנהל מערכת (workers=null למנהל מחסן — מוצג סיכום צוות בלבד).
const STATIONS = [
  { key: 'waiting_pick', label: 'ממתין לליקוט' },
  { key: 'picking', label: 'בליקוט' },
  { key: 'waiting_check', label: 'ממתין לבדיקה' },
  { key: 'checking', label: 'בבדיקה' },
  { key: 'ready_to_pack', label: 'לאריזה' },
  { key: 'waiting_pickup', label: 'ממתין לאיסוף' },
];

function formatDay(dayKey) {
  const [, m, d] = dayKey.split('-');
  return `${Number(d)}.${Number(m)}`;
}

export default function WarehouseToday({ data: d, onOpenOrder }) {
  const due = d.dueToday;
  const stuckByStation = {};
  d.stuck.forEach((s) => { stuckByStation[s.station] = (stuckByStation[s.station] || 0) + 1; });
  const q = d.quality;
  const st = d.stageTimes;

  return (
    <div>
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">📥 נכנסו היום</div>
          <div className="kpi-value">{d.enteredToday}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">🚚 יצאו היום</div>
          <div className="kpi-value">{d.leftToday}</div>
          <div className="kpi-sub">מסירה ל-UPS או איסוף עצמי</div>
        </div>
        <div className={'kpi-card' + (q.pickAccuracy != null && q.pickAccuracy < 98 ? ' alert' : '')}>
          <div className="kpi-label">🎯 דיוק ליקוט היום</div>
          <div className="kpi-value">{q.pickAccuracy != null ? `${q.pickAccuracy}%` : '—'}</div>
          <div className="kpi-sub">{q.checkedLines ? `${q.errorLines} טעויות מתוך ${q.checkedLines} שורות שנבדקו` : 'עוד לא נבדקו הזמנות היום'}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">📷 ליקוט בסריקה</div>
          <div className="kpi-value">{q.scanShare != null ? `${q.scanShare}%` : '—'}</div>
          <div className="kpi-sub">{q.manualLines ? `${q.manualLines} שורות ידני` : ' '}</div>
        </div>
      </div>

      {/* ---- יעד היום לפי שעת הסגירה ---- */}
      <div className="settings-card">
        <div className="settings-card-title">⏰ יעד יציאה להיום (נכנסו עד {d.settings.cutoffTime})</div>
        {due.total === 0 ? (
          <div className="empty-state">אין הזמנות שצריכות לצאת היום</div>
        ) : (
          <>
            <div className="due-progress">
              <div className="due-progress-track">
                <div className="due-progress-fill" style={{ width: `${(due.left / due.total) * 100}%` }} />
              </div>
              <div className="due-progress-text"><b>{due.left}</b> מתוך {due.total} יצאו · נותרו <b>{due.remaining.length}</b></div>
            </div>
            {due.remaining.length > 0 && (
              <div className="scroll-panel" style={{ marginTop: 10 }}>
                {due.remaining.map((o) => (
                  <div className="admin-list-item" key={o.order_key} onClick={() => onOpenOrder(o.order_key)} style={{ cursor: 'pointer' }}>
                    <div className="top"><b>הזמנה {o.order_num}</b><span className={`badge status-${o.status}`}>{statusLabel(o.status)}</span></div>
                    <div className="meta">{o.customer_name}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <div className="dash-note" style={{ marginTop: 8 }}>
          הזמנות שנכנסות אחרי {d.settings.cutoffTime} נספרות ליום העבודה הבא ({formatDay(due.nextWorkday)}).
        </div>
      </div>

      {/* ---- עומס לפי תחנה ---- */}
      <div className="settings-card">
        <div className="settings-card-title">📦 עומס לפי תחנה עכשיו</div>
        <BarList rows={STATIONS.map((s) => ({ label: s.label, value: d.stations[s.key] || 0, alert: stuckByStation[s.key] || 0 }))} />
        {(d.stations.waiting_answer > 0 || d.stations.on_hold > 0) && (
          <div className="dash-note" style={{ marginTop: 8 }}>
            בנוסף: {d.stations.waiting_answer} ממתינות לתשובה · {d.stations.on_hold} מעוכבות
          </div>
        )}
        <div className="dash-note" style={{ marginTop: 4 }}>
          ⚠ = תקועות: ליקוט מעל {d.stuckThresholds.picking / 60} ש', בדיקה או אריזה מעל {d.stuckThresholds.ready_for_check / 60} ש', איסוף מעל יום
        </div>
      </div>

      {d.stuck.length > 0 && (
        <div className="settings-card">
          <div className="settings-card-title">🐢 תקועות ({d.stuck.length})</div>
          <div className="scroll-panel">
            {d.stuck.map((o) => (
              <div className="admin-list-item" key={o.order_key} onClick={() => onOpenOrder(o.order_key)} style={{ cursor: 'pointer' }}>
                <div className="top"><b>הזמנה {o.order_num}</b><span className={`badge status-${o.status}`}>{statusLabel(o.status)}</span></div>
                <div className="meta">{o.customer_name} · <span style={{ color: 'var(--red)' }}>{fmtMinutes(o.minutes_in_status)} בשלב הזה</span></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- ביצועים ---- */}
      <div className="settings-card">
        <div className="settings-card-title">👷 ביצועים היום</div>
        {d.workers ? (
          d.workers.length === 0 ? <div className="empty-state">עוד אין פעילות היום</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="agent-table">
                <thead>
                  <tr><th>עובד</th><th>ליקט</th><th>שורות/שעה</th><th>זמן ליקוט</th><th>דיוק</th><th>בדק</th><th>זמן בדיקה</th></tr>
                </thead>
                <tbody>
                  {d.workers.map((w) => (
                    <tr key={w.userId}>
                      <td>{w.name}</td>
                      <td>{w.pickedOrders || '—'}</td>
                      <td>{w.linesPerHour ?? '—'}</td>
                      <td>{w.avgPickMinutes != null ? fmtMinutes(w.avgPickMinutes) : '—'}</td>
                      <td>{w.pickAccuracy != null ? `${w.pickAccuracy}%` : '—'}</td>
                      <td>{w.checkedOrders || '—'}</td>
                      <td>{w.avgCheckMinutes != null ? fmtMinutes(w.avgCheckMinutes) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <div className="kpi-card"><div className="kpi-label">הזמנות שלוקטו</div><div className="kpi-value">{d.team.pickedOrders}</div></div>
            <div className="kpi-card"><div className="kpi-label">שורות לשעה (צוות)</div><div className="kpi-value">{d.team.linesPerHour ?? '—'}</div></div>
            <div className="kpi-card"><div className="kpi-label">הזמנות שנבדקו</div><div className="kpi-value">{d.team.checkedOrders}</div></div>
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-title">⏱️ זמן ממוצע לכל שלב (היום)</div>
        <StageBar segments={[
          { key: 'waitPick', label: 'המתנה לליקוט', kind: 'wait', minutes: st.waitPick.avgMinutes, sample: st.waitPick.sample },
          { key: 'pick', label: 'ליקוט', kind: 'work', minutes: st.pick.avgMinutes, sample: st.pick.sample },
          { key: 'waitCheck', label: 'המתנה לבדיקה', kind: 'wait', minutes: st.waitCheck.avgMinutes, sample: st.waitCheck.sample },
          { key: 'check', label: 'בדיקה', kind: 'work', minutes: st.check.avgMinutes, sample: st.check.sample },
          { key: 'pack', label: 'אריזה', kind: 'work', minutes: st.pack.avgMinutes, sample: st.pack.sample },
          { key: 'waitPickup', label: 'המתנה לאיסוף', kind: 'wait', minutes: st.waitPickup.avgMinutes, sample: st.waitPickup.sample },
        ]} />
        <div className="dash-note" style={{ marginTop: 6 }}>צבע = עבודה, אפור = המתנה. אריזה כוללת את ההמתנה לאורז.</div>
      </div>
    </div>
  );
}
