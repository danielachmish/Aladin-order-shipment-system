const { WebSocketServer } = require('ws');
const { bus } = require('./bus');

function attachRealtime(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/api/live' });

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
