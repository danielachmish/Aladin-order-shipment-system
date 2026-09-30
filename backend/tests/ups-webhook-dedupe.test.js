const request = require('supertest');
const { createTestApp, seedOrder, resetDb } = require('./helpers/testApp');

// זיהוי כפילות: רק שליחה חוזרת של אותה הודעה בדיוק (מול ההודעה האחרונה של השטר) נזרקת.
describe('UPS webhook dedupe', () => {
  let app, db, cleanup, upsCfg;

  const send = (body) => request(app).post('/api/webhooks/ups').send(body);
  const shipment = (trackNo) => db.prepare('SELECT * FROM shipments WHERE track_no = ?').get(trackNo);
  const eventCount = (trackNo) => db.prepare('SELECT COUNT(*) c FROM shipment_events WHERE track_no = ?').get(trackNo).c;

  beforeAll(() => {
    ({ app, db, cleanup } = createTestApp());
    upsCfg = require('../src/config').ups;
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    resetDb(db);
    upsCfg.webhookBearerSecret = null;
    upsCfg.webhookAllowedIps = [];
    process.env.ALLOW_UNAUTHENTICATED_UPS_WEBHOOK = 'true';
    seedOrder(db, { orderKey: '3|0|54707', orderNum: 54707, status: 'delivered_to_ups' });
  });

  afterEach(() => { delete process.env.ALLOW_UNAUTHENTICATED_UPS_WEBHOOK; });

  it('ignores an exact resend of the last message', async () => {
    const body = { trackNo: 'W1', ref1: '54707', statusCode: 10, statusDescHeb: 'בהפצה' };
    await send(body);
    const res = await send({ ...body });
    expect(res.status).toBe(200);
    expect(res.body.returnCode).toBe(1);
    expect(eventCount('W1')).toBe(1);
  });

  it('applies a status that returns after an exception (out for delivery -> exception -> out for delivery)', async () => {
    const out = { trackNo: 'W2', ref1: '54707', statusCode: 10, statusDescHeb: 'בהפצה' };
    await send(out);
    await send({ trackNo: 'W2', ref1: '54707', statusCode: 8, exceptionCode: 'NH', exceptionDescHeb: 'לקוח לא בבית' });
    expect(shipment('W2').status).toBe('ship_exception');
    await send({ ...out });
    expect(shipment('W2').status).toBe('ship_out_for_delivery');
    expect(eventCount('W2')).toBe(3);
  });

  it('keeps receivedBy that arrives in a follow-up delivered message', async () => {
    const delivered = { trackNo: 'W3', ref1: '54707', statusCode: 4, deliveredTime: '2026-09-30T10:00:00', receivedBy: null };
    await send(delivered);
    await send({ ...delivered, receivedBy: 'משה' });
    expect(shipment('W3').received_by).toBe('משה');
  });

  it('keeps a return waybill that arrives later, and does not wipe it on the next message', async () => {
    await send({ trackNo: 'W4', ref1: '54707', statusCode: 7 });
    await send({ trackNo: 'W4', ref1: '54707', statusCode: 7, rtsTrackNo: 'W999' });
    await send({ trackNo: 'W4', ref1: '54707', statusCode: 7, rtsTrackNo: null, statusDescHeb: 'הוחזר לשולח' });
    expect(shipment('W4').rts_track_no).toBe('W999');
  });

  it('treats the same message for a different shipment as new', async () => {
    await send({ trackNo: 'W5', ref1: '54707', statusCode: 9 });
    await send({ trackNo: 'W6', ref1: '54707', statusCode: 9 });
    expect(eventCount('W5')).toBe(1);
    expect(eventCount('W6')).toBe(1);
  });
});
