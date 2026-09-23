import React, { useEffect, useRef, useState } from 'react';

// רוחב אמיתי של המיכל — הגרף מצויר בפיקסלים אמיתיים (לא מתיחה של viewBox),
// כך שהגובה נשאר קבוע וטקסט/נקודות לא מתעוותים במסך רחב
function useWidth(fallback = 600) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// גרפים קטנים לדשבורדים — SVG/CSS ידני, בלי ספריית גרפים (האפליקציה רצה
// בטלפונים במחסן, לא שווה להוסיף מאות KB בשביל כמה עמודות).
// כל גרף: סדרה אחת בצבע אחד (teal), תוויות בצבע טקסט רגיל, ריחוף/נגיעה
// מציגים ערך מדויק, וטבלה מתקפלת לקריאה בלי גרף.

export function fmtMinutes(m) {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)} דק'`;
  if (m < 48 * 60) return `${Math.round((m / 60) * 10) / 10} ש'`;
  return `${Math.round((m / 1440) * 10) / 10} ימים`;
}

// רשימת פסים אופקיים (תחנות, ספקים) — הפס מתמלא מימין בגלל RTL
export function BarList({ rows, format = (v) => v, emptyText = 'אין נתונים', tone = 'teal' }) {
  if (!rows.length) return <div className="empty-state">{emptyText}</div>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="bar-list">
      {rows.map((r) => (
        <div className="bar-list-row" key={r.label} title={`${r.label}: ${format(r.value)}`}>
          <span className="bar-list-label">{r.label}</span>
          <div className="bar-list-track">
            {r.value > 0 && <div className={`bar-list-fill ${tone}`} style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />}
          </div>
          <span className="bar-list-value">
            {format(r.value)}
            {r.alert > 0 && <span className="bar-list-alert" title="תקועות"> · ⚠ {r.alert}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// פס שלבים: עבודה (teal) מול המתנה (אפור) — מראה מיד איפה צוואר הבקבוק
export function StageBar({ segments }) {
  const shown = segments.filter((s) => s.minutes != null && s.minutes > 0);
  const total = shown.reduce((a, s) => a + s.minutes, 0);
  if (!total) return <div className="empty-state">עוד אין מספיק נתונים להיום</div>;
  return (
    <div>
      <div className="stage-bar" role="img" aria-label={shown.map((s) => `${s.label} ${fmtMinutes(s.minutes)}`).join(', ')}>
        {shown.map((s) => (
          <div key={s.key} className={`stage-seg ${s.kind}`} style={{ flexGrow: s.minutes }} title={`${s.label}: ${fmtMinutes(s.minutes)} (${s.sample} הזמנות)`}>
            {s.minutes / total > 0.12 && <span>{s.label}</span>}
          </div>
        ))}
      </div>
      <div className="stage-legend">
        {segments.map((s) => (
          <span key={s.key} className="stage-legend-item">
            <i className={`stage-dot ${s.kind}`} />{s.label}: <b>{fmtMinutes(s.minutes)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

// עמודות לאורך זמן (סדר כרונולוגי משמאל לימין, כמקובל בגרפי זמן)
export function ColumnChart({ points, valueKey, format = (v) => v, labelFor, height = 140, unitLabel }) {
  const [hover, setHover] = useState(null);
  const [ref, w] = useWidth();
  const vals = points.map((p) => p[valueKey] || 0);
  const max = Math.max(...vals, 1);
  const pad = 4, gap = Math.max(2, Math.min(8, ((w - pad * 2) / points.length) * 0.25));
  const bw = (w - pad * 2) / points.length - gap;
  const active = hover != null ? points[hover] : null;
  return (
    <div className="chart-wrap" ref={ref}>
      <div className="chart-tooltip">{active ? `${labelFor(active)} · ${format(active[valueKey] || 0)}` : unitLabel}</div>
      <svg width={w} height={height + 20} viewBox={`0 0 ${w} ${height + 20}`} className="chart-svg" onMouseLeave={() => setHover(null)}>
        <line x1={pad} x2={w - pad} y1={height} y2={height} className="chart-axis" />
        {points.map((p, i) => {
          const v = p[valueKey] || 0;
          const h = (v / max) * (height - 10);
          const x = pad + i * (bw + gap) + gap / 2;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <rect x={x - gap / 2} y={0} width={bw + gap} height={height} fill="transparent" />
              {v > 0 && <rect x={x} y={height - h} width={bw} height={h} rx={Math.min(4, bw / 2)} className={'chart-bar' + (hover === i ? ' active' : '')} />}
            </g>
          );
        })}
        <text x={0} y={height + 16} textAnchor="start" className="chart-tick">{labelFor(points[0])}</text>
        <text x={w} y={height + 16} textAnchor="end" className="chart-tick">{labelFor(points[points.length - 1])}</text>
      </svg>
      <ChartTable points={points} valueKey={valueKey} format={format} labelFor={labelFor} />
    </div>
  );
}

// קו לאורך זמן (למשל זמן מחזור) — נקודות חסרות (אין הזמנות) לא מחוברות
export function LineChart({ points, valueKey, format = (v) => v, labelFor, height = 120, unitLabel }) {
  const [hover, setHover] = useState(null);
  const [ref, w] = useWidth();
  const vals = points.map((p) => p[valueKey]).filter((v) => v != null);
  const max = Math.max(...vals, 1);
  const pad = 8;
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const xy = points.map((p, i) => (p[valueKey] == null ? null : [pad + i * step, height - (p[valueKey] / max) * (height - 12)]));
  const segments = [];
  let cur = [];
  xy.forEach((pt) => { if (pt) cur.push(pt); else if (cur.length) { segments.push(cur); cur = []; } });
  if (cur.length) segments.push(cur);
  const active = hover != null ? points[hover] : null;
  return (
    <div className="chart-wrap" ref={ref}>
      <div className="chart-tooltip">{active ? `${labelFor(active)} · ${active[valueKey] != null ? format(active[valueKey]) : 'אין הזמנות'}` : unitLabel}</div>
      <svg width={w} height={height + 20} viewBox={`0 0 ${w} ${height + 20}`} className="chart-svg" onMouseLeave={() => setHover(null)}>
        <line x1={pad} x2={w - pad} y1={height} y2={height} className="chart-axis" />
        {segments.map((seg, i) => <polyline key={i} points={seg.map((p) => p.join(',')).join(' ')} className="chart-line" />)}
        {hover != null && xy[hover] && <line x1={xy[hover][0]} x2={xy[hover][0]} y1={0} y2={height} className="chart-crosshair" />}
        {xy.map((pt, i) => pt && <circle key={i} cx={pt[0]} cy={pt[1]} r={hover === i ? 5 : 3} className="chart-dot" />)}
        {points.map((p, i) => (
          <rect key={i} x={pad + i * step - step / 2} y={0} width={Math.max(step, 12)} height={height} fill="transparent"
            onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
        ))}
        <text x={0} y={height + 16} textAnchor="start" className="chart-tick">{labelFor(points[0])}</text>
        <text x={w} y={height + 16} textAnchor="end" className="chart-tick">{labelFor(points[points.length - 1])}</text>
      </svg>
      <ChartTable points={points} valueKey={valueKey} format={format} labelFor={labelFor} />
    </div>
  );
}

function ChartTable({ points, valueKey, format, labelFor }) {
  return (
    <details className="chart-table">
      <summary>הצג כטבלה</summary>
      <table className="agent-table">
        <tbody>
          {points.map((p, i) => (
            <tr key={i}><td>{labelFor(p)}</td><td>{p[valueKey] != null ? format(p[valueKey]) : '—'}</td></tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
