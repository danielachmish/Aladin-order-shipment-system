import React from 'react';

const STEPS_UPS = [
  { key: 'waiting_pick', label: 'בתור' },
  { key: 'picking', label: 'ליקוט' },
  { key: 'ready_to_pack', label: 'אריזה' },
  { key: 'waiting_pickup', label: 'ממתין לאיסוף' },
  { key: 'delivered_to_ups', label: 'נמסר ל-UPS' },
  { key: 'closed', label: 'נסגר' },
];

// איסוף עצמי לא עובר דרך UPS בכלל — מדלגים על שלב "נמסר ל-UPS" (עובר ישר
// מ"ממתין לאיסוף" ל"נסגר"). ר' בקשת דניאל 14.9.2026.
const STEPS_SELF_PICKUP = [
  { key: 'waiting_pick', label: 'בתור' },
  { key: 'picking', label: 'ליקוט' },
  { key: 'ready_to_pack', label: 'אריזה' },
  { key: 'waiting_pickup', label: 'ממתין לאיסוף' },
  { key: 'closed', label: 'נאסף' },
];

// מיקום כל סטטוס בציר הרגיל, גם כשההזמנה כרגע "חריגה" (on_hold/waiting_answer/
// cancelled) — משתמשים בשלב שאליו תחזור (pre_wait_status/hold) כדי להציג נכון
// איפה היא באמת בתהליך, עם סימון אדום שהיא לא רצה כרגע כסדרה.
function resolveIndex(steps, status, preWaitStatus) {
  const effective = ['on_hold', 'waiting_answer', 'cancelled'].includes(status) ? (preWaitStatus || 'waiting_pick') : status;
  const idx = steps.findIndex((s) => s.key === effective);
  return idx === -1 ? 0 : idx;
}

export default function OrderTimeline({ status, preWaitStatus, deliveryMethod }) {
  const STEPS = deliveryMethod === 'self_pickup' ? STEPS_SELF_PICKUP : STEPS_UPS;
  const interrupted = ['on_hold', 'waiting_answer', 'cancelled'].includes(status);
  const currentIdx = resolveIndex(STEPS, status, preWaitStatus);

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
