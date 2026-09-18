# איפיון: ליקוט + בדיקה (QC) בסריקת ברקוד (Bluetooth HID)

נכתב לפי `BARCODE_PICKING_ARCHITECTURE_REVIEW.md` (17.9.2026), עם עדכון
18.9.2026: **סריקה בשלב הבדיקה היא חלק מ-V1, לא שיפור עתידי** — לפי
דניאל זה אפילו קריטי יותר מסריקה בליקוט עצמו. **מסמך זה הוא איפיון בלבד
— אין לבצע implementation לפי המסמך הזה עד אישור מפורש נוסף על "תוכנית
העבודה" שבסעיף 9.**

קלט שאושר: **ברקוד אחד בלבד לכל פריט** — אין צורך ב-`UnitsPerScan`/
`product_barcodes` נפרדת. הרזולוציה נעשית ישירות מול `order_items_cache.barcode`
הקיים.

---

## 1. מה בדיוק קורה — שני שלבים, אותו מנגנון

המסך הקיים (`PickChecklist`) כבר מפריד `mode='pick'` (בזמן שההזמנה
ב-`picking`) מ-`mode='check'` (ב-`ready_for_check`) — **אותו מנגנון
סריקה יעבוד בשני המצבים**, כשההקשר (הסטטוס הנוכחי של ההזמנה) קובע
איזו פעולה מתבצעת בפועל. זו בדיוק העקרון "Scan Event → Current Workflow
Context → Command".

### 1.1 בליקוט (`picking`)
בדיוק כפי שתואר בגרסה הקודמת של המסמך: כל סריקה מוסיפה 1 ל-`qty_picked`
של השורה המתאימה, עד לכמות שהוזמנה.

### 1.2 בבדיקה (`ready_for_check`) — **חדש בגרסה הזו**
כל סריקה מוסיפה 1 ל-**`qty_verified`** (עמודה חדשה) של השורה — לא
ל-`qty_picked`. המטרה: הבודק סורק פיזית את מה שבאמת בקרטון/במשטח,
והמערכת משווה מול מה שהמלקט *טען* שליקט (`qty_picked`), לא מול הכמות
המקורית שהוזמנה.

**למה מול `qty_picked` ולא מול `quantity`:** אם המלקט כבר סימן שורה
כ-`partial` (למשל 4 מתוך 6, 2 חסרים ומדווחים כבר), אין מה לבדוק
פיזית 6 יחידות — יש בפועל 4 בקרטון. הבודק סורק וה"יעד" שלו הוא 4,
לא 6. כשה-`qty_verified` מגיע ל-`qty_picked` — השורה מסומנת `checked=1`
**אוטומטית**, בדיוק כמו שליקוט שמגיע לכמות המלאה מסומן `pick_status='picked'`
אוטומטית.

