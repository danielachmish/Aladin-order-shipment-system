// קליטת Webhook מ-UPS ושיוך אוטומטי לפי אסמכתא — סעיפים 6.4, 9.3, 9.5 באפיון.
// MOCK: אין כאן חיבור אמיתי ל-UPS (אין credentials בסביבה הזו). מבנה ה-body
// והלוגיקה (פענוח ref1, קישור many-to-many, מניעת כפילות, חריגת קישור) הם אמיתיים
// ותואמים למסמך; לבדיקה ידנית ר' scripts/simulate-ups-event.js.
const crypto = require('crypto');
const { db } = require('./db');
const { emitChange } = require('./bus');
const { recordLinkException, tryCloseDelivered, linkedOrderKeys } = require('./shipmentLinking');

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

// טביעת אצבע של כל תוכן ההודעה (כל השדות, בסדר מפתחות קבוע). קודם זיהוי הכפילות
// היה לפי 6 שדות בלבד ומול כל ההיסטוריה של השטר, וזה גרם לשתי תקלות:
// (1) הודעה שהוסיפה רק receivedBy / rtsTrackNo / תיאור חדש נזרקה;
// (2) סטטוס שחוזר על עצמו (בהפצה -> חריגה -> שוב בהפצה) נזרק, והמשלוח נתקע
// על "חריגה". ר' בקשת דניאל 30.9.2026.
function contentHashFor(body) {
  const canonical = JSON.stringify(Object.keys(body).sort().map((k) => [k, body[k]]));
  return crypto.createHash('sha1').update(canonical).digest('hex');
}

function handleWebhook(body) {
  if (!body || !body.trackNo) {
    const err = new Error('חסר trackNo');
    err.status = 400;
    throw err;
  }
  // כפילות = שליחה חוזרת של אותה הודעה בדיוק, כלומר זהה להודעה האחרונה שנקלטה
  // לאותו שטר. כל הודעה אחרת — גם אם זהה להודעה ישנה יותר — היא שינוי אמיתי.
  // כל מה שקורה בהמשך בטוח גם בהרצה חוזרת (upsert, INSERT OR IGNORE, חריגה פתוחה
  // אחת לשטר, סגירה רק ממצב delivered_to_ups).
  const contentHash = contentHashFor(body);
  const last = db.prepare('SELECT content_hash FROM shipment_events WHERE track_no = ? ORDER BY rowid DESC LIMIT 1')
    .get(String(body.trackNo));
  if (last && last.content_hash === contentHash) {
    return { ok: true, deduped: true, trackNo: body.trackNo };
  }

  const normalized = normalizeStatus(body);
  const trackNo = String(body.trackNo);
  const refNums = parseRef1(body.ref1);

  const linked = [];
  const exceptions = [];

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO shipments (track_no, status, status_desc_heb, exception_code, exception_desc_heb, estimate_delivery, rts_track_no, delivered_time, received_by, ref1, ref2, service_level, updated_at)
      VALUES (@track_no, @status, @status_desc_heb, @exception_code, @exception_desc_heb, @estimate_delivery, @rts_track_no, @delivered_time, @received_by, @ref1, @ref2, @service_level, datetime('now'))
      ON CONFLICT(track_no) DO UPDATE SET
        status = excluded.status, status_desc_heb = excluded.status_desc_heb,
        exception_code = excluded.exception_code, exception_desc_heb = excluded.exception_desc_heb,
        estimate_delivery = excluded.estimate_delivery, rts_track_no = COALESCE(excluded.rts_track_no, shipments.rts_track_no),
        delivered_time = COALESCE(excluded.delivered_time, shipments.delivered_time),
        received_by = COALESCE(excluded.received_by, shipments.received_by),
        ref1 = COALESCE(excluded.ref1, shipments.ref1),
        ref2 = COALESCE(excluded.ref2, shipments.ref2),
        service_level = COALESCE(excluded.service_level, shipments.service_level),
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
      ref1: body.ref1 != null && String(body.ref1).trim() ? String(body.ref1).trim() : null,
      ref2: body.ref2 != null && String(body.ref2).trim() ? String(body.ref2).trim().replace(/,$/, '') : null,
      service_level: body.serviceLevel != null && String(body.serviceLevel).trim() ? String(body.serviceLevel).trim() : null,
    });

    // dedupe_key נשאר UNIQUE בסכמה, אז הוא מקבל מזהה ייחודי לכל אירוע; ההשוואה עצמה לפי content_hash
    const eventId = uid('sevt');
    db.prepare(`INSERT INTO shipment_events (event_id, track_no, dedupe_key, content_hash, raw_body, normalized_status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(eventId, trackNo, eventId, contentHash, JSON.stringify(body), normalized);

    for (const num of refNums) {
      const key = orderKeyFromNum(num);
      const exists = db.prepare('SELECT 1 FROM orders_cache WHERE order_key = ?').get(key);
      if (!exists) {
        recordLinkException(trackNo, num, 'מספר הזמנה לא נמצא');
        exceptions.push(num);
        continue;
      }
      db.prepare(`INSERT OR IGNORE INTO order_shipments (order_key, track_no, ref1_raw) VALUES (?, ?, ?)`).run(key, trackNo, body.ref1);
      linked.push(key);
    }

    // שום מספר הזמנה תקין באסמכתא (ריקה, או עם אותיות כמו SH54707) — קודם זה עבר
    // בשקט: המשלוח נשמר בלי הזמנה ואף אחד לא ידע. עכשיו: חריגה למנהל, אלא אם
    // המשלוח כבר קושר קודם (אוטומטית או ידנית).
    if (refNums.length === 0 && linkedOrderKeys(trackNo).length === 0) {
      const raw = body.ref1 != null ? String(body.ref1).trim() : '';
      recordLinkException(trackNo, raw, raw ? 'אין מספר הזמנה תקין באסמכתא' : 'אסמכתא ריקה — אין מספר הזמנה');
      exceptions.push(raw);
    }
  });
  tx();

  // מסירה סופית -> סגירה אוטומטית של כל ההזמנות המקושרות לשטר (סעיף 4.3) — גם כאלה
  // שקושרו קודם, למשל ידנית. מחוץ לטרנזקציה ו-best-effort: הזמנה שלא ניתן לסגור
  // (תוספת בדרך וכו') נשארת פתוחה, אבל הסטטוס של המשלוח נשמר בכל מקרה.
  if (normalized === 'ship_delivered') {
    for (const key of linkedOrderKeys(trackNo)) tryCloseDelivered(key, null);
  }

  emitChange('shipment', { track_no: trackNo, status: normalized, linked, exceptions });
  return { ok: true, trackNo, normalized, linked, exceptions };
}

module.exports = { handleWebhook, normalizeStatus, parseRef1 };
