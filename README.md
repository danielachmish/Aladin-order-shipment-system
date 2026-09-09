# אלדין – מערכת ניהול הזמנות ומשלוחים

מימוש MVP מלא של `Aladin_Order_and_Shipment_System_Specification_HE` (גרסה 1.2),
כולל תפקיד סוכן, תור עדיפויות/דחיפות, וסטטוס "ממתינה לתשובת לקוח/סוכן".

ר' [PLAN.md](PLAN.md) לתוכנית העבודה המלאה וסטטוס כל שלב.

## פריסה — חי ועובד מקצה לקצה

| חלק | כתובת | פלטפורמה |
|---|---|---|
| Frontend | **https://aladin-frontend-kappa.vercel.app** | Vercel |
| Backend | **https://aladin-backend-6vdq.onrender.com** | Render (שירות `aladin-backend`, free plan) |

התחברות (משתמשי דמו למטה) עובדת בפועל דרך הכתובת של ה-frontend, מכל מקום.

⚠️ **מגבלות שכדאי לדעת:**
- **הריפו הפך לציבורי** (היה פרטי) — זה מה שאפשר ל-Render לגשת אליו בלי
  תהליך אישור GitHub App נוסף. אין בו סודות (`.env` לא נכלל), אבל אם רוצים
  אותו שוב פרטי, צריך לחבר את ה-GitHub App של Render לריפו הספציפי (יש שלב
  ידני בדפדפן שדורש מסך, לא רק נייד).
- **תוכנית החינמית של Render**: הדיסק לא persistent — `aladin.db` (SQLite)
  מתאפס בכל דיפלוי/הפעלה מחדש, והשירות "נרדם" אחרי 15 דקות ללא תנועה (קם
  מחדש בבקשה הבאה עם כמה שניות השהיה). לשימוש אמיתי מתמשך: דיסק persistent
  בתשלום קטן ב-Render, או מעבר ל-Postgres מנוהל — דורש שינוי קוד, לא נעשה.
- כדי לעדכן משתני סביבה (Sigma/UPS) ב-backend: Render Dashboard → השירות
  `aladin-backend` → Environment.
- פריסה מחדש של ה-backend קורית אוטומטית בכל push ל-`main` (autoDeploy).
  לפריסה מחדש של ה-frontend אחרי שינוי: `cd frontend && vercel --prod`.

## חיבור Sigma אמיתי — [`bridge/`](bridge/README.md)

ה-backend בענן (Render) **לא יכול ולא צריך** לגשת ישירות ל-SQL Server הפיזי
שלך — זה גם לא בטוח (חשיפת SQL לאינטרנט) וגם לא מה שהאפיון ממליץ. במקום זה,
תיקיית [`bridge/`](bridge) היא תוכנה קטנה שרצה **על השרת הפיזי שלך** (איפה
שסיגמא כבר יושבת), קוראת הזמנות מקומית, ודוחפת אותן ל-backend דרך HTTPS
יוצא בלבד — בדיוק כמו הארכיטקטורה בסעיף 7 של האפיון.

הוראות מלאות ב-[bridge/README.md](bridge/README.md). בקצרה: להתקין Node.js
על השרת הפיזי, להעתיק את תיקיית `bridge/` לשם, למלא את פרטי ה-SQL Server
המקומי ב-`bridge/.env` (הסוד המשותף מול השרת בענן כבר ממולא מראש), ולהריץ
`npm run install-service` כמנהל כדי שזה ירוץ קבוע ברקע.

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

## חיבורים אמיתיים ל-Sigma ול-UPS

הקוד האמיתי (לא רק ה-mock) כבר קיים ומוכן:

- **`backend/src/realSigmaBridge.js`** — מתחבר ל-SQL Server אמיתי (חבילת `mssql`),
  קורא מ-`azmana_index`/`azmanot` לפי המפתח CompanyID+sidra+מספר הזמנה (סעיף 8),
  ומסנכרן ל-`orders_cache`/`order_items_cache` כל 45 שניות (ניתן לשינוי).
- **`backend/src/upsClient.js`** — OAuth client-credentials מול UPS, קריאת סטטוס
  משלוח (`wb-status`), הגבלת קצב (100/דקה, 1000/שעה) ובדיקת התאמה תקופתית (סעיף 9.4).
- **אימות Webhook** — כשיוגדר `UPS_WEBHOOK_BEARER_SECRET`, `POST /api/webhooks/ups`
  ידרוש `Authorization: Bearer <secret>` תואם (סעיף 9.2, 13).

**כדי להפעיל בפועל:** להעתיק `backend/.env.example` ל-`backend/.env` (הקובץ ב-.gitignore,
לא עולה ל-git) ולמלא:

| מה צריך | ממי | משתנה |
|---|---|---|
| שרת SQL, DB, משתמש/סיסמה לקריאה בלבד | מחשוב מקומי | `SIGMA_SQL_*` |
| כתובת Webhook + סוד Bearer | UPS (`hd@ups.co.il`, סעיף 9.2) | `UPS_WEBHOOK_BEARER_SECRET` |
| OAuth client id/secret (לא חובה להתחלה) | UPS Developer Portal | `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET` |

כל עוד `.env` לא קיים או שדה מסוים ריק — המערכת ממשיכה לעבוד עם ה-MOCK (ר' טבלה
למטה) בלי לקרוס, ומדווחת את המצב בזמן אמת במסך ניהול → מצב חיבורים.

⚠️ **לפני הרצה אמיתית מול Sigma**: שמות העמודות ב-`realSigmaBridge.js` (מלבד
CompanyID/sidra/azmana_num/pline/prit_ID/pname/quant/pprice שמופיעים במפורש
באפיון) הם השערה, מסומנים `// TODO`, וצריך לאמת אותם מול הסכימה האמיתית דרך
`POST /api/admin/sigma-test/3/0/54707` (שער Sigma, סעיף 17.1) לפני שמסתמכים
עליהם בפיילוט.

## מה עדיין מדומה (MOCK) ולמה

| רכיב | מה קורה בפועל | למה |
|---|---|---|
| **Sigma** | ללא `.env` — `sigmaBridgeMock.js` מזין 4 הזמנות דמו (כולל 54707) | אין גישה לרשת/למסד Sigma האמיתי מסביבת הפיתוח הזו; הקוד האמיתי מוכן, ר' מעלה |
| **UPS** | ללא `.env` — אין אימות Webhook ואין קריאות API יזומות; הפורמט והלוגיקה עצמם אמיתיים ונבדקו עם `scripts/simulate-ups-event.js` | אין credentials אמיתיים ל-UPS בסביבה הזו; הקוד האמיתי מוכן, ר' מעלה |
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
    sigmaBridgeMock.js MOCK של קליטת הזמנות מ-Sigma (בשימוש כשאין .env)
    realSigmaBridge.js חיבור SQL Server אמיתי (בשימוש כש-.env מוגדר)
    upsClient.js        OAuth + wb-status + בדיקת התאמה תקופתית מול UPS
    config.js            קריאת .env והחלטה מה MOCK ומה אמיתי
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
