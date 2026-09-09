// Service worker מינימלי: מאפשר התקנה כ-PWA. אין caching אגרסיבי (סעיף 1.2 -
// עבודה מלאה ללא אינטרנט אינה נדרשת בגרסה הראשונה).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
