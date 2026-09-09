// תור העבודה — סעיף 5 באפיון: תור נפרד לכל תחנה, סדר = הבא בתור > דחוף מאושר > לפי שעת כניסה.
const { db } = require('./db');

const PRIORITY_RANK = { next: 0, urgent: 1, normal: 2 };

function rankRow(row) {
  return PRIORITY_RANK[row.priority] ?? 2;
}

// כל ההזמנות במצב נתון (בדרך כלל waiting_pick), ממוינות לפי כללי התור
function queueForStatus(status) {
  const rows = db.prepare(`
    SELECT ws.order_key, ws.priority, ws.queue_entered_at, ws.agent_id, oc.order_num, oc.customer_name
    FROM workflow_state ws
    JOIN orders_cache oc ON oc.order_key = ws.order_key
    WHERE ws.status = ?
  `).all(status);

  rows.sort((a, b) => {
    const pr = rankRow(a) - rankRow(b);
    if (pr !== 0) return pr;
    const ta = a.queue_entered_at || '';
    const tb = b.queue_entered_at || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.order_num - b.order_num;
  });

  return rows;
}

// מיקום ההזמנה בתור + סה"כ בתור, לתצוגת "מקום X מתוך Y"
function positionInQueue(orderKey, status) {
  const q = queueForStatus(status);
  const idx = q.findIndex((r) => r.order_key === orderKey);
  if (idx === -1) return null;
  return { position: idx + 1, total: q.length, ahead: idx };
}

module.exports = { queueForStatus, positionInQueue };
