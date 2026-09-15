// חיבור Realtime — סעיף 12.1 באפיון: המכשיר נרשם לשינויים, ומרענן נתונים
// לפי מזהה/סוג בלבד (לא מסתמך על תוכן ההודעה).
import { WS_BASE } from './api.js';

// תחת ה-PHP shim (ר' api.js) אין WebSocket אפשרי — PHP-FPM לא יכול להחזיק
// חיבור duplex פתוח (ר' backend/public/api.php). מוותרים על ניסיונות חיבור
// חוזרים אינסופיים ופשוט לא מתחברים; שאר האפליקציה עובדת נורמלי דרך REST,
// רק בלי רענון חי אוטומטי.
const WS_DISABLED = import.meta.env.VITE_API_PHP_SHIM === 'true';

let socket = null;
let listeners = [];
let connected = false;

export function isConnected() { return connected; }

export function onLive(cb) {
  listeners.push(cb);
  return () => { listeners = listeners.filter((l) => l !== cb); };
}

export function connectLive() {
  if (WS_DISABLED) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(WS_BASE);
  socket.onopen = () => { connected = true; listeners.forEach((l) => l({ type: '__connected' })); };
  socket.onclose = () => {
    connected = false;
    listeners.forEach((l) => l({ type: '__disconnected' }));
    setTimeout(connectLive, 2000); // בחיבור מחדש מרעננים מסך מלא (סעיף 12.1)
  };
  socket.onerror = () => { try { socket.close(); } catch {} };
  socket.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      listeners.forEach((l) => l(data));
    } catch {}
  };
}
