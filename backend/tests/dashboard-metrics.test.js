const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// דשבורדים "המחסן היום" ו"תמונת הנהלה" — ר' backend/src/metrics.js.
// רוב הבדיקות קוראות לפונקציות ישירות עם now קבוע (רביעי 23.9.2026, 12:00
// שעון ישראל = 09:00 UTC), כדי שלא יהיו תלויות בשעה שבה הבדיקה רצה.
const NOW = new Date('2026-09-23T09:00:00Z');

function at(isoUtc) {
  return isoUtc.replace('T', ' ').replace('Z', '');
}

function ev(db, orderKey, userId, from, to, createdAtUtc, note = null) {
  db.prepare(`
    INSERT INTO workflow_events (event_id, order_key, user_id, from_status, to_status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`evt_${Math.random().toString(16).slice(2)}`, orderKey, userId, from, to, note, at(createdAtUtc));
}

function setState(db, orderKey, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE workflow_state SET ${sets} WHERE order_key = @key`).run({ ...fields, key: orderKey });
}

function item(db, orderKey, lineNo, fields) {
  const row = { item_code: `I${lineNo}`, item_name: `פריט ${lineNo}`, quantity: 1, price: 100, qty_picked: 1, pick_status: 'picked', picked_via: 'scan', ...fields };
  db.prepare(`
    INSERT INTO order_items_cache (order_key, line_no, item_code, item_name, quantity, price, qty_picked, pick_status, picked_via, corrected_by_checker)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderKey, lineNo, row.item_code, row.item_name, row.quantity, row.price, row.qty_picked, row.pick_status, row.picked_via, row.corrected_by_checker || 0);
}

// הזמנה שעברה את כל השלבים היום: נכנסה 06:00, ליקוט 06:30-06:50,
// בדיקה 07:00-07:10, אריזה 07:30, יצאה ל-UPS 08:00 (UTC)
function fullDayOrder(db, key, num, picker, checker, { skipped = false } = {}) {
  seedOrder(db, { orderKey: key, orderNum: num });
  setState(db, key, { status: 'delivered_to_ups', queue_entered_at: at('2026-09-23T06:00:00Z'), check_started_at: at('2026-09-23T07:00:00Z') });
  ev(db, key, picker, 'waiting_pick', 'picking', '2026-09-23T06:30:00Z');
  ev(db, key, picker, 'picking', 'ready_for_check', '2026-09-23T06:50:00Z');
  ev(db, key, checker, 'ready_for_check', 'ready_to_pack', '2026-09-23T07:10:00Z', skipped ? 'דילוג על שלב הבדיקה — הכל נסרק/אושר' : 'אישור בדיקה — מוכן לאריזה');
  ev(db, key, checker, 'ready_to_pack', 'waiting_pickup', '2026-09-23T07:30:00Z');
  ev(db, key, checker, 'waiting_pickup', 'delivered_to_ups', '2026-09-23T08:00:00Z');
}

describe('dashboard metrics', () => {
  let app, db, cleanup, metrics;
  let picker, checker;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
    metrics = require('../src/metrics');
  });
  afterAll(() => cleanup());

  beforeEach(() => {
    resetDb(db);
    picker = seedUser(db, { username: 'picker', role: 'warehouse', displayName: 'מלקטת' });
    checker = seedUser(db, { username: 'checker', role: 'warehouse', displayName: 'בודקת' });
  });

  describe('due day (12:00 cutoff, Sun–Thu)', () => {
    const settings = { cutoffTime: '12:00', workdays: [0, 1, 2, 3, 4] };
    // קיץ: ישראל = UTC+3
    it('an order in before 12:00 on a workday is due the same day', () => {
      expect(metrics.dueDayFor(new Date('2026-09-23T08:59:00Z'), settings)).toBe('2026-09-23');
    });
    it('an order at 12:00 or later is due the next workday', () => {
      expect(metrics.dueDayFor(new Date('2026-09-23T09:00:00Z'), settings)).toBe('2026-09-24');
    });
    it('Thursday afternoon and the weekend roll over to Sunday', () => {
      expect(metrics.dueDayFor(new Date('2026-09-24T12:00:00Z'), settings)).toBe('2026-09-27');
      expect(metrics.dueDayFor(new Date('2026-09-25T07:00:00Z'), settings)).toBe('2026-09-27');
      expect(metrics.dueDayFor(new Date('2026-09-26T07:00:00Z'), settings)).toBe('2026-09-27');
    });
    it('uses Israel winter time (UTC+2) after DST ends', () => {
      // 09:30 UTC ב-1.12 = 11:30 בישראל -> לפני הסגירה (בקיץ זה היה 12:30 — אחרי)
      expect(metrics.dueDayFor(new Date('2026-12-01T09:30:00Z'), settings)).toBe('2026-12-01');
    });
    it('Israel day boundaries are not UTC day boundaries', () => {
      // 22:30 UTC = 01:30 למחרת בישראל
      expect(metrics.ilDayKey(new Date('2026-09-22T22:30:00Z'))).toBe('2026-09-23');
      expect(metrics.ilDayStart('2026-09-23').toISOString()).toBe('2026-09-22T21:00:00.000Z');
    });
  });

  describe('warehouse today', () => {
    it('counts orders that physically left, not orders closed by the Sigma sync', () => {
      fullDayOrder(db, '3|0|1', 1, picker, checker);
      seedOrder(db, { orderKey: '3|0|2', orderNum: 2 });
      setState(db, '3|0|2', { status: 'closed', queue_entered_at: at('2026-09-23T05:00:00Z') });
      ev(db, '3|0|2', null, 'waiting_pick', 'closed', '2026-09-23T07:00:00Z', 'הוסרה מסנכרון Sigma — כבר לא בקריטריון ההזמנות הפתוחות');

      const d = metrics.computeWarehouseToday({ includeWorkerNames: true, now: NOW });
      expect(d.leftToday).toBe(1);
      expect(d.enteredToday).toBe(2);
      // הזמנה שנסגרה מסנכרון לא נחשבת ביעד היומי
      expect(d.dueToday.total).toBe(1);
      expect(d.dueToday.left).toBe(1);
    });

    it('lists what is still due today and which orders are stuck per station', () => {
      seedOrder(db, { orderKey: '3|0|3', orderNum: 3 });
      setState(db, '3|0|3', { status: 'picking', queue_entered_at: at('2026-09-23T05:00:00Z') });
      ev(db, '3|0|3', picker, 'waiting_pick', 'picking', '2026-09-23T06:00:00Z'); // 3 שעות בליקוט

      seedOrder(db, { orderKey: '3|0|4', orderNum: 4 });
      setState(db, '3|0|4', { status: 'ready_for_check', queue_entered_at: at('2026-09-23T05:00:00Z') });
      ev(db, '3|0|4', picker, 'waiting_pick', 'picking', '2026-09-23T08:00:00Z');
      ev(db, '3|0|4', picker, 'picking', 'ready_for_check', '2026-09-23T08:30:00Z'); // 30 דק' — לא תקועה

      const d = metrics.computeWarehouseToday({ includeWorkerNames: true, now: NOW });
      expect(d.stations.picking).toBe(1);
      expect(d.stations.waiting_check).toBe(1);
      expect(d.stuck.map((s) => s.order_num)).toEqual([3]);
      expect(d.stuck[0].minutes_in_status).toBe(180);
      expect(d.dueToday.remaining.map((r) => r.order_num).sort()).toEqual([3, 4]);
    });

    it('pick accuracy counts checker corrections and verify mismatches, and skips unchecked orders', () => {
      fullDayOrder(db, '3|0|5', 5, picker, checker);
      item(db, '3|0|5', 1, {});
      item(db, '3|0|5', 2, { corrected_by_checker: 1, picked_via: 'manual' });
      item(db, '3|0|5', 3, {});
      item(db, '3|0|5', 4, {});
      db.prepare(`
        INSERT INTO scan_events (event_id, client_event_id, order_key, line_no, barcode, stage, delta_qty, previous_qty, new_qty, result_code)
        VALUES ('scn_1', 'c1', '3|0|5', 3, 'b', 'verification', 0, 1, 1, 'VERIFY_MISMATCH')
      `).run();
      // הזמנה שדילגו בה על בדיקה — לא נכנסת לחישוב הדיוק
      fullDayOrder(db, '3|0|6', 6, picker, checker, { skipped: true });
      item(db, '3|0|6', 1, { corrected_by_checker: 1 });

      const d = metrics.computeWarehouseToday({ includeWorkerNames: true, now: NOW });
      expect(d.quality.checkedLines).toBe(4);
      expect(d.quality.errorLines).toBe(2);
      expect(d.quality.pickAccuracy).toBe(50);
      expect(d.quality.scanShare).toBe(80); // 4 בסריקה מתוך 5 (גם בהזמנה שדילגו בה על בדיקה)
    });

    it('computes per-worker throughput and stage times', () => {
      fullDayOrder(db, '3|0|7', 7, picker, checker);
      for (let i = 1; i <= 10; i++) item(db, '3|0|7', i, {});

      const d = metrics.computeWarehouseToday({ includeWorkerNames: true, now: NOW });
      const p = d.workers.find((w) => w.name === 'מלקטת');
      expect(p.pickedOrders).toBe(1);
      expect(p.linesPerHour).toBe(30); // 10 שורות ב-20 דקות
      expect(p.avgPickMinutes).toBe(20);
      const c = d.workers.find((w) => w.name === 'בודקת');
      expect(c.checkedOrders).toBe(1);
      expect(c.avgCheckMinutes).toBe(10);
      expect(d.stageTimes.waitPick.avgMinutes).toBe(30);
      expect(d.stageTimes.pick.avgMinutes).toBe(20);
      expect(d.stageTimes.waitCheck.avgMinutes).toBe(10);
      expect(d.stageTimes.check.avgMinutes).toBe(10);
      expect(d.stageTimes.pack.avgMinutes).toBe(20);
      expect(d.stageTimes.waitPickup.avgMinutes).toBe(30);
    });
  });

  describe('management', () => {
    it('fill rate, shortage value by supplier, and perfect orders', () => {
      db.prepare(`INSERT INTO item_suppliers (item_code, supplier_name) VALUES ('I2', 'ספק א')`).run();
      fullDayOrder(db, '3|0|8', 8, picker, checker);
      item(db, '3|0|8', 1, { price: 300 });
      item(db, '3|0|8', 2, { quantity: 2, price: 100, qty_picked: 0, pick_status: 'missing' }); // חוסר 200 ₪
      fullDayOrder(db, '3|0|9', 9, picker, checker);
      item(db, '3|0|9', 1, { price: 500 });

      const m = metrics.computeManagement({ days: 7, now: NOW });
      expect(m.current.ordersLeft).toBe(2);
      expect(m.current.shortageValue).toBe(200);
      expect(m.current.fillRate).toBe(80); // 1000 הוזמן, 200 חסר
      expect(m.shortagesBySupplier).toEqual([{ supplier_name: 'ספק א', value: 200 }]);
      expect(m.current.perfectOrderRate).toBe(50); // רק 9 מלאה
      expect(m.current.avgCycleHours).toBe(2);
    });

    it('on-time rate uses the cutoff: after 12:00 the order is due the next workday', () => {
      // נכנסה ב-22.9 ב-14:00 (אחרי הסגירה) ויצאה ב-23.9 — בזמן
      seedOrder(db, { orderKey: '3|0|10', orderNum: 10 });
      setState(db, '3|0|10', { status: 'delivered_to_ups', queue_entered_at: at('2026-09-22T11:00:00Z') });
      ev(db, '3|0|10', checker, 'waiting_pickup', 'delivered_to_ups', '2026-09-23T08:00:00Z');
      // נכנסה ב-21.9 ב-09:00 ויצאה רק ב-22.9 — באיחור
      seedOrder(db, { orderKey: '3|0|11', orderNum: 11 });
      setState(db, '3|0|11', { status: 'delivered_to_ups', queue_entered_at: at('2026-09-21T06:00:00Z') });
      ev(db, '3|0|11', checker, 'waiting_pickup', 'delivered_to_ups', '2026-09-22T08:00:00Z');
      // נכנסה היום ועוד לא יצאה — עוד לא נקבע, לא נספרת
      seedOrder(db, { orderKey: '3|0|12', orderNum: 12 });
      setState(db, '3|0|12', { status: 'waiting_pick', queue_entered_at: at('2026-09-23T06:00:00Z') });

      const m = metrics.computeManagement({ days: 7, now: NOW });
      expect(m.current.onTimeSample).toBe(2);
      expect(m.current.onTimeRate).toBe(50);
    });

    it('cost per order appears only once a monthly labor cost is set', () => {
      fullDayOrder(db, '3|0|13', 13, picker, checker);
      expect(metrics.computeManagement({ days: 30, now: NOW }).current.costPerOrder).toBeNull();
      metrics.saveMetricsSettings({ cutoffTime: '12:00', workdays: [0, 1, 2, 3, 4], monthlyLaborCost: 30440 });
      expect(metrics.computeManagement({ days: 30, now: NOW }).current.costPerOrder).toBe(30000);
    });
  });

  describe('workflow records check start and checker corrections', () => {
    it('first check action stamps check_started_at; a correction flags the line', () => {
      const workflow = require('../src/workflow');
      seedOrder(db, { orderKey: '3|0|20', orderNum: 20, status: 'picking' });
      item(db, '3|0|20', 1, { picked_via: 'manual' });
      item(db, '3|0|20', 2, { picked_via: 'manual' });
      workflow.finishPicking('3|0|20', picker);
      expect(db.prepare(`SELECT check_started_at FROM workflow_state WHERE order_key = '3|0|20'`).get().check_started_at).toBeNull();

      workflow.updateItemCheck('3|0|20', 1, checker, { checked: true });
      const st = db.prepare(`SELECT check_started_at, check_started_by FROM workflow_state WHERE order_key = '3|0|20'`).get();
      expect(st.check_started_at).not.toBeNull();
      expect(st.check_started_by).toBe(checker);

      workflow.correctPickedItem('3|0|20', 2, checker, { qtyPicked: 0, pickStatus: 'missing', checkNote: 'לא היה' });
      const rows = db.prepare(`SELECT line_no, corrected_by_checker FROM order_items_cache WHERE order_key = '3|0|20' ORDER BY line_no`).all();
      expect(rows).toEqual([{ line_no: 1, corrected_by_checker: 0 }, { line_no: 2, corrected_by_checker: 1 }]);
    });
  });

  describe('access control', () => {
    it('warehouse manager sees the warehouse view without worker names, and not the management view', async () => {
      seedUser(db, { username: 'wm', role: 'warehouse_manager' });
      const token = await loginAs(request, app, 'wm');
      const w = await request(app).get('/api/dashboard/warehouse').set('Authorization', `Bearer ${token}`);
      expect(w.status).toBe(200);
      expect(w.body.workers).toBeNull();
      expect(w.body.team).toBeDefined();
      const m = await request(app).get('/api/dashboard/management').set('Authorization', `Bearer ${token}`);
      expect(m.status).toBe(403);
      const s = await request(app).post('/api/settings/metrics').set('Authorization', `Bearer ${token}`).send({ cutoffTime: '12:00', workdays: [0] });
      expect(s.status).toBe(403);
    });

    it('system admin sees names and the management view, and can save metrics settings', async () => {
      seedUser(db, { username: 'admin', role: 'system_admin' });
      const token = await loginAs(request, app, 'admin');
      const w = await request(app).get('/api/dashboard/warehouse').set('Authorization', `Bearer ${token}`);
      expect(Array.isArray(w.body.workers)).toBe(true);
      const m = await request(app).get('/api/dashboard/management?days=90').set('Authorization', `Bearer ${token}`);
      expect(m.status).toBe(200);
      expect(m.body.days).toBe(90);
      expect(m.body.seriesBucketDays).toBe(7);

      const bad = await request(app).post('/api/settings/metrics').set('Authorization', `Bearer ${token}`).send({ cutoffTime: '25:00', workdays: [0] });
      expect(bad.status).toBe(400);
      const ok = await request(app).post('/api/settings/metrics').set('Authorization', `Bearer ${token}`)
        .send({ cutoffTime: '14:30', workdays: [0, 1, 2, 3, 4, 5], monthlyLaborCost: 25000 });
      expect(ok.status).toBe(200);
      const got = await request(app).get('/api/settings/metrics').set('Authorization', `Bearer ${token}`);
      expect(got.body).toEqual({ cutoffTime: '14:30', workdays: [0, 1, 2, 3, 4, 5], monthlyLaborCost: 25000 });
    });

    it('a plain warehouse user cannot see either dashboard', async () => {
      const token = await loginAs(request, app, 'picker');
      const w = await request(app).get('/api/dashboard/warehouse').set('Authorization', `Bearer ${token}`);
      expect(w.status).toBe(403);
    });
  });
});
