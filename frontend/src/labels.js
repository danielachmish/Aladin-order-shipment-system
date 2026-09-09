// תרגומי סטטוסים לעברית לפי סעיפים 4.1 ו-4.2 באפיון
export const STATUS_LABELS = {
  open: 'פתוחה',
  waiting_pick: 'ממתינה לליקוט',
  picking: 'בליקוט',
  ready_to_pack: 'מוכנה לאריזה',
  waiting_pickup: 'ממתינה לאיסוף',
  delivered_to_ups: 'נמסרה ל-UPS',
  closed: 'נסגרה',
  on_hold: 'מעוכבת',
  cancelled: 'בוטלה',
  waiting_answer: 'ממתינה לתשובת לקוח/סוכן',
};

export const SHIP_STATUS_LABELS = {
  ship_not_linked: 'לא שויך שטר מטען',
  ship_linked: 'שויך וממתין לעדכון',
  ship_sorting: 'במרכז מיון',
  ship_in_transit: 'בדרך',
  ship_out_for_delivery: 'יצא למסירה',
  ship_to_pickup_point: 'בדרך לנקודת מסירה',
  ship_waiting_pickup: 'ממתין בנקודת מסירה',
  ship_delivered: 'נמסר',
  ship_exception: 'חריגה',
  ship_returned: 'הוחזר לשולח',
  ship_unmapped: 'מצב לא ממופה',
};

export const PRIORITY_LABELS = {
  normal: 'רגילה',
  urgent: 'דחופה',
  next: 'הבאה בתור',
};

export const ROLE_LABELS = {
  agent: 'סוכן',
  warehouse: 'מחסן',
  warehouse_manager: 'מנהל מחסן',
  system_admin: 'מנהל מערכת',
};

export function statusLabel(s) { return STATUS_LABELS[s] || s; }
export function shipLabel(s) { return SHIP_STATUS_LABELS[s] || s; }
export function priorityLabel(p) { return PRIORITY_LABELS[p] || p; }
export function roleLabel(r) { return ROLE_LABELS[r] || r; }