**שורה שסומנה `missing`** — אין לה מה לבדוק בכלל (כלל קיים כבר היום
ב-`updateItemCheck`, `workflow.js:156`). סריקת ברקוד ששייך לשורה כזו
מחזירה קוד ייעודי (`NOTHING_TO_VERIFY`, ר' סעיף 4) במקום לנסות "לאמת"
משהו שלא אמור להיות שם.

**חריגה בבדיקה (הבודק סרק יותר יחידות מה-`qty_picked` שדווח):** זה
ממצא אמיתי וחשוב — ייתכן שהמלקט ספר לא נכון. **לא** מעדכנים אוטומטית
את `qty_picked` מסריקת יתר בבדיקה (זה עדיין "אמת" של המלקט עד שמישהו
מחליט אחרת) — מחזירים קוד `VERIFY_MISMATCH` עם ההפרש, והבודק משתמש
בכפתור "תיקון" הידני הקיים כבר היום (`correctPickedItem`,
`workflow.js:173-189`) כדי לתקן את הכמות בפועל, כולל הערה. זה שומר על
העיקרון הקיים במערכת: תיקון כמות הוא תמיד פעולה מודעת עם הסבר, לא תוצר
לוואי שקט של סריקה.

### 1.3 מה שלא משתנה בכלל
- כפתורי המגע הקיימים בשני המצבים (`✓ ליקטתי הכל`, `✓ מאשר`, `תיקון`
  וכו') ממשיכים לעבוד בדיוק כמו היום, **גם** כשסריקה פעילה על אותו מסך
  — כלל קיים במערכת ("הסריקה לא מחליפה, רק מצטרפת").
- אין מסך "Scan Mode" נפרד — הסריקה פועלת בתוך שני המסכים הקיימים
  (pick ו-check), עם פס חיווי + צליל, בלי popup (כמו בגרסה הקודמת של
  המסמך).

---

## 2. החלטות (לא לשנות בלי לחזור לדניאל)

| נושא | החלטה |
|---|---|
| ברקוד לפריט | אחד בלבד — כבר סוכם בגרסה קודמת |
| **סריקה בבדיקה** | **כן, חלק מ-V1** — לא שיפור עתידי (עדכון 18.9.2026) |
| יעד הבדיקה לכל שורה | `qty_picked` (מה שהמלקט דיווח), **לא** `quantity` המקורית |
| שורה `missing` בסריקת בדיקה | קוד `NOTHING_TO_VERIFY` — אין סריקה על שורה כזו, בדיוק כמו שאין אישור ידני עליה היום |
| חריגה בסריקת בדיקה (יותר מ-`qty_picked`) | **לא** מתקנים אוטומטית — קוד `VERIFY_MISMATCH`, הבודק מתקן ידנית דרך "תיקון" הקיים |
| כפתור "✓ מאשר" הידני בבדיקה | נשאר זמין ועדיין מסמן `checked=1` ישירות בלחיצה אחת (override מלא), בדיוק כמו "✓ ליקטתי הכל" בליקוט. **שינוי קטן נדרש**: כשהוא נלחץ, `qty_verified` יוגדר ל-`qty_picked` (כדי שהמסך לא יראה "מאושר" אבל "נסרקו 2 מתוך 4" — סתירה ויזואלית) |
| מסך ייעודי לסריקה | לא ב-V1 — נשאר כמו בגרסה הקודמת |
| מסלול ידני קיים (חוץ מהשינוי הקטן הנ"ל) | לא נוגעים בו |
| PickingSession כישות נפרדת | לא ב-V1 — `device_id` על כל אירוע סריקה |
| Concurrency | UPDATE אטומי מוגן ב-WHERE |
| Retry אחרי ניתוק | אוטומטי עד 3 ניסיונות, אותו `clientEventId` |

---

## 3. שינויי מודל נתונים

### 3.1 `order_items_cache` — עמודה חדשה

```sql
ALTER TABLE order_items_cache ADD COLUMN qty_verified REAL; -- NULL = עוד לא נסרק לבדיקה
```

### 3.2 טבלה חדשה: `scan_events`

(שינוי שם מ-`pick_events` שהוצע בגרסה הקודמת ל-`scan_events` — כי היא
משרתת עכשיו גם ליקוט וגם בדיקה, לא רק ליקוט. אין עלות לשינוי השם כי
עוד לא נכתב קוד.)

```sql
CREATE TABLE IF NOT EXISTS scan_events (
  event_id        TEXT PRIMARY KEY,
  client_event_id TEXT NOT NULL,
  order_key       TEXT NOT NULL,
  line_no         INTEGER NOT NULL,
  barcode         TEXT,
  stage           TEXT NOT NULL CHECK (stage IN ('picking','verification')),
  delta_qty       REAL NOT NULL,
  previous_qty    REAL NOT NULL,
  new_qty         REAL NOT NULL,
  result_code     TEXT NOT NULL,
  user_id         TEXT,
  device_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_key, client_event_id)
);
CREATE INDEX IF NOT EXISTS idx_scan_events_order ON scan_events(order_key, line_no);
```

`stage` קובע אם `previous_qty`/`new_qty` מתייחסים ל-`qty_picked` או
ל-`qty_verified` — כדי שהאודיט יהיה חד-משמעי לגבי איזו כמות השתנתה.

---

## 4. Domain — `backend/src/workflow.js`

פונקציה חדשה אחת, `scanItem(orderKey, { barcode, clientEventId, userId, deviceId })`,
שמפנה פנימית לפי `state.status`:

```
state.status === 'picking'        → _scanForPicking(...)   -- כמתואר בגרסה הקודמת
state.status === 'ready_for_check' → _scanForVerification(...) -- חדש, סעיף 4.1
אחרת                               → { resultCode: 'ORDER_NOT_SCANNABLE', currentStatus: state.status }
```

(שינוי שם קוד: `ORDER_NOT_IN_PICKING` → `ORDER_NOT_SCANNABLE`, כי הוא
עכשיו מכסה גם מצב שבו ההזמנה לא בבדיקה. שני מצבים תקינים לסריקה —
`picking` ו-`ready_for_check` — לא רק אחד.)

### 4.1 `_scanForVerification` — זרימה

1. רזולוציית ברקוד → שורה, **בהיקף ההזמנה הנוכחית**, אותו כלל טיברייק
   (מיקום ואז מספר שורה) כמו בליקוט — אבל הפעם מתוך שורות עם
   `pick_status != 'missing'` **וגם** `COALESCE(qty_verified,0) < qty_picked`.
   - אין שום שורה תואמת עם `pick_status != 'missing'` בכלל (או שהברקוד
     שייך רק לשורות `missing`) → אם יש התאמה לשורת `missing` ספציפית —
     `NOTHING_TO_VERIFY`; אחרת `NOT_IN_ORDER`.
   - יש התאמות אך כולן כבר `qty_verified >= qty_picked` → `VERIFY_MISMATCH`
     (סריקת יתר).
2. UPDATE אטומי מוגן:
   ```sql
   UPDATE order_items_cache
   SET qty_verified = COALESCE(qty_verified,0) + 1,
       checked = CASE WHEN COALESCE(qty_verified,0) + 1 >= qty_picked THEN 1 ELSE checked END,
       pick_marked_at = pick_marked_at -- ללא שינוי, זה שדה של שלב הליקוט
   WHERE order_key = ? AND line_no = ?
     AND COALESCE(qty_verified,0) + 1 <= qty_picked
   ```
   `changes === 0` → `VERIFY_MISMATCH`.
3. כתיבת `scan_events` עם `stage='verification'`.
4. `resultCode`: `ITEM_COMPLETED` אם השורה הגיעה ל-`checked=1` דרך
   הסריקה הזו, `ORDER_COMPLETED` אם *כל* השורות הרלוונטיות (`pick_status
   != 'missing'`) עכשיו `checked=1`, אחרת `ACCEPTED`.

### 4.2 שינוי קטן ב-`updateItemCheck` הקיים

כשמסמנים `checked=1` ידנית (הכפתור "✓ מאשר" הקיים,
`workflow.js:150-165`), מוסיפים שורת עדכון אחת: `qty_verified = qty_picked`
(ורק כשמסמנים `checked=0` בחזרה — לא קיים היום מסלול כזה בפועל, אין
צורך לטפל). זה השינוי היחיד במסלול הידני הקיים בכל המסמך — נדרש כדי
שהתצוגה תישאר עקבית (לא "מאושר" עם מונה סריקה חלקי).

---

## 5. API — `backend/src/routes.js`

אותו endpoint יחיד מהגרסה הקודמת, ללא שינוי בחתימה — ההקשר (ליקוט/בדיקה)
נקבע לגמרי בצד השרת לפי סטטוס ההזמנה:

```
POST /orders/:key/items/scan
Auth: requireRole('warehouse', 'warehouse_manager')
Body: { barcode: string, clientEventId: string, deviceId?: string }
```

תגובה — דוגמה לסריקת בדיקה:
```json
{
  "resultCode": "ACCEPTED",
  "stage": "verification",
  "lineNo": 3,
  "itemCode": "18813",
  "itemName": "JBL FLIP 7",
  "qtyVerified": 3,
  "qtyPicked": 4,
  "remaining": 1,
  "lineCompleted": false,
  "orderProgress": { "done": 5, "total": 7 }
}
```

`orderProgress` בשלב בדיקה נספר לפי `checked=1` מתוך השורות שלא `missing`
(תואם למה ש-`finishCheck` הקיים כבר בודק, `workflow.js:248-251`).

### Result codes — סט מלא ל-V1 (משני השלבים יחד)

| קוד | ליקוט | בדיקה |
|---|---|---|
| `ACCEPTED` | סריקה תקינה, לא הושלמה שורה | סריקה תקינה, לא הושלמה שורה |
| `ITEM_COMPLETED` | השורה הגיעה לכמות המלאה | השורה הגיעה ל-`checked=1` |
| `ORDER_COMPLETED` | כל השורות טופלו בליקוט | כל השורות הרלוונטיות אושרו בבדיקה |
| `NOT_IN_ORDER` | ברקוד לא שייך לשום שורה פתוחה | ברקוד לא שייך לשום שורה רלוונטית לבדיקה |
| `OVER_PICK` | חריגה מהכמות שהוזמנה | — (לא רלוונטי לשלב זה) |
| `VERIFY_MISMATCH` | — | סריקה מעבר ל-`qty_picked` שדווח |
| `NOTHING_TO_VERIFY` | — | ברקוד שייך לשורה שסומנה `missing` |
| `ORDER_NOT_SCANNABLE` | ההזמנה לא ב-`picking`/`ready_for_check` | (אותו קוד, שני הכיוונים) |
| `ERROR` | כל שגיאה לא צפויה | כל שגיאה לא צפויה |

(`DUPLICATE_SCAN` **לא** קוד נפרד — replay של `clientEventId` קיים
פשוט מחזיר את התוצאה המקורית ששמורה ב-`scan_events`, בשקיפות מלאה,
בלי label מיוחד — כפי שכבר הוחלט בגרסה הקודמת.)

---

## 6. Frontend

### 6.1 `useScannerCapture` — פעיל בשני המצבים

בגרסה הקודמת הכתוב היה "פעיל רק כש-`mode='pick'`" — **מתוקן**: פעיל
בכל פעם ש-`PickChecklist` מורכב, בין אם `mode='pick'` ובין אם
`mode='check'`. הקומפוננטה כבר יודעת את המצב שלה — ה-hook לא צריך
לדעת כלום על pick מול check, הוא רק שולח `{barcode, clientEventId}`
ל-endpoint אחד; השרת מחליט.

### 6.2 פס חיווי — אותו רכיב, טקסטים שונים לפי `stage`/`resultCode`

- בדיקה, הצלחה: "✓ אומת — 3 מתוך 4"
- בדיקה, `NOTHING_TO_VERIFY`: "⚠️ הפריט הזה סומן כחסר — אין מה לבדוק"
- בדיקה, `VERIFY_MISMATCH`: "❌ נסרק יותר ממה שדווח כנלקט — בדקו/תקנו ידנית"

שאר ההתנהגות (צליל, עדכון שורה מהתגובה, בלי רענון מלא) זהה למתואר
בליקוט.

---

## 7. מה **לא** משתנה

- `finishPicking`, `finishCheck`, `correctPickedItem`, `markItemReplaced`
  — ללא שינוי.
- `updateItemCheck` — כמעט ללא שינוי (רק ה-sync הקטן ל-`qty_verified`
  בסעיף 4.2).
- אין שינוי ב-RBAC.

---

## 8. בדיקות — תוספות לתוכנית הקודמת

**Unit:**
- סריקת בדיקה שמגיעה בדיוק ל-`qty_picked` → `checked=1` אוטומטי.
- סריקת בדיקה על שורה `missing` → `NOTHING_TO_VERIFY`, בלי לגעת בנתונים.
- סריקת בדיקה מעבר ל-`qty_picked` → `VERIFY_MISMATCH`, בלי לשנות
  `qty_verified` מעבר לגבול.
- לחיצה ידנית על "✓ מאשר" → `qty_verified` מתעדכן ל-`qty_picked`.

**ידני:**
- זרימה מלאה: ליקוט בסריקה → בדיקה בסריקה → `finish-check` → `ready_to_pack`,
  בלי לגעת במסך בכלל מלבד המעברים בין שלבים.
- שורה עם חוסר חלקי (`partial`, 4/6) — לוודא שסריקת בדיקה דורשת בדיוק
  4 סריקות, לא 6.

---

## 9. תוכנית עבודה (מעודכנת)

| # | מה | קבצים | תלות |
|---|---|---|---|
| 1 | `scan_events` + עמודת `qty_verified` | `schema.sql`, `db.js` | — |
| 2 | `scanItem()` + `_scanForPicking`/`_scanForVerification` + unit tests | `workflow.js`, `backend/tests/` | 1 |
| 3 | שינוי קטן ב-`updateItemCheck` (sync `qty_verified`) | `workflow.js` | 1 |
| 4 | Route `POST /orders/:key/items/scan` | `routes.js` | 2, 3 |
| 5 | `useScannerCapture` hook | `frontend/src/scanner/` (חדש) | — (מקביל ל-1-4) |
| 6 | `api.scanItem` + retry | `frontend/src/api.js` | 4 |
| 7 | שילוב ב-`PickChecklist` — שני המצבים | `PickChecklist.jsx`, `styles.css` | 5, 6 |
| 8 | בדיקות אינטגרציה (concurrency, idempotency, שני השלבים) | `backend/tests/` | 4 |
| 9 | בדיקה ידנית עם סורק אמיתי — כולל זרימה מלאה ליקוט+בדיקה | — | 7 |

---

## 10. שאלות פתוחות (לא חוסמות)

- יש כבר סורק Bluetooth HID בפועל לבדיקה?
- מצב שבו כמה שורות `partial` באותה הזמנה — יש עדיפות סדר בדיקה
  (למשל תמיד לפי מיקום, כמו בליקוט), או שזה מספיק כברירת מחדל בלי
  לשאול?

---

**המסמך הזה מוכן לאישור.** לא מתחילים בכתיבת קוד עד אישור מפורש על
תוכנית העבודה בסעיף 9.
