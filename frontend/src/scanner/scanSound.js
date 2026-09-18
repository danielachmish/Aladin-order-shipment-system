// צלילי חיווי לסריקה — טון מסונתז ב-Web Audio API, בלי קובץ סאונד חיצוני.
// ר' BARCODE_SCANNING_SPEC.md סעיף 6.2.
let ctx = null;
function getCtx() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
  }
  // דפדפנים חוסמים AudioContext עד אינטראקציית משתמש ראשונה - "resume" בטוח לקרוא תמיד
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function beep(freq, durationMs, when = 0) {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  osc.type = 'sine';
  gain.gain.value = 0.15;
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  const start = audioCtx.currentTime + when;
  osc.start(start);
  osc.stop(start + durationMs / 1000);
}

export function playSuccessSound() {
  beep(1200, 90);
}

export function playErrorSound() {
  beep(300, 120);
  beep(300, 120, 0.15);
}
