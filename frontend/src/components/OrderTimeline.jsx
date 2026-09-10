import React from 'react';

const STEPS = [
  { key: 'waiting_pick', label: 'בתור' },
  { key: 'picking', label: 'ליקוט' },
  { key: 'ready_to_pack', label: 'אריזה' },
  { key: 'waiting_pickup', label: 'ממתין לאיסוף' },
  { key: 'delivered_to_ups', label: 'נמסר ל-UPS' },
  { key: 'closed', label: 'נסגר' },
];

// מיקום כל סטטוס בציר הרגיל, גם כשההזמנה כרגע "חריגה" (on_hold/waiting_answer/
// cancelled) — משתמשים בשלב שאליו תחזור (pre_wait_status/hold) כדי להציג נכון
// איפה היא באמת בתהליך, עם סימון אדום שהיא לא רצה כרגע כסדרה.
function resolveIndex(status, preWaitStatus) {
  const effective = ['on_hold', 'waiting_answer', 'cancelled'].includes(status) ? (preWaitStatus || 'waiting_pick') : status;
  const idx = STEPS.findIndex((s) => s.key === effective);
  return idx === -1 ? 0 : idx;
}

export default function OrderTimeline({ status, preWaitStatus }) {
  const interrupted = ['on_hold', 'waiting_answer', 'cancelled'].includes(status);
  const currentIdx = resolveIndex(status, preWaitStatus);

  return (
    <div className="order-timeline">
      {STEPS.map((step, idx) => {
        let cls = '';
        if (idx < currentIdx) cls = 'done';
        else if (idx === currentIdx) cls = interrupted ? 'skipped' : 'current';
        return (
          <div className={`tl-step ${cls}`} key={step.key}>
            <div className="tl-line" />
            <div className="tl-dot">{idx < currentIdx ? '✓' : idx + 1}</div>
            <div className="tl-label">{step.label}</div>
          </div>
        );
      })}
    </div>
  );
}
