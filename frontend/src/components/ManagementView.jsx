import React from 'react';
import { formatCurrencySafe } from '../format.js';
import { BarList, ColumnChart, LineChart, StageBar, fmtMinutes } from './charts.jsx';

// "תמונת הנהלה" — מנהל מערכת בלבד. כל כרטיס מושווה לתקופה הקודמת באותו
// אורך. higherIsBetter קובע אם עלייה צובעת בירוק או באדום.
function Delta({ cur, prev, higherIsBetter = true, unit = '', digits = 1 }) {
  if (cur == null || prev == null) return <div className="kpi-sub">אין השוואה לתקופה קודמת</div>;
  const diff = Math.round((cur - prev) * 10 ** digits) / 10 ** digits;
  if (diff === 0) return <div className="kpi-sub">ללא שינוי מהתקופה הקודמת</div>;
  const good = higherIsBetter ? diff > 0 : diff < 0;
  return (
    <div className={`kpi-trend ${good ? 'up' : 'down'}`}>
      {diff > 0 ? '▲' : '▼'} {Math.abs(diff).toLocaleString('he-IL')}{unit} מהתקופה הקודמת
    </div>
  );
}

function dayLabel(dayKey) {
  const [, m, d] = dayKey.split('-');
  return `${Number(d)}.${Number(m)}`;
}

