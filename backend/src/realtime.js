const { WebSocketServer } = require('ws');
const { bus } = require('./bus');

function attachRealtime(httpServer) {
  // בלי path קבוע: מאחורי ה-PHP-shim ב-Cloudways (ר' server.js, frontend/public/.htaccess)
  // בקשת ה-upgrade מגיעה כ-/api.php?_p=%2Flive ולא /api/live. השרת הזה משרת רק
  // את האפליקציה הזו, אז אין סיכון לקבל upgrade ממקור אחר.
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });

  const onChange = (evt) => {
    const msg = JSON.stringify(evt);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(msg);
    });
  };
  bus.on('change', onChange);

  return wss;
}

module.exports = { attachRealtime };
