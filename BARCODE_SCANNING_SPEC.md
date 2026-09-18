# איפיון: ליקוט בסריקת ברקוד (Bluetooth HID)

נכתב לפי `BARCODE_PICKING_ARCHITECTURE_REVIEW.md` (17.9.2026) ואישור דניאל
18.9.2026 להמשיך לאיפיון מדויק. **מסמך זה הוא איפיון בלבד — אין לבצע
implementation לפי המסמך הזה עד אישור מפורש נוסף על "תוכנית העבודה"
שבסעיף 9.**

קלט שאושר: **ברקוד אחד בלבד לכל פריט** (אין ברקוד מארז/קרטון/יחידות
מרובות) — זה מפשט משמעותית את מודל הנתונים ביחס למה שנסקר ב-Architecture
Review (אין צורך ב-`UnitsPerScan`, אין צורך בטבלת `product_barcodes`
נפרדת).

---

## 1. מה בדיוק קורה מנקודת המבט של המלקט

1. מלקט נמצא במסך הזמנה שכבר ב-`picking` (בדיוק כמו היום).
2. מסך הליקוט (`PickChecklist`, mode='pick') **לא משתנה ויזואלית** —
   אותה רשימת שורות ממוינת לפי מיקום, אותם כפתורי מגע. **נוסף** רק:
   - פס חיווי דק בראש המסך (לא popup, לא modal) שמציג את תוצאת הסריקה
     האחרונה למשך כ-1.5 שניות ואז נעלם.
   - צליל קצר (הצלחה/שגיאה) בכל סריקה.
3. המלקט מרים פריט, לוחץ trigger בסורק. הסורק (Bluetooth HID) "מקליד"
   את הברקוד + Enter ישירות לדפדפן — **בלי שהמלקט נוגע במסך בכלל**.
4. המערכת מזהה שזו סריקה (לא הקלדה של אדם), שולחת לשרת, מקבלת תשובה
   תוך פחות מ-¼ שנייה בדרך כלל, ומעדכנת:
   - את השורה הרלוונטית ברשימה (מסומנת "נלקט"/מתקדמת בכמות).
   - את פס החיווי העליון.
5. אם הפריט הושלם (כל הכמות נלקטה) — השורה מסומנת ✓ אוטומטית, **בלי**
   שהמלקט צריך ללחוץ שום כפתור.
6. **המסלול הידני הקיים ממשיך לעבוד בדיוק כמו היום, ללא שום שינוי** —
   כפתורי "✓ ליקטתי הכל" / "כמות אחרת" / "לא נמצא" נשארים זמינים תמיד,
   גם כש-Scan פעיל על אותו מסך. שני הערוצים עובדים במקביל על אותה רשימה.

**החלטה מפורשת:** ב-V1 **אין** מסך "Scan Mode" נפרד ומינימליסטי כפי
שתואר בדרישה המקורית — הסורק פועל *בתוך* מסך הליקוט הקיים (רשימת
השורות + פס חיווי), לא מחליף אותו. הסיבה: (א) זה מקטין באופן ניכר את
היקף השינוי הראשוני והסיכון, (ב) זה עונה על העיקרון "הסורק ממשיך לעבוד
גם ב-Manual Mode" באופן הכי ישיר — כי זה אותו מסך בדיוק. אם אחרי שימוש
בפועל יתברר שרוצים מסך "נקי" ייעודי — זה תוספת UI קטנה בשלב מאוחר יותר,
לא צריך לתכנן אותה מראש.

---

## 2. החלטות (לא לשנות בלי לחזור לדניאל)

