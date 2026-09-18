import { useEffect, useRef } from 'react';

// לוכד קלט מסורק Bluetooth HID (מתנהג כמקלדת חיצונית: "מקליד" את הברקוד ואז
// Enter). לא דורש focus על שדה - מאזין ברמת window, כדי שהעובד לא יצטרך
// ללחוץ על שום דבר לפני סריקה (ר' BARCODE_SCANNING_SPEC.md סעיף 6.1).
//
// מבחין בין סריקה (תווים רצופים במרווח קטן מ-MAX_INTERVAL_MS) לבין הקלדת
// אדם (איטית בהרבה) — ואם יש focus אמיתי על שדה עריכה (למשל "כמות אחרת"/
// "הערה" הקיימים במסך), לא לוכד בכלל ונותן להקלדה הרגילה לעבוד.
const MAX_INTERVAL_MS = 50;
const MIN_BARCODE_LENGTH = 4;

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

export default function useScannerCapture(onScan, { enabled = true } = {}) {
  const bufferRef = useRef('');
  const lastTimeRef = useRef(0);
  // onScan נשמר ב-ref כדי שהאזנה ל-keydown לא תירשם/תימחק מחדש בכל render
  // (הקורא לא צריך לעטוף את onScan ב-useCallback בשביל זה).
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return undefined;

    function onKeyDown(e) {
      if (isEditableTarget(document.activeElement)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const now = Date.now();
      if (e.key === 'Enter') {
        const code = bufferRef.current;
        bufferRef.current = '';
        if (code.length >= MIN_BARCODE_LENGTH) {
          e.preventDefault();
          onScanRef.current(code);
        }
        return;
      }
      if (e.key.length !== 1) return; // מתעלמים ממקשי בקרה (Shift, Tab, חצים וכו')

      if (now - lastTimeRef.current > MAX_INTERVAL_MS) {
        bufferRef.current = ''; // מרווח גדול מדי מהתו הקודם — זו לא סריקה, buffer חדש
      }
      lastTimeRef.current = now;
      bufferRef.current += e.key;
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
