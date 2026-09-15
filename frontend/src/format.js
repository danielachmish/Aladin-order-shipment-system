// פונקציות עיצוב "בטוחות" — לעולם לא מחזירות Invalid Date / NaN / undefined
// לתצוגה למשתמש. שינוי תצוגה בלבד — לא נוגע בנתונים או בלוגיקה עסקית.
// ר' בקשת "Responsive UX Refactor" (14.9.2026).

// תאריכים שמגיעים מהשרת בשני פורמטים: ISO מלא עם Z (משדות שמקורם בסיגמא),
// או "YYYY-MM-DD HH:MM:SS" בלי אזור זמן (מ-SQLite datetime('now'), UTC בפועל
// אבל בלי Z — אם קוראים לזה new Date() ישירות, הדפדפן מפרש כשעון מקומי וזה
// גורם להפרש שעות. מנרמלים לפני היצירה כדי שתמיד יתפרש נכון כ-UTC.
function toDate(value) {
  if (!value) return null;
  const raw = value instanceof Date ? value : new Date(
    typeof value === 'string' && !value.includes('T') && !value.endsWith('Z')
      ? value.replace(' ', 'T') + 'Z'
      : value
  );
  return isNaN(raw.getTime()) ? null : raw;
}

export function formatDateSafe(value, opts) {
  const d = toDate(value);
  return d ? d.toLocaleString('he-IL', opts) : '—';
}

export function formatDurationSafe(startValue, endValue) {
  const start = toDate(startValue);
  const end = toDate(endValue);
  if (!start || !end) return '—';
  const ms = end - start;
  if (ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} דק'`;
  return `${Math.floor(mins / 60)} שע' ${mins % 60} דק'`;
}

export function formatAgeSafe(value) {
  const d = toDate(value);
  if (!d) return '';
  const ms = Date.now() - d.getTime();
  if (ms < 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} דק'`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} שע'`;
  return `${Math.floor(hours / 24)} ימים`;
}

export function formatCurrencySafe(value) {
  const n = Number(value);
  if (value == null || value === '' || !isFinite(n)) return '—';
  return `₪${Math.round(n).toLocaleString('he-IL')}`;
}