| נושא | החלטה |
|---|---|
| ברקוד לפריט | **אחד בלבד** — בוטל הצורך ב-`UnitsPerScan`/`product_barcodes`. הרזולוציה נעשית ישירות מול `order_items_cache.barcode` הקיים, בהיקף ההזמנה הפעילה בלבד |
| מסך ייעודי לסריקה | **לא ב-V1** — הסורק פועל בתוך מסך הליקוט הקיים (סעיף 1) |
| מסלול ידני קיים | **לא נוגעים בו בכלל** — `updateItemPick`/`correctPickedItem` נשארים בדיוק כמו שהם. הסריקה היא primitive **נוסף**, לא מחליפה את הקיים |
| Verification/בדיקה בסריקה | **לא ב-V1.** מסך הבדיקה (`mode='check'`) ממשיך לעבוד ידנית כמו היום. תשתית הסריקה תאפשר את זה בעתיד (dispatch לפי סטטוס), אבל לא נבנה עכשיו — מוסיף היקף בלי דרישה מיידית |
| PickingSession כישות נפרדת | **לא ב-V1.** משתמשים ב-`claimed_by`/`status` הקיימים; `device_id` נשמר ישירות על כל `pick_event` בלי טבלת session נפרדת |
| ברקוד שמופיע על יותר משורה אחת באותה הזמנה (נדיר) | הסריקה מוחלת על השורה הראשונה לפי סדר התצוגה (מיקום, ואז מספר שורה) שעוד יש בה כמות חסרה. אם כל השורות עם הברקוד הזה כבר מלאות — `OVER_PICK` |
| ברקוד לא ידוע לגמרי מול "לא בהזמנה הזו" | **אין הבחנה ב-V1** (אין קטלוג ברקודים גלובלי) — קוד אחד: `NOT_IN_ORDER`. התגובה למלקט זהה בשני המקרים: "הפריט הזה לא בהזמנה" |
| Concurrency | UPDATE אטומי מוגן ב-WHERE (לא version נפרד לשורה) — מספיק לתהליך Node יחיד (`db.js`), עם תיעוד-כוונה לתאימות Postgres עתידית |
| Retry אחרי ניתוק | אוטומטי, שקוף למלקט (אותו `clientEventId`), עד 3 ניסיונות תוך כ-2 שניות. רק אחרי שכולם נכשלו — חיווי כשל ברור |

---

## 3. שינויי מודל נתונים

### 3.1 טבלה חדשה: `pick_events`

תפקיד כפול: **idempotency** (מפתח ה-`UNIQUE`) + **audit מובנה** לכל
פעולת שינוי כמות (גם סריקה וגם — לשימוש עתידי אופציונלי — ידני).

```sql
CREATE TABLE IF NOT EXISTS pick_events (
  event_id        TEXT PRIMARY KEY,
  client_event_id TEXT NOT NULL,      -- מהלקוח, crypto.randomUUID()
  order_key       TEXT NOT NULL,
  line_no         INTEGER NOT NULL,
  barcode         TEXT,               -- מה שנסרק בפועל
  delta_qty       REAL NOT NULL,
  previous_qty    REAL NOT NULL,
  new_qty         REAL NOT NULL,
  result_code     TEXT NOT NULL,
  user_id         TEXT,
  device_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_key, client_event_id)
);
CREATE INDEX IF NOT EXISTS idx_pick_events_order ON pick_events(order_key, line_no);
```

`source` הושמט מהעיצוב המקורי ב-Architecture Review — ב-V1 הטבלה הזו
משמשת **רק** את מסלול הסריקה (המסלול הידני לא נוגע בה, ר' החלטה
בסעיף 2), כך שהעמודה מיותרת כרגע. אם בעתיד המסלול הידני יזרום דרך אותה
תשתית — מוסיפים אז.

### 3.2 `db.js` — מיגרציה

שורה נוספת ל-`ensureColumn`/יצירת טבלה, באותו דפוס הקיים
(`db.js:19-55`) — אין שינוי לעמודות קיימות ב-`order_items_cache`.

---

## 4. Domain — `backend/src/workflow.js`

פונקציה חדשה, **לצד** (לא במקום) הפונקציות הקיימות:

```js
// scanPickItem(orderKey, { barcode, clientEventId, userId, deviceId })
// → { resultCode, lineNo?, itemCode?, itemName?, qtyPicked?, quantity?,
//     remaining?, lineCompleted?, orderProgress?, currentStatus? }
```

