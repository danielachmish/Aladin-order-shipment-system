// סקריפט לדימוי אירוע Webhook מ-UPS, לצורך בדיקה ידנית (MOCK, ר' upsWebhook.js).
// שימוש:
//   node scripts/simulate-ups-event.js 54707              -> טרק חדש להזמנה אחת
//   node scripts/simulate-ups-event.js 54707,54712         -> טרק אחד לשתי הזמנות
//   node scripts/simulate-ups-event.js 54707 8              -> קוד חריגה
//   node scripts/simulate-ups-event.js 54707 4              -> מסירה סופית

const ref1 = process.argv[2] || '54707';
const code = process.argv[3] || '9';
const trackNo = process.argv[4] || `1Z${Date.now()}`;

const codeDesc = {
  9: 'במרכז מיון', 5: 'בדרך לנקודת מסירה', 6: 'ממתין בנקודת מסירה',
  10: 'יצא למסירה', 4: 'נמסר', 8: 'חריגה', 7: 'הוחזר לשולח',
};

const body = {
  trackNo,
  ref1,
  ref2: '',
  serviceLevel: '31',
  statusCode: code,
  statusDescHeb: codeDesc[code] || 'לא ידוע',
  ...(code === '8' ? { exceptionCode: 'EX1', exceptionDescHeb: 'כתובת לא נמצאה' } : {}),
  ...(code === '4' ? { deliveredTime: new Date().toISOString(), receivedBy: 'מקבל בדוגמה' } : {}),
  estimateDelivery: new Date(Date.now() + 86400000).toISOString(),
};

fetch('http://localhost:4310/api/webhooks/ups', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
  .then((r) => r.json())
  .then((data) => {
    console.log('נשלח:', body);
    console.log('תגובת השרת:', data);
  })
  .catch((e) => console.error('שגיאה:', e.message));
