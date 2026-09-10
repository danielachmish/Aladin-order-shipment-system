import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { onLive } from '../ws.js';

const STATUS_LABELS = {
  waiting_pick: 'ממתינות לליקוט', picking: 'בליקוט', ready_to_pack: 'באריזה',
  waiting_pickup: 'ממתין לאיסוף', delivered_to_ups: 'נמסר ל-UPS',
};

function trend(today, yesterday) {
  if (yesterday === 0 && today === 0) return null;
  const diff = today - yesterday;
  if (diff === 0) return <span className="kpi-trend">ללא שינוי מאתמול</span>;
  const up = diff > 0;
  return <span className={`kpi-trend ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(diff)} מאתמול</span>;
}

export default function Dashboard({ onOpenOrder }) {
  const [d, setD] = useState(null);

  async function load() {
    try {
      const data = await api.dashboard();
      setD(data);
    } catch {
      // שקט: אם השרת עדיין לא עודכן, פשוט לא מציגים דשבורד
    }
  }

  useEffect(() => {
    load();
    const off = onLive((evt) => { if (evt.type === 'order' || evt.type === 'urgent_request') load(); });
    return off;
  }, []);

  if (!d) return null;

  const activeTotal = Object.values(d.counts).reduce((a, b) => a + b, 0);
  const attn = d.needsAttention.pendingUrgent + d.needsAttention.onHoldCount + d.needsAttention.linkExceptionsCount;

  return (
    <div>
      <div className="section-title">דשבורד</div>

      {attn > 0 && (
        <div className="admin-list-item" style={{ borderColor: '#c0392b' }}>
          <div className="top"><b style={{ color: '#c0392b' }}>דורש החלטה שלך עכשיו</b></div>
          <div className="meta">
            {d.needsAttention.pendingUrgent > 0 && <div>🔴 {d.needsAttention.pendingUrgent} בקשות דחיפות ממתינות</div>}
            {d.needsAttention.onHoldCount > 0 && <div>🔴 {d.needsAttention.onHoldCount} הזמנות מעוכבות</div>}
            {d.needsAttention.linkExceptionsCount > 0 && <div>🔴 {d.needsAttention.linkExceptionsCount} חריגות קישור UPS</div>}
          </div>
        </div>
      )}

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">הזמנות פעילות כרגע</div>
          <div className="kpi-value">{activeTotal}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">נסגרו היום</div>
          <div className="kpi-value">{d.closedToday}</div>
          {trend(d.closedToday, d.closedYesterday)}
        </div>
        <div className="kpi-card">
          <div className="kpi-label">זמן ליקוט ממוצע (7 ימים)</div>
          <div className="kpi-value">{d.avgPickMinutes != null ? `${d.avgPickMinutes} דק'` : '—'}</div>
        </div>
        <div className={'kpi-card' + (d.stuck.length > 0 ? ' alert' : '')}>
          <div className="kpi-label">תקועות בליקוט מעל {d.stuckThresholdMinutes / 60} שעות</div>
          <div className="kpi-value">{d.stuck.length}</div>
        </div>
        <div className="kpi-card wide">
          <div className="kpi-label">שווי כספי בצנרת (הזמנות פעילות)</div>
          <div className="kpi-value">₪{Math.round(d.pipelineValue).toLocaleString('he-IL')}</div>
        </div>
        <div className="kpi-card wide">
          <div className="kpi-label">עמידה ביעד — נסגר תוך 24 שעות (30 ימים, {d.slaSampleSize} הזמנות)</div>
          <div className="kpi-value">{d.slaPercent != null ? `${d.slaPercent}%` : 'אין עדיין נתונים'}</div>
        </div>
      </div>

      {d.stuck.length > 0 && (
        <>
          <div className="section-title">הזמנות תקועות בליקוט</div>
          {d.stuck.map((o) => (
            <div className="admin-list-item" key={o.order_key} onClick={() => onOpenOrder(o.order_key)} style={{ cursor: 'pointer' }}>
              <div className="top"><b>הזמנה {o.order_num}</b><span className="meta">{o.customer_name}</span></div>
              <div className="meta" style={{ color: '#c0392b' }}>{Math.round(o.minutes_in_status / 60 * 10) / 10} שעות בליקוט</div>
            </div>
          ))}
        </>
      )}

      {d.byAgent.length > 0 && (
        <>
          <div className="section-title">פילוח לפי סוכן</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="agent-table">
              <thead>
                <tr><th>סוכן</th><th>הזמנות פעילות</th><th>ממתין לתשובה</th></tr>
              </thead>
              <tbody>
                {d.byAgent.map((a) => (
                  <tr key={a.agent_name}>
                    <td>{a.agent_name}</td>
                    <td>{a.active_count}</td>
                    <td>{a.waiting_answer_count || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