זרימה פנימית (כל השלבים בתוך טרנזקציית `db.transaction`):

1. **דה-דופליקציה קודם לכל דבר**: `INSERT OR IGNORE INTO pick_events
   (..., client_event_id, order_key, ...) VALUES (...)` עם ה-`UNIQUE`.
   אם `changes === 0` — זה replay. שולפים את השורה הקיימת לפי
   `(order_key, client_event_id)` ומחזירים את `result_code`/הנתונים
   שנשמרו בה בזמנו, **בלי לגעת בכמות שוב**. (המימוש בפועל: כותבים את
   ה-`pick_event` בסוף התהליך לא בהתחלה, אבל בודקים existence מראש לפי
   `client_event_id` — ר' הערת מימוש בסעיף 9).
2. `state = getState(orderKey)`. אם לא קיים → `ERROR`. אם
   `state.status !== 'picking'` → `resultCode: 'ORDER_NOT_IN_PICKING'`,
   `currentStatus: state.status` (כדי שהפרונט יבנה הודעה מדויקת: "ההזמנה
   כרגע במצב 'בדיקה'" וכו', בלי צורך בקוד נפרד לכל סטטוס).
3. רזולוציית ברקוד → שורה: `SELECT * FROM order_items_cache WHERE
   order_key=? AND barcode=? ORDER BY location, line_no`. מסננים לשורות
   עם `quantity - COALESCE(qty_picked,0) > 0`.
   - 0 שורות תואמות בכלל → `NOT_IN_ORDER`.
   - 0 שורות עם יתרה (הכל כבר נלקט) → `OVER_PICK`.
   - אחרת → השורה הראשונה ברשימה הממוינת.
4. UPDATE אטומי מוגן:
   ```sql
   UPDATE order_items_cache
   SET qty_picked = COALESCE(qty_picked,0) + 1,
       pick_status = CASE WHEN COALESCE(qty_picked,0) + 1 >= quantity THEN 'picked' ELSE 'partial' END,
       pick_marked_at = datetime('now')
   WHERE order_key = ? AND line_no = ?
     AND COALESCE(qty_picked,0) + 1 <= quantity
   ```
   אם `changes === 0` כאן (race נדיר בין הבדיקה לעדכון) → `OVER_PICK`.
5. כתיבת `pick_events` עם התוצאה הסופית.
6. חישוב `orderProgress` (`done`/`total` לפי `pick_status IS NOT NULL`
   מתוך כל שורות ההזמנה — כמו הבדיקה הקיימת ב-`finishPicking`).
7. `emitChange('order', { order_key, status: state.status })` — **בלי**
   payload, בדיוק כמו כל שאר הפעולות הקיימות היום.
8. `resultCode`: `ITEM_COMPLETED` אם השורה הגיעה לכמות המלאה,
   `ORDER_COMPLETED` אם *כל* שורות ההזמנה טופלו אחרי הסריקה הזו (משדר
   גם ACCEPTED/ITEM_COMPLETED לפי המקרה — `ORDER_COMPLETED` הוא תוספת
   מידע, לא מחליף), אחרת `ACCEPTED`.

---

## 5. API — `backend/src/routes.js`

```
POST /orders/:key/items/scan
Auth: requireRole('warehouse', 'warehouse_manager')   -- זהה בדיוק לשאר routes הליקוט
Body: { barcode: string, clientEventId: string, deviceId?: string }
```

תגובה (דוגמה — מקרה רגיל):
```json
{
  "resultCode": "ACCEPTED",
  "lineNo": 3,
  "itemCode": "18813",
  "itemName": "JBL FLIP 7",
  "qtyPicked": 4,
  "quantity": 6,
  "remaining": 2,
  "lineCompleted": false,
  "orderProgress": { "done": 5, "total": 8 }
}
```

תגובה — מקרה שגיאה:
```json
{ "resultCode": "NOT_IN_ORDER", "barcode": "1200130019302" }
```

ולידציה בסיסית ב-route (לפני קריאה ל-domain): `barcode`/`clientEventId`
חייבים להיות מחרוזות לא ריקות — אחרת `400`.

---

## 6. Frontend

### 6.1 `frontend/src/scanner/useScannerCapture.js` (חדש)

Hook בודד, ללא תלות חיצונית:

- מאזין ל-`keydown` ברמת `window`, פעיל רק כש-`PickChecklist` ב-mode='pick'
  מורכב (`useEffect` עם cleanup).
- **לא לוכד** אם `document.activeElement` הוא `<input>`/`<textarea>`
  אמיתי (כדי לא להפריע לשדות העריכה הקיימים — "הערה", "כמות אחרת" וכו').
- צובר תווים; אם המרווח בין תו לתו > ~60ms — מאפס buffer (זו הקלדת
  אדם, לא סורק). שולח את ה-barcode שנצבר ב-`Enter` (הסורקים שולחים
  CR/Enter כ-terminator ברירת מחדל).
- מייצר `clientEventId` חדש (`crypto.randomUUID()`) לכל סריקה גולמית
  (סריקה חדשה = event חדש; רק retry על אותה סריקה שנכשלה ברשת משתמש
  שוב באותו id — ר' סעיף 6.3).

### 6.2 שילוב ב-`PickChecklist.jsx`

- פס חיווי חדש בראש הרשימה (לא בתוך כרטיס שורה בודד) — מציג את תוצאת
  הסריקה האחרונה לכ-1.5 שניות: ירוק+שם פריט ל-`ACCEPTED`/`ITEM_COMPLETED`,
  אדום+הודעה ל-`NOT_IN_ORDER`/`OVER_PICK`/`ORDER_NOT_IN_PICKING`.
- צליל: `AudioContext` מובנה בדפדפן (טון מסונתז קצר, בלי קובץ סאונד
  חיצוני) — צליל אחד קצר להצלחה, צליל אחר (נמוך/כפול) לשגיאה.
- עדכון השורה הרלוונטית ברשימה מהתגובה עצמה (`onItemUpdated`, בדיוק
  כמו שכפתורי המגע כבר עושים היום, `PickChecklist.jsx:36`) — **בלי**
  קריאת רענון נוספת.

### 6.3 טיפול בכשל רשת (`frontend/src/api.js`, מורחב)

`api.scanItem(orderKey, {barcode, clientEventId, deviceId})`:
- על כשל רשת (לא HTTP error מהשרת — timeout/disconnect): retry אוטומטי
  עד 2 פעמים נוספות (300ms, 800ms), **אותו `clientEventId`**.
- אם כל הניסיונות נכשלו: פס חיווי אדום קבוע "אין חיבור — הסריקה
  האחרונה לא אושרה, בדקו את הכמות במסך לפני שממשיכים" (לא נעלם אוטומטית
  כמו חיווי רגיל — דורש שהעובד יראה את זה).
- **אין** local queue / החזרה מדומה של "הצליח" — תואם את העיקרון
  "אמינות על פני illusion של offline" מהדרישה המקורית.

---

## 7. מה **לא** משתנה

- `updateItemPick`, `correctPickedItem`, `updateItemCheck`, `finishPicking`,
  `finishCheck` — כל אחד מהם נשאר בדיוק כפי שהוא היום, קוד וUX.
- מסך הבדיקה (`mode='check'`) — ללא סריקה ב-V1, ממשיך ידני לגמרי.
- `sigmaIngest.js` — ללא שינוי. הברקוד כבר זורם כמו שהוא.
- אין שינוי בסכימת ה-RBAC (`requireRole`) — אותם roles קיימים.

---

## 8. בדיקות

**Unit (`backend/tests`, vitest — לפי התבנית הקיימת):**
- רזולוציית ברקוד: שורה יחידה תואמת, אין התאמה, כל ההתאמות כבר מלאות,
  שתי שורות עם אותו ברקוד (אחת מלאה אחת לא).
- UPDATE אטומי: הגעה בדיוק לכמות המלאה, ניסיון חריגה ממנה.
- idempotency: אותו `clientEventId` פעמיים → פעם שנייה לא משנה כמות,
  מחזירה את אותה תוצאה.
- הזמנה לא ב-`picking` (למשל `ready_for_check`/`closed`) → `ORDER_NOT_IN_PICKING`.

**Integration:**
- שתי "סריקות" מקבילות (בקשות בו-זמנית) על אותה שורה קרוב לגבול הכמות
  — לוודא שרק אחת מצליחה אם השנייה תחרוג.
- תרחיש retry: קריאה ש"נכשלת" ברשת (מדומה) ואז נשלחת שוב עם אותו id.

**ידני, עם חומרה אמיתית (לפני שחרור):**
- סריקה רצופה מהירה (20-30 סריקות ברצף תוך שניות) על הזמנה עם שורות
  מרובות — לוודא שאין דילוג/כפילות.
- ניתוק Bluetooth באמצע סריקה — לוודא שההתנהגות לא "תוקעת" את המסך.
- סריקת ברקוד שלא שייך להזמנה, וסריקה אחרי שהפריט כבר הושלם (OVER_PICK).
- עבודה מעורבת: כמה שורות בסריקה, כמה שורות בכפתורים ידניים, באותה
  הזמנה — לוודא שהמצב הסופי עקבי (סה"כ תואם למה שצפוי).

---

## 9. תוכנית עבודה (סדר בנייה מוצע)

| # | מה | קבצים | תלות |
|---|---|---|---|
| 1 | טבלת `pick_events` + מיגרציה | `schema.sql`, `db.js` | — |
| 2 | `scanPickItem()` ב-domain + unit tests | `workflow.js`, `backend/tests/` | 1 |
| 3 | Route `POST /orders/:key/items/scan` | `routes.js` | 2 |
| 4 | `useScannerCapture` hook | `frontend/src/scanner/useScannerCapture.js` (חדש) | — (עצמאי, אפשר במקביל ל-1-3) |
| 5 | `api.scanItem` + retry logic | `frontend/src/api.js` | 3 |
| 6 | שילוב ב-`PickChecklist` (פס חיווי, צליל, חיבור ה-hook) | `PickChecklist.jsx`, `styles.css` | 4, 5 |
| 7 | בדיקות אינטגרציה (concurrency, idempotency) | `backend/tests/` | 3 |
| 8 | בדיקה ידנית עם סורק Bluetooth אמיתי | — | 6 |

שלבים 1-3 (backend) ו-4 (frontend hook) יכולים להתקדם במקביל. שלב 6
תלוי בשניהם.

**הערת מימוש לשלב 2** (למתכנת בפועל, לא שינוי באיפיון): כדי שדה-דופליקציה
תעבוד נכון גם אם ה-UPDATE על `order_items_cache` נכשל (למשל `OVER_PICK`),
יש לכתוב שורת `pick_events` **בכל מקרה** (גם לתוצאות שגיאה), לא רק
להצלחות — אחרת retry על סריקה שהניבה `OVER_PICK` יבצע את הבדיקה מחדש
בכל פעם (לא מזיק כי היא idempotent מטבעה, אבל עדיף sto לוגיקה אחידה:
כל `client_event_id` נכתב פעם אחת, לא משנה מה התוצאה).

---

## 10. שאלות פתוחות (לא חוסמות, אך שווה לדעת התשובה לפני שלב 8)

- יש ברשותך כבר סורק Bluetooth HID ספציפי לבדיקה, או שצריך להזמין אחד
  לפני שאפשר לבצע את הבדיקה הידנית בסעיף 8?
- האם לבדוק גם דגם מכשיר ספציפי (טאבלט/מותג) לפני השחרור, או שכל דפדפן
  מודרני מספיק כהנחת עבודה?

---

**המסמך הזה מוכן לאישור.** לפי הבקשה שלך — לא מתחילים בשום כתיבת קוד
עד אישור מפורש על תוכנית העבודה בסעיף 9.