export default function ManagementView({ data: m, days, onChangeDays }) {
  const c = m.current, p = m.previous;
  const bucketLabel = (pt) => (m.seriesBucketDays > 1 ? `שבוע מ-${dayLabel(pt.from)}` : dayLabel(pt.from));
  const st = m.stageTimes;

  return (
    <div>
      <div className="period-toggle toggle">
        {[7, 30, 90].map((n) => (
          <button key={n} className={days === n ? 'active' : ''} onClick={() => onChangeDays(n)}>{n} ימים</button>
        ))}
      </div>
      <div className="dash-note" style={{ marginBottom: 10 }}>{dayLabel(m.from)}–{dayLabel(m.to)} · מושווה ל-{days} הימים שלפני</div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">📦 Fill rate — כמה מההזמנות סופק</div>
          <div className="kpi-value">{c.fillRate != null ? `${c.fillRate}%` : '—'}</div>
          <Delta cur={c.fillRate} prev={p.fillRate} unit="%" />
        </div>
        <div className={'kpi-card' + (c.shortageValue > 0 ? ' alert' : '')}>
          <div className="kpi-label">💸 שווי חוסרים — מכירות שלא יצאו</div>
          <div className="kpi-value">{formatCurrencySafe(c.shortageValue)}</div>
          <Delta cur={c.shortageValue} prev={p.shortageValue} higherIsBetter={false} digits={0} />
        </div>
        <div className="kpi-card">
          <div className="kpi-label">✨ הזמנה מושלמת</div>
          <div className="kpi-value">{c.perfectOrderRate != null ? `${c.perfectOrderRate}%` : '—'}</div>
          <div className="kpi-sub">מלאה, בלי תיקון בבדיקה, תוך 24 ש'</div>
          <Delta cur={c.perfectOrderRate} prev={p.perfectOrderRate} unit="%" />
        </div>
        <div className="kpi-card">
          <div className="kpi-label">⏰ יצאו בזמן (סגירה {m.settings.cutoffTime})</div>
          <div className="kpi-value">{c.onTimeRate != null ? `${c.onTimeRate}%` : '—'}</div>
          <div className="kpi-sub">{c.onTimeSample} הזמנות עם יעד בתקופה</div>
          <Delta cur={c.onTimeRate} prev={p.onTimeRate} unit="%" />
        </div>
        <div className="kpi-card">
          <div className="kpi-label">🔁 זמן מחזור ממוצע</div>
          <div className="kpi-value">{c.avgCycleHours != null ? `${c.avgCycleHours} ש'` : '—'}</div>
          <div className="kpi-sub">מכניסה לתור ועד יציאה</div>
          <Delta cur={c.avgCycleHours} prev={p.avgCycleHours} higherIsBetter={false} unit=" ש'" />
        </div>
        <div className="kpi-card">
          <div className="kpi-label">🚚 הזמנות שיצאו</div>
          <div className="kpi-value">{c.ordersLeft}</div>
          <Delta cur={c.ordersLeft} prev={p.ordersLeft} digits={0} />
        </div>
        <div className="kpi-card">
          <div className="kpi-label">🎯 דיוק ליקוט</div>
          <div className="kpi-value">{c.quality.pickAccuracy != null ? `${c.quality.pickAccuracy}%` : '—'}</div>
          <Delta cur={c.quality.pickAccuracy} prev={p.quality.pickAccuracy} unit="%" />
        </div>
        <div className="kpi-card">
          <div className="kpi-label">💰 עלות עבודה להזמנה</div>
          {m.settings.laborCostConfigured ? (
            <>
              <div className="kpi-value">{c.costPerOrder != null ? formatCurrencySafe(c.costPerOrder) : '—'}</div>
              <Delta cur={c.costPerOrder} prev={p.costPerOrder} higherIsBetter={false} digits={0} />
            </>
          ) : (
            <div className="kpi-sub" style={{ marginTop: 6 }}>הגדירו עלות עבודה חודשית בכלי ניהול → הגדרות מדידה</div>
          )}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-title">📈 הזמנות שיצאו ({m.seriesBucketDays > 1 ? 'לפי שבוע' : 'לפי יום'})</div>
        <ColumnChart points={m.series} valueKey="orders" labelFor={bucketLabel} format={(v) => `${v} הזמנות`} unitLabel="לחצו על עמודה לפרטים" />
      </div>

      <div className="settings-card">
        <div className="settings-card-title">🔁 זמן מחזור ממוצע ({m.seriesBucketDays > 1 ? 'לפי שבוע' : 'לפי יום'})</div>
        <LineChart points={m.series} valueKey="avgCycleHours" labelFor={bucketLabel} format={(v) => `${v} שעות`} unitLabel="ירידה = שיפור" />
      </div>

      <div className="settings-card">
        <div className="settings-card-title">💸 חוסרים לפי ספק</div>
        <BarList tone="red" rows={m.shortagesBySupplier.map((s) => ({ label: s.supplier_name, value: s.value }))} format={formatCurrencySafe} emptyText="אין חוסרים בתקופה 🎉" />
        {m.topShortItems.length > 0 && (
          <details className="chart-table" style={{ marginTop: 10 }}>
            <summary>המוצרים שחסרו הכי הרבה</summary>
            <table className="agent-table">
              <thead><tr><th>מוצר</th><th>ספק</th><th>הזמנות</th><th>שווי</th></tr></thead>
              <tbody>
                {m.topShortItems.map((it) => (
                  <tr key={it.item_code || it.item_name}>
                    <td>{it.item_name || it.item_code}</td><td>{it.supplier_name || '—'}</td><td>{it.orders}</td><td>{formatCurrencySafe(it.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-title">👤 לפי סוכן</div>
        {m.byAgent.length === 0 ? <div className="empty-state">אין נתונים</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="agent-table">
              <thead><tr><th>סוכן</th><th>יצאו</th><th>שווי</th><th>Fill rate</th><th>פעילות</th><th>ממתין לתשובה</th><th>דחיפויות</th></tr></thead>
              <tbody>
                {m.byAgent.map((a) => (
                  <tr key={a.agent_name}>
                    <td>{a.agent_name}</td><td>{a.ordersLeft}</td><td>{formatCurrencySafe(a.value)}</td>
                    <td>{a.fillRate != null ? `${a.fillRate}%` : '—'}</td><td>{a.active}</td><td>{a.waitingAnswer}</td><td>{a.urgentRequests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-title">👷 עובדים בתקופה</div>
        {m.workers.length === 0 ? <div className="empty-state">אין נתונים</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="agent-table">
              <thead><tr><th>עובד</th><th>ליקט</th><th>שורות/שעה</th><th>זמן ליקוט</th><th>דיוק</th><th>בדק</th><th>זמן בדיקה</th></tr></thead>
              <tbody>
                {m.workers.map((w) => (
                  <tr key={w.userId}>
                    <td>{w.name}</td><td>{w.pickedOrders || '—'}</td><td>{w.linesPerHour ?? '—'}</td>
                    <td>{w.avgPickMinutes != null ? fmtMinutes(w.avgPickMinutes) : '—'}</td>
                    <td>{w.pickAccuracy != null ? `${w.pickAccuracy}%` : '—'}</td>
                    <td>{w.checkedOrders || '—'}</td><td>{w.avgCheckMinutes != null ? fmtMinutes(w.avgCheckMinutes) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-title">⏱️ זמן ממוצע לכל שלב</div>
        <StageBar segments={[
          { key: 'waitPick', label: 'המתנה לליקוט', kind: 'wait', minutes: st.waitPick.avgMinutes, sample: st.waitPick.sample },
          { key: 'pick', label: 'ליקוט', kind: 'work', minutes: st.pick.avgMinutes, sample: st.pick.sample },
          { key: 'waitCheck', label: 'המתנה לבדיקה', kind: 'wait', minutes: st.waitCheck.avgMinutes, sample: st.waitCheck.sample },
          { key: 'check', label: 'בדיקה', kind: 'work', minutes: st.check.avgMinutes, sample: st.check.sample },
          { key: 'pack', label: 'אריזה', kind: 'work', minutes: st.pack.avgMinutes, sample: st.pack.sample },
          { key: 'waitPickup', label: 'המתנה לאיסוף', kind: 'wait', minutes: st.waitPickup.avgMinutes, sample: st.waitPickup.sample },
        ]} />
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">📮 UPS: ממסירה עד הלקוח</div>
          <div className="kpi-value">{m.ups.avgTransitDays != null ? `${m.ups.avgTransitDays} ימים` : '—'}</div>
          <div className="kpi-sub">{m.ups.transitSample} משלוחים שנמסרו</div>
        </div>
        <div className={'kpi-card' + (m.ups.exceptionRate > 5 ? ' alert' : '')}>
          <div className="kpi-label">⚠️ UPS: משלוחים עם תקלה</div>
          <div className="kpi-value">{m.ups.exceptionRate != null ? `${m.ups.exceptionRate}%` : '—'}</div>
          <div className="kpi-sub">מתוך {m.ups.shipments} משלוחים</div>
        </div>
        <div className="kpi-card wide">
          <div className="kpi-label">💰 שווי בצנרת עכשיו (הזמנות פעילות)</div>
          <div className="kpi-value">{formatCurrencySafe(m.pipelineValue)}</div>
        </div>
      </div>
    </div>
  );
}
