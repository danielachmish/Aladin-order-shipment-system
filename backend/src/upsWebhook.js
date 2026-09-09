// קליטת Webhook מ-UPS ושיוך אוטומטי לפי אסמכתא — סעיפים 6.4, 9.3, 9.5 באפיון.
// MOCK: אין כאן חיבור אמיתי ל-UPS (אין credentials בסביבה הזו). מבנה ה-body
// והלוגיקה (פענוח ref1, קישור many-to-many, מניעת כפילות, חריגת קישור) הם אמיתיים
// ותואמים למסמך; לבדיקה ידנית ר' scripts/simulate-ups-event.js.
const crypto = require('crypto');
const { db } = require('./db');
const { emitChange } = require('./bus');
const { closeOrder, getState } = require('./workflow');

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// מיפוי קוד Webhook -> מצב מנורמל (סעיף 4.2). קידומת ship_ כדי לא להתנגש עם סטטוסי העבודה במחסן.
const CODE_MAP = {
  9: 'ship_sorting',
  5: 'ship_to_pickup_point',
  6: 'ship_waiting_pickup',
  10: 'ship_out_for_delivery',
  4: 'ship_delivered',
  8: 'ship_exception',
  7: 'ship_returned',
};

function normalizeStatus(body) {
  if (body.rtsTrackNo) return 'ship_returned';
  const code = Number(body.statusCode);
  if (CODE_MAP[code]) return CODE_MAP[code];
  if (body.exceptionCode) return 'ship_exception';
  return 'ship_unmapped';
}

function parseRef1(ref1) {
  if (!ref1) return [];
  const raw = String(ref1).split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const nums = [];
  for (const r of raw) {
    if (!/^\d+$/.test(r)) continue; // "דורש ספרות בלבד" (סעיף 9.5.2)
    if (seen.has(r)) continue; // "מסיר מספר כפול"
    seen.add(r);
    nums.push(r);
  }
  return nums;
}

function orderKeyFromNum(num, companyId = 3, sidra = 0) {
  return `${companyId}|${sidra}|${num}`;
}

function dedupeKeyFor(body) {
  const digest = crypto.createHash('sha1')
    .update(JSON.stringify({
      trackNo: body.trackNo, statusCode: body.statusCode, exceptionCode: body.exceptionCode,
      ref1: body.ref1, estimateDelivery: body.estimateDelivery, deliveredTime: body.deliveredTime,
    }))
    .digest('hex');
  return digest;
}

function handleWebhook(body) {
  if (!body || !body.trackNo) {
    const err = new Error('חסר trackNo');
    err.status = 400;
    throw err;
  }
  const dedupeKey = dedupeKeyFor(body);
  const existing = db.prepare('SELECT 1 FROM shipment_events WHERE dedupe_key = ?').get(dedupeKey);
  if (existing) {
    return { ok: true, deduped: true, trackNo: body.trackNo };
  }

  const normalized = normalizeStatus(body);
  const trackNo = String(body.trackNo);
  const refNums = parseRef1(body.ref1);

  const linked = [];
  const exceptions = [];

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO shipments (track_no, status, status_desc_heb, exception_code, exception_desc_heb, estimate_delivery, rts_track_no, delivered_time, received_by, updated_at)
      VALUES (@track_no, @status, @status_desc_heb, @exception_code, @exception_desc_heb, @estimate_delivery, @rts_track_no, @delivered_time, @received_by, datetime('now'))
      ON CONFLICT(track_no) DO UPDATE SET
        status = excluded.status, status_desc_heb = excluded.status_desc_heb,
        exception_code = excluded.exception_code, exception_desc_heb = excluded.exception_desc_heb,
        estimate_delivery = excluded.estimate_delivery, rts_track_no = excluded.rts_track_no,
        delivered_time = COALESCE(excluded.delivered_time, shipments.delivered_time),
        received_by = COALESCE(excluded.received_by, shipments.received_by),
        updated_at = datetime('now')
    `).run({
      track_no: trackNo,
      status: normalized,
      status_desc_heb: body.statusDescHeb || null,
      exception_code: body.exceptionCode || null,
      exception_desc_heb: body.exceptionDescHeb || null,
      estimate_delivery: body.estimateDelivery || null,
      rts_track_no: body.rtsTrackNo || null,
      delivered_time: body.deliveredTime || null,
      received_by: body.receivedBy || null,
    });

    db.prepare(`INSERT INTO shipment_events (event_id, track_no, dedupe_key, raw_body, normalized_status) VALUES (?, ?, ?, ?, ?)`)
      .run(uid('sevt'), trackNo, dedupeKey, JSON.stringify(body), normalized);

    for (const num of refNums) {
      const key = orderKeyFromNum(num);
      const exists = db.prepare('SELECT 1 FROM orders_cache WHERE order_key = ?').get(key);
      if (!exists) {
        const excId = uid('lexc');
        db.prepare(`INSERT INTO link_exceptions (exception_id, track_no, bad_ref, reason) VALUES (?, ?, ?, ?)`)
          .run(excId, trackNo, num, 'מספר הזמנה לא נמצא');
        exceptions.push(num);
        continue;
      }
      db.prepare(`INSERT OR IGNORE INTO order_shipments (order_key, track_no, ref1_raw) VALUES (?, ?, ?)`).run(key, trackNo, body.ref1);
      linked.push(key);
    }

    // מסירה סופית -> סגירה אוטומטית אם ההזמנה במצב נמסרה ל-UPS (סעיף 4.3)
    if (normalized === 'ship_delivered') {
      for (const key of linked) {
        const st = getState(key);
        if (st && st.status === 'delivered_to_ups') {
          closeOrder(key, null);
        }
      }
    }
  });
  tx();

  emitChange('shipment', { track_no: trackNo, status: normalized, linked, exceptions });
  return { ok: true, trackNo, normalized, linked, exceptions };
}

module.exports = { handleWebhook, normalizeStatus, parseRef1 };
