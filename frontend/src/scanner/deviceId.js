// מזהה מכשיר יציב לכל דפדפן/טאבלט (לא לכל טאב), נשמר ב-localStorage. כמה
// עובדים חולקים בפועל אותו יוזר "מחסן" (ר' PICKING_QC_SPEC.md סעיף 2) —
// device_id הוא לפעמים סימן זהות מדויק יותר מ-user_id בהקשר הזה, ר'
// BARCODE_PICKING_ARCHITECTURE_REVIEW.md סעיף 9. לא בונה מסך ניהול מכשירים
// (WarehouseDevice) — רק שומר מזהה כדי שיהיה זמין באודיט מהיום הראשון.
const KEY = 'aladin_device_id';

export function getDeviceId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = `dev_${crypto.randomUUID()}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return null; // פרטי/localStorage חסום - לא קריטי, ה-scan עדיין עובד בלי deviceId
  }
}
