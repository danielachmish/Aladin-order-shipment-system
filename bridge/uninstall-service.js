// מסיר את שירות ה-Windows "Aladin Sigma Bridge". להריץ עם הרשאות מנהל:
//   npm run uninstall-service
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Aladin Sigma Bridge',
  script: path.join(__dirname, 'sync.js'),
});

svc.on('uninstall', () => console.log('השירות הוסר.'));
svc.uninstall();
