// ערוץ אירועים פנימי -> משודר ללקוחות ע"י realtime.js (WebSocket)
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);

function emitChange(type, payload) {
  bus.emit('change', { type, payload, ts: Date.now() });
}

module.exports = { bus, emitChange };
