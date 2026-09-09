# אלדין – מערכת ניהול הזמנות ומשלוחים

מימוש MVP מלא של `Aladin_Order_and_Shipment_System_Specification_HE` (גרסה 1.2),
כולל תפקיד סוכן, תור עדיפויות/דחיפות, וסטטוס "ממתינה לתשובת לקוח/סוכן".

ר' [PLAN.md](PLAN.md) לתוכנית העבודה המלאה וסטטוס כל שלב.

## מה זה כולל בפועל (לא רק תיאור)

- **Backend** (Node/Express + SQLite + WebSocket): כל מנוע הסטטוסים, התור, בקשות
  דחיפות, קליטת Webhook מ-UPS עם קישור אוטומטי לפי אסמכתא, הרשאות לפי תפקיד.
- **Frontend** (React + Vite, PWA): כניסה, מסך הזמנות ותור עם עדכון חי, מסך פרטי
  הזמנה עם כפתור פעולה לפי שלב, מסך חריגות, מסך ניהול (מתג תצוגת סוכנים + אישור
  דחיפות).
- **נבדק בפועל מקצה לקצה** מול תרחיש הזמנה 54707 מסעיף 16.1 באפיון: claim אטומי
  שמונע התחלה כפולה, webhook עם אסמכתא לשתי הזמנות (54707,54712) שמקשר trackNo
  אחד לשתיהן, מניעת כפילות אירועים, אסמכתא חלקית שגויה שיוצרת חריגת מנהל בלי
  לעצור את העובד, ואישור דחיפות שמזיז הזמנה לראש התור בזמן אמת בין שני חלונות
  דפדפן שונים.

## מה מדומה (MOCK) ולמה

| רכיב | מה קורה בפועל | למה |
|---|---|---|
| **Sigma Bridge** | `backend/src/sigmaBridgeMock.js` מזין 4 הזמנות דמו (כולל 54707) ל-`orders_cache` במקום קריאה אמיתית מ-SQL Server | אין גישה לרשת/למסד Sigma האמיתי מסביבת הפיתוח הזו |
| **UPS** | אין חיבור אמיתי (Bearer token, credentials); הפורמט והלוגיקה של ה-Webhook עצמו (`upsWebhook.js`) הם אמיתיים לפי המסמך, ונבדקו עם `scripts/simulate-ups-event.js` | אין credentials אמיתיים ל-UPS בסביבה הזו |
| **מסד נתונים** | SQLite מקומי (`backend/aladin.db`) | אפס התקנה; הסכמה (`schema.sql`) נבנתה קרוב ל-PostgreSQL, כפי שהאפיון ממליץ ל-production, כדי שהמעבר יהיה קל |

בכל מקום כזה בקוד יש הערה `// MOCK:` שמסבירה מה יוחלף וכיצד.

## הרצה מקומית

**דרך 1 — ידנית משני טרמינלים:**

```bash
cd backend && npm install && npm run dev   # http://localhost:4310
```
```bash
cd frontend && npm install && npm run dev  # http://localhost:5173
```

בפעם הראשונה השרת יריץ seed אוטומטית וייצור את `backend/aladin.db` עם 5
משתמשים ו-4 הזמנות דמו (כולל 54707).

**דרך 2 — בתוך Claude Code**: הפרויקט מוגדר כבר ב-`.claude/launch.json` תחת
השמות `aladin-backend` (פורט 4310) ו-`aladin-frontend` (פורט 5173).

> שימו לב: פורט 4000 שמור על ידי Windows בחלק מהמערכות (Hyper-V dynamic port
> exclusions) ולכן ה-backend רץ על 4310.

## משתמשי דמו

| שם משתמש | סיסמה | תפקיד |
|---|---|---|
| agent1 | 1234 | סוכנת (נועה כהן) — משויכת ל-54707, 54712 |
| agent2 | 1234 | סוכן (איתי לוי) — משויך ל-54720, 54731 |
| warehouse | 1234 | מחסן (יוזר משותף יחיד, לפי ההחלטה באפיון) |
| manager | 1234 | מנהלת מחסן |
| admin | 1234 | מנהל מערכת |

## דימוי אירוע UPS

```bash
cd backend
node scripts/simulate-ups-event.js 54707          # טרק חדש להזמנה אחת, קוד 9 (במרכז מיון)
node scripts/simulate-ups-event.js 54707,54712     # אותו טרק לשתי הזמנות
node scripts/simulate-ups-event.js 54707 4          # קוד 4 = נמסר (מפעיל סגירה אוטומטית אם ההזמנה כבר "נמסרה ל-UPS")
node scripts/simulate-ups-event.js 54707 8          # קוד 8 = חריגה
```

## מבנה הפרויקט

```
backend/
  src/
    schema.sql        סכמת מסד הנתונים (10 טבלאות, סעיף 10 באפיון)
    db.js              חיבור SQLite
    seed.js            יצירת משתמשים + הזמנות דמו
    sigmaBridgeMock.js MOCK של קליטת הזמנות מ-Sigma
    workflow.js        מנוע הסטטוסים (claim אטומי, גרסאות, יומן אירועים)
    queue.js           חישוב תור + מיקום בתור
    urgentRequests.js  בקשות דחיפות + אישור מנהל
    upsWebhook.js       פענוח וקישור אוטומטי של Webhook מ-UPS
    realtime.js/bus.js  שידור WebSocket לכל שינוי
    auth.js             JWT + הרשאות לפי תפקיד
    routes.js           כל נתיבי ה-API
    server.js           נקודת כניסה
  scripts/simulate-ups-event.js
frontend/
  src/
    api.js, ws.js, labels.js
    pages/Login.jsx, OrdersList.jsx, OrderDetail.jsx, Exceptions.jsx, Admin.jsx
    App.jsx, styles.css
PLAN.md   תוכנית העבודה המלאה + סטטוס
```

## מה נשאר לפני production אמיתי

1. חיבור Sigma Bridge אמיתי (להחליף את `sigmaBridgeMock.js` בשירות Windows שקורא
   מ-SQL Server אמיתי — הממשק `orders_cache`/`order_items_cache` כבר מוכן).
2. הרשמה אמיתית מול UPS (`hd@ups.co.il`) וקבלת Bearer secret אמיתי ל-Webhook.
3. מעבר ל-PostgreSQL (הסכמה כבר קרובה, יש לבדוק תחביר SQL ספציפי ל-SQLite
   כמו `datetime('now')` ו-`ON CONFLICT`).
4. החלפת סיסמאות הטקסט-הגלוי ב-hash אמיתי (bcrypt) וסוד JWT מכספת סודות.
5. פריסה בפועל (Render/Fly/Supabase וכו') כדי לקבל כתובת HTTPS ציבורית ל-Webhook.
