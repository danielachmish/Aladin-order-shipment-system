const request = require('supertest');
const { createTestApp, seedUser, seedOrder, loginAs, resetDb } = require('./helpers/testApp');

// סריקת ברקוד (ליקוט + בדיקה) — ר' BARCODE_SCANNING_SPEC.md. endpoint אחד
// (POST /items/scan) שמפנה פנימית לפי סטטוס ההזמנה: picking מוסיף ל-qty_picked,
// ready_for_check מוסיף ל-qty_verified. מכסה: תוצאות רגילות, over-pick,
// verify-mismatch, שורה חסרה, ברקוד לא ידוע, idempotency (client_event_id).
describe('POST /orders/:key/items/scan', () => {
  let app, db, cleanup, warehouseToken;

  beforeAll(() => { ({ app, db, cleanup } = createTestApp()); });
  afterAll(() => cleanup());

  beforeEach(async () => {
    resetDb(db);
    seedUser(db, { username: 'wh1', role: 'warehouse' });
    warehouseToken = await loginAs(request, app, 'wh1');
  });

  function insertItem(orderKey, { lineNo = 1, itemCode = 'A1', barcode = '1111111111111', quantity = 3, location = null, pickStatus = null, qtyPicked = null, checked = 0, qtyVerified = null } = {}) {
    db.prepare(`
      INSERT INTO order_items_cache
        (order_key, line_no, item_code, item_name, quantity, price, location, barcode, pick_status, qty_picked, checked, qty_verified)
      VALUES (?, ?, ?, 'פריט בדיקה', ?, 10, ?, ?, ?, ?, ?, ?)
    `).run(orderKey, lineNo, itemCode, quantity, location, barcode, pickStatus, qtyPicked, checked, qtyVerified);
  }

  function scan(orderKey, barcode, clientEventId, deviceId, quantity) {
    return request(app)
      .post(`/api/orders/${encodeURIComponent(orderKey)}/items/scan`)
      .set('Authorization', `Bearer ${warehouseToken}`)
      .send({ barcode, clientEventId, deviceId, quantity });
  }

  describe('picking stage', () => {
    it('accepts a scan and increments qty_picked by 1', async () => {
      seedOrder(db, { orderKey: '3|0|1', orderNum: 1, status: 'picking' });
      insertItem('3|0|1', { lineNo: 1, quantity: 3 });
      insertItem('3|0|1', { lineNo: 2, barcode: '2222222222222', quantity: 1 }); // שורה נוספת שלא נגעו בה, כדי שההזמנה לא תושלם מהסריקה הזו

      const res = await scan('3|0|1', '1111111111111', 'evt-1');
      expect(res.status).toBe(200);
      expect(res.body.resultCode).toBe('ACCEPTED');
      expect(res.body.item.qty_picked).toBe(1);
      expect(res.body.item.pick_status).toBe('partial');
      expect(res.body.orderProgress).toEqual({ done: 1, total: 2 }); // שורה 1 טופלה (partial), שורה 2 עוד לא נגעו בה
    });

    it('marks ITEM_COMPLETED and ORDER_COMPLETED when the last unit of the last line is scanned', async () => {
      seedOrder(db, { orderKey: '3|0|2', orderNum: 2, status: 'picking' });
      insertItem('3|0|2', { quantity: 1 });

      const res = await scan('3|0|2', '1111111111111', 'evt-1');
      expect(res.body.resultCode).toBe('ORDER_COMPLETED');
      expect(res.body.item.pick_status).toBe('picked');
      expect(res.body.orderProgress).toEqual({ done: 1, total: 1 });
    });

    it('rejects scanning beyond the ordered quantity with OVER_PICK', async () => {
      seedOrder(db, { orderKey: '3|0|3', orderNum: 3, status: 'picking' });
      insertItem('3|0|3', { quantity: 1, pickStatus: 'picked', qtyPicked: 1 });

      const res = await scan('3|0|3', '1111111111111', 'evt-1');
      expect(res.body.resultCode).toBe('OVER_PICK');
      const item = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ?').get('3|0|3');
      expect(item.qty_picked).toBe(1); // לא השתנה
    });

    it('returns NOT_IN_ORDER for a barcode that matches nothing in this order', async () => {
      seedOrder(db, { orderKey: '3|0|4', orderNum: 4, status: 'picking' });
      insertItem('3|0|4', { barcode: '2222222222222', quantity: 3 });

      const res = await scan('3|0|4', '9999999999999', 'evt-1');
      expect(res.body.resultCode).toBe('NOT_IN_ORDER');
      expect(res.body.item).toBeUndefined();
    });

    it('picks the earliest by location among lines sharing the same barcode', async () => {
      seedOrder(db, { orderKey: '3|0|5', orderNum: 5, status: 'picking' });
      insertItem('3|0|5', { lineNo: 1, location: 'B01', quantity: 1, pickStatus: 'picked', qtyPicked: 1 });
      insertItem('3|0|5', { lineNo: 2, location: 'A01', quantity: 2 });

      const res = await scan('3|0|5', '1111111111111', 'evt-1');
      expect(res.body.item.line_no).toBe(2); // A01 < B01, וגם השורה הראשונה כבר מלאה
    });

    it('is idempotent: replaying the same clientEventId does not double-count', async () => {
      seedOrder(db, { orderKey: '3|0|6', orderNum: 6, status: 'picking' });
      insertItem('3|0|6', { lineNo: 1, quantity: 5 });
      insertItem('3|0|6', { lineNo: 2, barcode: '2222222222222', quantity: 1 }); // שורה נוספת שלא נגעו בה

      const first = await scan('3|0|6', '1111111111111', 'evt-dup');
      const second = await scan('3|0|6', '1111111111111', 'evt-dup');
      expect(first.body.resultCode).toBe('ACCEPTED');
      expect(second.body.resultCode).toBe('ACCEPTED');
      expect(second.body.item.qty_picked).toBe(1); // לא 2

      const events = db.prepare('SELECT COUNT(*) c FROM scan_events WHERE order_key = ?').get('3|0|6').c;
      expect(events).toBe(1);
    });

    it('rejects a scan when the order is not in a scannable status', async () => {
      seedOrder(db, { orderKey: '3|0|7', orderNum: 7, status: 'waiting_pick' });
      insertItem('3|0|7', { quantity: 3 });

      const res = await scan('3|0|7', '1111111111111', 'evt-1');
      expect(res.body.resultCode).toBe('ORDER_NOT_SCANNABLE');
      expect(res.body.currentStatus).toBe('waiting_pick');
    });
  });

  describe('verification stage', () => {
    it('accepts a scan and increments qty_verified toward qty_picked (not the original quantity)', async () => {
      seedOrder(db, { orderKey: '3|0|10', orderNum: 10, status: 'ready_for_check' });
      insertItem('3|0|10', { quantity: 6, pickStatus: 'partial', qtyPicked: 4 });

      const res = await scan('3|0|10', '1111111111111', 'evt-1');
      expect(res.body.resultCode).toBe('ACCEPTED');
      expect(res.body.item.qty_verified).toBe(1);
      expect(res.body.item.checked).toBe(0);
    });

    it('auto-checks the line once qty_verified reaches qty_picked', async () => {
      seedOrder(db, { orderKey: '3|0|11', orderNum: 11, status: 'ready_for_check' });
      insertItem('3|0|11', { quantity: 6, pickStatus: 'partial', qtyPicked: 2, qtyVerified: 1 });

      const res = await scan('3|0|11', '1111111111111', 'evt-1');
      expect(res.body.resultCode).toBe('ORDER_COMPLETED');
      expect(res.body.item.qty_verified).toBe(2);
      expect(res.body.item.checked).toBe(1);
    });

    it('returns NOTHING_TO_VERIFY for a line marked missing', async () => {
      seedOrder(db, { orderKey: '3|0|12', orderNum: 12, status: 'ready_for_check' });
      insertItem('3|0|12', { quantity: 3, pickStatus: 'missing', qtyPicked: 0 });

      const res = await scan('3|0|12', '1111111111111', 'evt-1');
      expect(res.body.resultCode).toBe('NOTHING_TO_VERIFY');
    });

    it('returns VERIFY_MISMATCH when scanning beyond qty_picked', async () => {
      seedOrder(db, { orderKey: '3|0|13', orderNum: 13, status: 'ready_for_check' });
      insertItem('3|0|13', { quantity: 3, pickStatus: 'picked', qtyPicked: 3, qtyVerified: 3, checked: 1 });

      const res = await scan('3|0|13', '1111111111111', 'evt-1');
      expect(res.body.resultCode).toBe('VERIFY_MISMATCH');
      const item = db.prepare('SELECT * FROM order_items_cache WHERE order_key = ?').get('3|0|13');
      expect(item.qty_verified).toBe(3); // לא השתנה
    });

    it('manually clicking "✓ מאשר" (updateItemCheck) syncs qty_verified to qty_picked', async () => {
      seedOrder(db, { orderKey: '3|0|14', orderNum: 14, status: 'ready_for_check' });
      insertItem('3|0|14', { quantity: 4, pickStatus: 'picked', qtyPicked: 4 });

      const res = await request(app)
        .post('/api/orders/3%7C0%7C14/items/1/check')
        .set('Authorization', `Bearer ${warehouseToken}`)
        .send({ checked: true });
      expect(res.body.item.qty_verified).toBe(4);
    });
  });

  // "הזנת כמות" (בקשת דניאל 22.9.2026): סריקה אחת + כמות מוקלדת, לפריטים
  // בכמות גדולה — כדי לא לדרוש סריקה נפרדת לכל יחידה מתוך 1000.
  describe('bulk quantity (one scan + typed quantity)', () => {
    it('applies the full quantity in a single scan during picking', async () => {
      seedOrder(db, { orderKey: '3|0|20', orderNum: 20, status: 'picking' });
      insertItem('3|0|20', { quantity: 1000 });

      const res = await scan('3|0|20', '1111111111111', 'evt-1', null, 1000);
      expect(res.body.resultCode).toBe('ORDER_COMPLETED');
      expect(res.body.item.qty_picked).toBe(1000);
      expect(res.body.item.pick_status).toBe('picked');

      const events = db.prepare('SELECT delta_qty FROM scan_events WHERE order_key = ?').all('3|0|20');
      expect(events).toEqual([{ delta_qty: 1000 }]); // אירוע אחד, לא 1000
    });

    it('rejects a bulk quantity that exceeds the remaining amount with OVER_PICK', async () => {
      seedOrder(db, { orderKey: '3|0|21', orderNum: 21, status: 'picking' });
      insertItem('3|0|21', { quantity: 10 });

      const res = await scan('3|0|21', '1111111111111', 'evt-1', null, 11);
      expect(res.body.resultCode).toBe('OVER_PICK');
      const item = db.prepare('SELECT qty_picked FROM order_items_cache WHERE order_key = ?').get('3|0|21');
      expect(item.qty_picked).toBeNull(); // לא השתנה
    });

    it('applies a bulk quantity during verification, toward qty_picked', async () => {
      seedOrder(db, { orderKey: '3|0|22', orderNum: 22, status: 'ready_for_check' });
      insertItem('3|0|22', { quantity: 500, pickStatus: 'picked', qtyPicked: 500 });

      const res = await scan('3|0|22', '1111111111111', 'evt-1', null, 500);
      expect(res.body.resultCode).toBe('ORDER_COMPLETED');
      expect(res.body.item.qty_verified).toBe(500);
      expect(res.body.item.checked).toBe(1);
    });

    it('rejects a non-positive quantity', async () => {
      seedOrder(db, { orderKey: '3|0|23', orderNum: 23, status: 'picking' });
      insertItem('3|0|23', { quantity: 10 });

      const res = await scan('3|0|23', '1111111111111', 'evt-1', null, 0);
      expect(res.status).toBe(400);
    });

    it('is idempotent for bulk quantities too (replay does not double-apply)', async () => {
      seedOrder(db, { orderKey: '3|0|24', orderNum: 24, status: 'picking' });
      insertItem('3|0|24', { lineNo: 1, quantity: 50 });
      insertItem('3|0|24', { lineNo: 2, barcode: '2222222222222', quantity: 1 });

      const first = await scan('3|0|24', '1111111111111', 'evt-dup', null, 50);
      const second = await scan('3|0|24', '1111111111111', 'evt-dup', null, 50);
      expect(first.body.item.qty_picked).toBe(50);
      expect(second.body.item.qty_picked).toBe(50); // לא 100
    });
  });
});
