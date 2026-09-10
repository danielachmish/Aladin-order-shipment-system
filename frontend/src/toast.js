// מנגנון הודעות צף (Toast) פשוט — pub/sub בלי ספרייה חיצונית.
let listeners = [];
let idCounter = 0;

export function onToast(cb) {
  listeners.push(cb);
  return () => { listeners = listeners.filter((l) => l !== cb); };
}

export function showToast(text) {
  const id = ++idCounter;
  listeners.forEach((l) => l({ id, text }));
}
