// מתקין את sync.js כשירות Windows ("Aladin Sigma Bridge") שרץ ברקע, עולה
// אוטומטית עם המחשב, ומתאתחל לבד אם קורס. תואם להמלצת האפיון (סעיף 7):
// "Sigma Bridge כשירות Windows".
//
// שימוש: צריך טרמינל עם הרשאות מנהל (Run as Administrator):
//   npm run install-service
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Aladin Sigma Bridge',
  description: 'קורא הזמנות מ-Sigma SQL Server המקומי ודוחף אותן לענן של אלדין.',
  script: path.join(__dirname, 'sync.js'),
});

svc.on('install', () => {
  console.log('השירות הותקן. מפעיל...');
  svc.start();
});
svc.on('start', () => console.log('השירות רץ. אפשר לבדוק ב-services.msc תחת "Aladin Sigma Bridge".'));
svc.on('alreadyinstalled', () => console.log('השירות כבר מותקן.'));

svc.install();
