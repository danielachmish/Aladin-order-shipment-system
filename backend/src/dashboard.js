// דשבורד מנהל — מדדים תפעוליים בזמן אמת, ר' סעיף 15 באפיון + החלטת דניאל
// (10.9.2026): לא רק ספירות, אלא "מה דורש החלטה עכשיו" + מדדי זמן/כסף.
const { db } = require('./db');

const ACTIVE_STATUSES = ['open', 'waiting_pick', 'picking', 'ready_to_pack', 'waiting_pickup', 'delivered_to_ups'];
const STUCK_PICKING_MINUTES = 120; // "תקועה" = בליקוט מעל שעתיים

function computeDashboard() {
  const countsRows = db.prepare(`
    SELECT status, COUNT(*) c FROM workflow_state WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) GROUP BY status
  `).all(...ACTIVE_STATUSES);
  const counts = Object.fromEntries(ACTIVE_STATUSES.map((s) => [s, 0]));
  countsRows.forEach((r) => { counts[r.status] = r.c; });

  const closedToday = db.prepare(`
    SELECT COUNT(*) c FROM workflow_events
    WHERE to_status IN ('closed','delivered_to_ups') AND date(created_at) = date('now')
  `).get().c;
  const closedYesterday = db.prepare(`
    SELECT COUNT(*) c FROM workflow_events
    WHERE to_status IN ('closed','delivered_to_ups') AND date(created_at) = date('now', '-1 day')
  `).get().c;

  // זמן ליקוט ממוצע (picking -> ready_to_pack) ב-7 הימים האחרונים
  const avgPick = db.prepare(`
    SELECT AVG((julianday(e2.created_at) - julianday(e1.created_at)) * 24 * 60) AS avg_minutes
    FROM workflow_events e1
    JOIN workflow_events e2 ON e2.order_key = e1.order_key
      AND e2.to_status = 'ready_to_pack' AND e2.created_at > e1.created_at
      AND e2.created_at = (
        SELECT MIN(e3.created_at) FROM workflow_events e3
        WHERE e3.order_key = e1.order_key AND e3.to_status = 'ready_to_pack' AND e3.created_at > e1.created_at
      )
    WHERE e1.to_status = 'picking' AND e1.created_at >= datetime('now', '-7 days')
  `).get();

  // הזמנות תקועות בליקוט מעל הסף
  const stuck = db.prepare(`
    SELECT oc.order_key, oc.order_num, oc.customer_name, ws.updated_at,
           CAST((julianday('now') - julianday(ws.updated_at)) * 24 * 60 AS INTEGER) AS minutes_in_status
    FROM workflow_state ws JOIN orders_cache oc ON oc.order_key = ws.order_key
    WHERE ws.status = 'picking' AND ws.updated_at <= datetime('now', ?)
    ORDER BY ws.updated_at ASC LIMIT 20
  `).all(`-${STUCK_PICKING_MINUTES} minutes`);

  // שווי כספי של כל ההזמנות הפעילות (בצנרת)
  const pipelineValue = db.prepare(`
    SELECT COALESCE(SUM(oc.total_amount), 0) AS total
    FROM workflow_state ws JOIN orders_cache oc ON oc.order_key = ws.order_key
    WHERE ws.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
  `).get(...ACTIVE_STATUSES).total;

  // אחוז עמידה ביעד: כניסה לתור -> נמסר/נסגר תוך 24 שעות, ב-30 הימים האחרונים
  const sla = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN (julianday(closed_at) - julianday(ws.queue_entered_at)) * 24 <= 24 THEN 1 ELSE 0 END) AS on_time
    FROM workflow_state ws
    JOIN (
      SELECT order_key, MIN(created_at) AS closed_at FROM workflow_events
      WHERE to_status IN ('closed','delivered_to_ups') GROUP BY order_key
    ) done ON done.order_key = ws.order_key
    WHERE done.closed_at >= datetime('now', '-30 days') AND ws.queue_entered_at IS NOT NULL
  `).get();
  const slaPercent = sla.total > 0 ? Math.round((sla.on_time / sla.total) * 100) : null;

  // פילוח לפי סוכן: הזמנות פעילות + ממתינות לתשובה, לפי סוכן (מ-Sigma)
  const byAgent = db.prepare(`
    SELECT COALESCE(oc.sigma_agent_name, u.display_name, 'ללא סוכן') AS agent_name,
           COUNT(*) AS active_count,
           SUM(CASE WHEN ws.status = 'waiting_answer' THEN 1 ELSE 0 END) AS waiting_answer_count
    FROM workflow_state ws
    JOIN orders_cache oc ON oc.order_key = ws.order_key
    LEFT JOIN users u ON u.user_id = ws.agent_id
    WHERE ws.status IN (${ACTIVE_STATUSES.concat(['waiting_answer']).map(() => '?').join(',')})
    GROUP BY agent_name ORDER BY active_count DESC LIMIT 15
  `).all(...ACTIVE_STATUSES, 'waiting_answer');

  const pendingUrgent = db.prepare(`SELECT COUNT(*) c FROM urgent_requests WHERE status = 'pending'`).get().c;
  const onHoldCount = db.prepare(`SELECT COUNT(*) c FROM workflow_state WHERE status = 'on_hold'`).get().c;
  const linkExceptionsCount = db.prepare(`SELECT COUNT(*) c FROM link_exceptions WHERE resolved = 0`).get().c;

  return {
    counts,
    closedToday,
    closedYesterday,
    avgPickMinutes: avgPick.avg_minutes != null ? Math.round(avgPick.avg_minutes) : null,
    stuck,
    stuckThresholdMinutes: STUCK_PICKING_MINUTES,
    pipelineValue,
    slaPercent,
    slaSampleSize: sla.total,
    byAgent,
    needsAttention: { pendingUrgent, onHoldCount, linkExceptionsCount },
  };
}

module.exports = { computeDashboard };
