# Architecture Review: ליקוט עם סורקי ברקוד אלחוטיים

מסמך ניתוח בלבד — **לא בוצע שום implementation**. נכתב לפי סריקת קוד בפועל
של הריפו (`backend/`, `frontend/`, `schema.sql`, `PICKING_QC_SPEC.md`) נכון
ל-17.9.2026, מול הדרישה שהוצגה (ליקוט מקצועי בסורק אלחוטי, אלפי סריקות
ביום, ללא כתיבה חזרה ל-Sigma).

---

## 0. ממצא פותח — חשוב לפני הכל: "SmartCycle" מול "Aladin"

הדרישה מתוארת במפורש כמערכת **SaaS מרובת-דיירים (multi-tenant)** בשם
SmartCycle, עם "אסור שברקוד של Company A יפתר לפריט של Company B" וכו'.

**סרקתי את כל הריפו לפי `tenant`/`multi-company` — אין שום construct כזה
בקוד היום.** הריפו הקיים (`Aladin_Order_and_Shipment_System`) הוא מערכת
**single-tenant** לחלוטין:

- `users` — טבלה גלובלית אחת, בלי עמודת tenant/company.
- ה-JWT (`backend/src/auth.js:20`) נושא רק `sub/role/name` — אין tenant claim.
- `orders_cache.company_id`/`sidra` (`schema.sql:17-18`) הם **חלק מהמפתח
  המורכב של סיגמא עצמה** (CompanyID+Sidra+OrderNum, סעיף 8 באפיון סיגמא) —
  לא tenant ברמת האפליקציה. זה שדה שמזהה "חברה" *בתוך* מסד סיגמא אחד
  ספציפי (של אלדין), לא כמה לקוחות SaaS שונים עם מסדי סיגמא שונים.
- ה-WebSocket (`backend/src/realtime.js:16`) משדר **לכל הלקוחות המחוברים
  בלי הבחנה** — `wss.clients.forEach(...)`. אין ערוץ/room לפי הזמנה או
  חברה.
- ה-Bridge (`bridge/`) מתחבר לשרת SQL Server **אחד ספציפי** של אלדין.

**המשמעות:** כל מה שנבנה כאן היום הוא בעבור **חברה אחת** (אלדין), לא
פלטפורמה שמארחת כמה חברות לקוח נפרדות עם בידוד מלא. אם "SmartCycle" הוא
כיוון עתידי (למשל: המרת אלדין למוצר שיימכר גם לחברות אחרות) — זה **פרויקט
ארכיטקטוני נפרד וגדול בפני עצמו** (tenant_id בכל טבלה, auth מודע-tenant,
realtime מבודד, בידוד קטלוג ברקודים בין חברות), ולא תוצר לוואי של הוספת
סורק ברקוד.

**המלצה לשלב הזה (לא חוסמת):** בכל טבלה **חדשה** שנוסיף לצורך הליקוט
(scan events, picking sessions, product barcodes) — נוסיף עמודת
`company_id` כבר עכשיו (היא ממילא קיימת בקונטקסט של `orders_cache`),
כך שהמעבר העתידי ל-tenant אמיתי לא ידרוש מיגרציה נוספת על הטבלאות האלה
ספציפית. אבל זה **לא** הופך את המערכת ל-multi-tenant אמיתי — זה רק לא
סוגר את הדלת. multi-tenancy אמיתי (בידוד auth/realtime/JWT) נשאר להחלטה
נפרדת, כי הוא נוגע בכל המערכת הקיימת, לא רק בליקוט.

לאורך שאר המסמך אני כותב לפי הריפו הקיים (single-tenant, חברה אחת –
אלדין), עם ציון מפורש איפה ההנחה הזו משפיעה על ההמלצה.

---

## 1. מיפוי הארכיטקטורה הקיימת

הסטאק בפועל: **Node/Express (JS רגיל, לא TS) + better-sqlite3 (סינכרוני,
WAL) + React/Vite PWA + WebSocket (`ws`)**. לא DDD/שכבות נפרדות — זו
ארכיטקטורה שטוחה בכוונה (MVP): `routes.js` → פונקציות ב-`workflow.js`
שמערבבות כללי עסק + SQL ישירות באותה פונקציה, בתוך טרנזקציה סינכרונית
אחת. אין ORM, אין repository layer נפרד.

| תחום | קובץ | מצב |
|---|---|---|
| Orders (מקור סיגמא) | `orders_cache`, `order_items_cache` (`schema.sql:15-71`) | READ-ONLY עותק מסיגמא, מתעדכן דרך push מה-Bridge |
| Workflow/Picking | `backend/src/workflow.js` (771 שורות) | מנוע סטטוסים + פעולות ליקוט/בדיקה ברמת שורה, **כבר כולל `picking`→`ready_for_check`→`ready_to_pack`** |
| Sigma read integration | `bridge/sync.js` (לא נקרא במלואו כאן) + `backend/src/sigmaIngest.js` | **Push, לא Pull** — ה-Bridge (רץ אצל דניאל מקומית) קורא מ-SQL Server וקוראQ HTTPS ל-backend בענן. Backend **אף פעם לא** נוגע ב-Sigma ישירות בסביבת production (רק `realSigmaBridge.js`/`sigmaBridgeMock.js` הישנים יותר, שלא בשימוש בפועל) |
| Auth/RBAC | `backend/src/auth.js` | JWT + 4 roles בלבד (`agent`,`warehouse`,`warehouse_manager`,`system_admin`), `requireRole()` גס ברמת route, אין permission-level granular |
| Audit | `workflow_events` (`schema.sql:117-125`) | Event log כללי (from_status/to_status/note טקסט חופשי) — **לא** מבנה ייעודי לסריקות/כמויות |
| Outbox/Inbox | **לא קיים** | אין תבנית outbox; `emitChange`/`bus.js` הוא event-emitter פנימי בתהליך יחיד, לא outbox עמיד |
| Realtime | `backend/src/bus.js` + `realtime.js` + `frontend/src/ws.js` | Broadcast גלובלי ל-**כל** הלקוחות, בלי scope. הודעה נושאת רק `{type, order_key, status?, version?}` — **בלי payload** — הלקוח תמיד עושה refetch ממוקד. זה כבר תואם את הדרישה "הפעולה לא תלויה ב-WebSocket" |
| Frontend picking UI | `frontend/src/components/PickChecklist.jsx` | mode='pick'/'check' על אותו קומפוננטה, ממוין לפי `location`, כפתורי מגע בלבד — **אין שום capture של סורק** |

### מה **כבר קיים** ורלוונטי ישירות:

1. **הפרדת Source Data מ-Operational Data כבר קיימת בפועל**, ואף תוקנה אחרי
   תקלה אמיתית: `sigmaIngest.js:38-50` — ה-`ON CONFLICT` של `insertItem`
   מעדכן **רק** שדות שמגיעים מסיגמא (`item_code, item_name, quantity,
   price, location, barcode`), ולא נוגע ב-`qty_picked/pick_status/checked`
   וכו'. התיעוד בקוד (וב-`PICKING_QC_SPEC.md` שורה 3) מספר שזו הייתה
   תקלה אמיתית (`INSERT OR REPLACE` מחק התקדמות ליקוט) — **זה בדיוק
   התרחיש שהדרישה מזהירה ממנו**, וכבר נפתר כאן פעם אחת. שווה לצטט את זה
   כתקדים לפני בניית מנגנון snapshot/version מפורש (סעיף 10 למטה).
2. **Optimistic concurrency ברמת הזמנה** כבר קיים: `workflow_state.version`
   (`schema.sql:96`), עם `assertVersion`/`ConflictError` (`workflow.js:66-70`).
   **אין** מקבילה ברמת שורת פריט (`order_items_cache` בלי `version`) —
   פער ממשי לסריקה מהירה (סעיף 5).
3. **ברקוד כבר זורם מסיגמא** דרך ה-Bridge: `pritim.barCode` → JOIN לפי
   `prit_ID+CompanyID` → `order_items_cache.barcode`, עם נפילה חזרה ל-
   `azmanot.FBarCode` (ר' `PICKING_QC_SPEC.md` סעיף 11). זה **מסונכרן
   מראש**, לא נשלף חי מסיגמא בזמן סריקה — כבר תואם את הדרישה "לא לפנות
   ל-Sigma בכל סריקה". אבל: הברקוד חי **על שורת ההזמנה**, לא על ישות
   מוצר עצמאית — ר' פער #2 למטה.
4. **מיון לפי מיקום פיזי + מסך pick/check נפרד** כבר בנוי ועובד
   (`PickChecklist.jsx`), כולל "תיקון בודק" דו-כיווני, שידור חוסר מאומת
   בין הזמנות פתוחות, והיסטוריה עם דוח חוסרים — כל זה תשתית ל-UX שהדרישה
   מבקשת, לא צריך לבנות מחדש.
5. **תגובת ה-Realtime "רזה"** (type בלבד, בלי payload) כבר עומדת בדרישה
   "הפעולה עצמה לא תלויה ב-WebSocket" — הלקוח תמיד מקבל את התוצאה
   מהתשובה הסינכרונית של ה-POST, ה-WS הוא רק טריגר לרענון של מסכים
   *אחרים*.

### מה **חסר לגמרי** (לא קיים בשום צורה):

1. **Idempotency / ClientEventId** — **אין שום מנגנון דה-דופליקציה** בכל
   המערכת. כל ה-endpoints הקיימים (`/items/:lineNo/pick` וכו') הם
   plain POST בלי מפתח ייחודי מהלקוח. retry רשת היום פשוט **יכתוב פעמיים**.
   זו **הפערה הכי קריטית** ביחס לדרישה — לא רק לסריקה, גם לכפתורי המגע
   הקיימים (אמנם שם הסיכון קטן יותר כי זה "set" לא "increment" — ר' סעיף 2).
2. **עדכון כמות הוא "SET" מוחלט, לא "INCREMENT" אטומי** —
   `updateItemPick` (`workflow.js:116-131`) עושה `UPDATE ... SET
   qty_picked = ?` עם הערך המלא שהתקבל, לא `+= delta` מוגן. זה בסדר
   גמור ל-UI מגע (המשתמש רואה ומזין כמות מוחלטת), אבל **הפוך בדיוק ממה
   שסריקה צריכה** — סריקה היא אירוע דלתא (`+1` או `+UnitsPerScan`) בלי
   שהלקוח (frontend) יודע את הכמות הכוללת הנוכחית ברגע השליחה (race עם
   סריקה אחרת/מכשיר אחר).
3. **אין Barcode→Product mapping עצמאי** — אין טבלת `ProductBarcode` עם
   `UnitsPerScan`/`IsPrimary`/סוגי ברקוד. הברקוד היום הוא עמודה שטוחה על
   שורת הזמנה בודדת. מספיק ל*תצוגה*, לא מספיק ל*resolve* (פריט אחד עם 3
   ברקודים חלופיים, ברקוד מארז=6 יח').
4. **אין PickingSession כישות** — יש רק `claimed_by` בודד על ההזמנה
   (`workflow_state.claimed_by`). אין device_id, אין started_at/completed_at
   נפרד מהמעבר הסטטוס עצמו, ואין תמיכה במושג "session" נפרד מ"סטטוס".
5. **אין Audit מובנה לסריקה** — `workflow_events` הוא free-text note.
   אין `PickEvent` מובנה עם `DeltaQuantity/PreviousQuantity/NewQuantity/
   Source/DeviceId/ClientEventId`.
6. **אין שום capture של HID/סורק ב-frontend** — לא קיים קובץ, hook, או
   event listener שקשור לקלט מקלדת/סורק.
7. **אין Verification-mode כמותי** — `updateItemCheck` הוא toggle
   בוליאני (`checked 0/1`), לא מונה `qty_verified`. סריקה בשלב בדיקה
   לא תדע "כמה כבר נסרק לאימות".
8. **RBAC גס** — 4 תפקידים בלבד, בלי permission matrix (`picking.execute`
   וכו'). לדרישה הזו זה כנראה **מספיק ל-V1** (אין כרגע "מלקט" מול "בודק"
   כתפקידים נפרדים בפועל — הערה מפורשת ב-`PICKING_QC_SPEC.md` שורה 17:
   "login משותף אחד בפועל, הפרדת התפקידים היא הליך פנימי, לא נאכפת").
9. **SQLite dev / ephemeral disk ב-Render free tier** — ה-README
   מזהיר במפורש שהדיסק לא persistent ומתאפס בכל דיפלוי. זה נכון היום
   בלי קשר לסריקה, אבל **אלפי סריקות ביום** מגדילות דרמטית את המחיר של
   "לאבד נתונים" — שווה להעלות כתלות תשתיתית נפרדת (לא בעיה שהסריקה
   יוצרת, אבל סריקה מגדילה את הדחיפות לפתור אותה).

---

## 2. Target Architecture — איך זה משתלב, לא שובר

**עיקרון מנחה:** לא לבנות שכבת domain חדשה גדולה. `workflow.js` כבר
מיישם בדיוק את העיקרון שהדרישה מבקשת ("Business logic אחד, לא נפרד
לסורק") — יש כבר **פונקציה אחת** (`updateItemPick`) שקוראת לה **route
אחד**. הבעיה היא לא היעדר abstraction, אלא שה-primitive הקיים (SET
מוחלט) לא מתאים לערוץ קלט מהיר (delta, בלי לדעת מצב נוכחי). הפתרון
הנכון הוא **להוסיף primitive חדש ברמה נמוכה יותר** (`applyPickDelta`),
ולגרום גם לכפתורי המגע הקיימים "לרדת" אליו, לא לבנות מסלול מקביל.

```
                    ┌─────────────────────────────┐
Barcode scan  ──┐   │   routes.js (HTTP boundary)  │
(HID keydown)   │   │   - auth, requireRole        │
                ├──▶│   - clientEventId required   │──▶ workflow.js
Manual button ──┘   │   POST /items/scan           │    applyPickDelta()
(existing btns)     │   POST /items/:lineNo/pick   │    (ליבה משותפת יחידה)
                     └─────────────────────────────┘         │
                                                               ▼
                                              order_items_cache (delta atomic UPDATE)
                                              pick_events (idempotency + audit)
                                                               │
                                                               ▼
                                                    emitChange() → WS (type בלבד)
```

- **מסלול ידני (הקיים)**: כפתורי "✓ ליקטתי הכל" / "כמות אחרת" / "לא נמצא"
  ממשיכים לעבוד בדיוק כמו היום מבחינת UX — אבל *מתחת למכסה המנוע* יחושבו
  כ-delta (`target - current`) ויעברו דרך אותו primitive כמו סריקה. זה
  משנה מעט את `updateItemPick` הפנימי, לא את ה-API/UX הקיים.
- **מסלול סריקה (חדש)**: endpoint חדש שמקבל ברקוד (לא lineNo), resolve
  פנימי ל-line, delta קבוע (1 או UnitsPerScan), ואותו primitive.
- **הקשר workflow קובע את הפעולה, לא סוג הקלט** — בדיוק כמו שהדרישה
  מבקשת ("Scan Event → Current Workflow Context → Command"): אם
  `workflow_state.status === 'picking'` → הסריקה מפעילה pick; אם
  `'ready_for_check'` → מפעילה verify (סעיף 6 למטה). זה טבעי כי הקוד
  הקיים **כבר** מפריד `mode='pick'`/`mode='check'` באותו קומפוננטה לפי
  סטטוס ההזמנה.

### חלוקת אחריות (לפי המבנה הקיים, לא שכבות תיאורטיות)

| שכבה | קובץ בפועל | אחריות חדשה |
|---|---|---|
| Frontend – Scanner Capture | `frontend/src/scanner/useScannerCapture.js` (חדש) | לכידת keydown ברמת מסך הליקוט, זיהוי sequence סורק מול הקלדה רגילה, יצירת `{barcode, clientEventId, timestamp}` |
| Frontend – API client | `frontend/src/api.js` (קיים, מתרחב) | `api.scanItem(orderKey, {barcode, clientEventId, deviceId})` |
| API boundary | `backend/src/routes.js` (קיים, מתרחב) | route חדש `/orders/:key/items/scan`, אימות clientEventId חובה, requireRole קיים |
| Domain/Workflow | `backend/src/workflow.js` (קיים, מתרחב) | `applyPickDelta()` — הליבה המשותפת; `resolveBarcodeToLine()`; result codes |
| Infrastructure | `backend/src/sigmaIngest.js` (קיים, ללא שינוי מהותי) | ממשיך לספק ברקוד/מיקום/כמות מסיגמא בלבד — **אינו נוגע בליקוט** |
| Sigma Read Connector | `bridge/sync.js` | ללא שינוי לצורך הסריקה עצמה — כבר מספק ברקוד |

---

## 3. מודל נתונים מוצע

### 3.1 `order_items_cache` — עמודות חדשות (לא שינוי מבנה קיים)

```sql
ALTER TABLE order_items_cache ADD COLUMN item_version INTEGER NOT NULL DEFAULT 1; -- concurrency ברמת שורה
ALTER TABLE order_items_cache ADD COLUMN qty_verified REAL; -- למצב בדיקה כמותי (סעיף 6)
```

`item_version` נדרש כי `workflow_state.version` (הקיים) הוא ברמת הזמנה
שלמה — לא עוזר לזהות התנגשות בין שתי סריקות על **אותה שורה** באותה
מילישנייה. עם ה-UPDATE המוגן (סעיף 3.3) הוא לא הכרחי מתמטית (ה-WHERE
כבר מגן), אבל שימושי לדיבוג/audit ("איזו גרסת שורה ראה הלקוח").

### 3.2 `pick_events` — טבלה חדשה (idempotency + audit מובנה)

זו התשתית **הכי חשובה** שחסרה היום — לא רק לסריקה, גם ליציבות הכללית
של כל endpoints הליקוט הקיימים.

```sql
CREATE TABLE IF NOT EXISTS pick_events (
  event_id       TEXT PRIMARY KEY,        -- uid('pev')
  client_event_id TEXT NOT NULL,          -- מהלקוח, UUID
  order_key      TEXT NOT NULL,
  line_no        INTEGER NOT NULL,
  barcode        TEXT,                    -- מה שנסרק בפועל (NULL לפעולה ידנית)
  delta_qty      REAL NOT NULL,
  previous_qty   REAL NOT NULL,
  new_qty        REAL NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('scanner','manual','correction','supervisor_override','system')),
  result_code    TEXT NOT NULL,           -- ACCEPTED | OVER_PICK | ... (סעיף 5)
  user_id        TEXT,
  device_id      TEXT,
  picking_session_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_key, client_event_id)     -- מפתח הדה-דופליקציה
);
CREATE INDEX IF NOT EXISTS idx_pick_events_order ON pick_events(order_key, line_no);
```

**דה-דופליקציה לפי `client_event_id`, לא לפי ברקוד+זמן** — בדיוק לפי
הדרישה. `INSERT OR IGNORE` על ה-UNIQUE: אם 0 שורות נוספו → זה replay,
מחזירים את `result_code`/`new_qty` הקיימים באותה שורה בלי לגעת בכמות
שוב.

### 3.3 עדכון אטומי (מחליף SET מוחלט ל-delta מוגן)

```sql
UPDATE order_items_cache
SET qty_picked = COALESCE(qty_picked, 0) + @delta,
    item_version = item_version + 1,
    pick_marked_at = datetime('now')
WHERE order_key = @order_key AND line_no = @line_no
  AND COALESCE(qty_picked, 0) + @delta <= quantity   -- מונע OVER_PICK בשכבת ה-DB עצמה
```

אם `changes === 0` — יש לבדוק בנפרד *למה* (השורה לא קיימת / ההזמנה כבר
לא ב-picking / חריגה מהכמות) כדי להחזיר result code מדויק, לא סתם שגיאה
גנרית. שימו לב: **better-sqlite3 סינכרוני על תהליך יחיד** (כפי שמוגדר
היום ב-`db.js`) כבר נותן סריאליזציה חינם בין קריאות מקבילות מאותו
תהליך Node — ה-WHERE המוגן הוא בעיקר correctness+תיעוד-כוונה ותאימות
קדימה ל-Postgres/multi-instance (README כבר מציין כיוון מעבר ל-Postgres
לפרודקשן), לא הגנה קריטית בארכיטקטורה הנוכחית כשלעצמה.

### 3.4 `product_barcodes` — טבלה חדשה, מסונכרנת כמו `item_suppliers`

היום ברקוד חי רק על שורת הזמנה ספציפית. לצורך `UnitsPerScan` וברקודים
חלופיים (שני ברקודים לאותו פריט), נדרש מקור אמת נפרד מהקטלוג — **לא
משיכה חיה מסיגמא**, אלא סנכרון איטי כמו שכבר קיים היום ל-`item_suppliers`
(`sigmaIngest.js:253-269`, "קטלוג שמשתנה לאט... לא בכל סבב").

```sql
CREATE TABLE IF NOT EXISTS product_barcodes (
  item_code      TEXT NOT NULL,
  barcode        TEXT NOT NULL,
  units_per_scan REAL NOT NULL DEFAULT 1,
  is_primary     INTEGER NOT NULL DEFAULT 1,
  is_active      INTEGER NOT NULL DEFAULT 1,
  synced_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_code, barcode)
);
```

**חשוב:** קודם צריך לברר מול סיגמא אם `pritim` בכלל מחזיק יותר מברקוד
אחד לפריט ו/או שדה "יחידות באריזה" — כרגע `bridge/sync.js` מושך רק
`barCode` יחיד (ר' `PICKING_QC_SPEC.md` סעיף 11). **אם בפועל תמיד יש
ברקוד יחיד = יחידה אחת** (המצב הנפוץ אצל SMB ישראלי בלי ניהול ברקוד
היררכי), הטבלה הזו וה-UnitsPerScan הופכים ל-**over-engineering ל-V1** —
מומלץ לבדוק את זה מול הנתון האמיתי בסיגמא *לפני* שבונים את הטבלה, ולא
להניח.

### 3.5 `picking_sessions` — טבלה חדשה, קלה, נגזרת מהקיים

לא ישות כבדה — עוטפת את המעבר הקיים ל-`picking`:

```sql
CREATE TABLE IF NOT EXISTS picking_sessions (
  session_id   TEXT PRIMARY KEY,
  order_key    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  device_id    TEXT,
  mode         TEXT NOT NULL DEFAULT 'picking', -- picking | verification
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
```

נוצרת ב-`claimOrder` (כבר קיים, `workflow.js:100-111`), נסגרת
ב-`finishPicking`/`finishCheck`. `workflow_state` מקבל עמודה
`active_picking_session_id` כדי שה-endpoint של סריקה ידע לאיזו session
לשייך את `pick_events.picking_session_id`, ויוכל לבדוק
`PICKING_SESSION_NOT_ACTIVE`.

---

## 4. Contracts / Commands / Result Codes

לפי מוסכמות ה-routes הקיימות (`POST /orders/:key/...`, לא RPC style):

```
POST /orders/:key/items/scan
Body: { barcode: string, clientEventId: string, deviceId?: string }
```

למה **בלי lineNo** (בשונה מ-`/items/:lineNo/pick` הקיים) — כי סריקה לא
יודעת מראש איזו שורה, זה בדיוק התפקיד של resolve בצד השרת.

תגובה — **delta בלבד**, לא ההזמנה כולה (לפי הדרישה במפורש):

```json
{
  "resultCode": "ACCEPTED",
  "lineNo": 3,
  "itemCode": "18813",
  "qtyPicked": 4,
  "quantity": 6,
  "remaining": 2,
  "lineCompleted": false,
  "orderProgress": { "done": 5, "total": 8 }
}
```

Result codes (בדיוק לפי הרשימה בדרישה, ממופים לתנאים שכבר קיימים
בקוד הנוכחי):

| קוד | מתי (מיפוי לבדיקות קיימות ב-workflow.js) |
|---|---|
| `ACCEPTED` | UPDATE הצליח, לא הושלמה שורה/הזמנה |
| `ITEM_COMPLETED` | `new_qty === quantity` |
| `ORDER_COMPLETED` | כל השורות `pick_status IS NOT NULL` (כמו הבדיקה הקיימת ב-`finishPicking`, `workflow.js:139-142`) |
| `NOT_IN_ORDER` | ברקוד לא תואם לאף שורה פתוחה בהזמנה הנוכחית |
| `UNKNOWN_BARCODE` | ברקוד לא נמצא גם ב-`product_barcodes` וגם לא כ-fallback על שורת ההזמנה |
| `OVER_PICK` | ה-UPDATE המוגן (סעיף 3.3) החזיר 0 שורות בגלל חריגה מהכמות |
| `ORDER_CLOSED` | `state.status` לא פעיל (כמו `ACTIVE_STATUSES`, `workflow.js:28`) |
| `PICKING_SESSION_NOT_ACTIVE` | `state.status !== 'picking'` (המקבילה ל-check הקיים ב-`updateItemPick`, שורה 119) |
| `CONFLICT` | (בעיקר תיאורטי לאור סעיף 3.3, שמור לתאימות Postgres עתידית) |
| `DUPLICATE_SCAN` | `pick_events` UNIQUE violation → replay מזוהה |
| `ERROR` | כל שגיאה לא צפויה |

### Domain events (לא outbox פורמלי — אין תשתית כזו היום)

אין תבנית Outbox בקוד הקיים בכלל (`bus.js` הוא event-emitter פנימי
בתהליך יחיד, לא persisted). **לא ממליץ לבנות Outbox מלא רק בשביל
הסריקה** — over-engineering ביחס לגודל המערכת (שרת יחיד, SQLite, בלי
consumers חיצוניים אמיתיים כרגע חוץ מ-WebSocket הפנימי). ה-`emitChange`
הקיים מספיק כ"Domain Event" קליל: `emitChange('order_item_picked', {
order_key, line_no, source })`. אם בעתיד יתווספו consumers אמיתיים
(shipping workflow, analytics חיצוני) — זה הרגע לשקול outbox אמיתי, לא
עכשיו מראש.

---

## 5. HID ב-Web/PWA — איך זה יעבוד בפועל

אין תלות בספריית סורק. Bluetooth HID scanner מתנהג כמקלדת חיצונית —
שולח keydown events לדפדפן בדיוק כמו הקלדה, ואז Enter.

```js
// frontend/src/scanner/useScannerCapture.js (קובץ חדש)
// עקרון: מאזינים ברמת window כשמסך הליקוט פעיל, לא ברמת <input> יחיד.
// זיהוי "זה סורק ולא הקלדה" לפי מהירות בין תווים — סורק שולח תווים
// ב-<30-50ms זה מזה; הקלדת אדם איטית בהרבה.
```

עקרונות מרכזיים (ליישום בפועל, לא בשלב הזה):

1. **Listener על `window`, לא על input ממוקד** — כך שהעובד לא צריך
   "ללחוץ קודם על שדה". פעיל רק כשמסך `PickChecklist` מורכב (mount/unmount).
2. **סינון מפני הקלדה רגילה**: אם `document.activeElement` הוא input/textarea
   אמיתי בטופס עריכה פתוח (למשל שדה "הערה" הקיים ב-`editingLine`,
   `PickChecklist.jsx:188-192`) — **לא ללכוד**, לתת להקלדה הרגילה לעבוד.
   זו בדיוק הדרישה "לא להפריע להקלדה רגילה", וגם נמנעת מקונפליקט עם
   שדות הטופס הקיימים באותו מסך.
3. **buffer + timeout**: צובר תווים, מאפס אם המרווח בין תווים גדול מדי
   (זה לא סורק), שולח `BarcodeScanned` ב-Enter/CR או timeout קצר של
   שקט (fallback לסורקים בלי terminator).
4. **בלי focus trap / בלי input מוסתר** — לא לדרוש "שדה סתר" שממוקד
   כל הזמן; זה שביר (נעלם focus כשנפתח modal/עריכה).

### שלב 2 (Native) — לא עכשיו

הפרויקט הוא **PWA טהור היום** (Vite build, Vercel hosting, בלי שום
מעטפת native/Capacitor קיימת). המלצה: **HID לבד מספיק ל-V1 ואפילו
ל-V2 המלא** (אלפי סריקות/יום זה בדיוק תרחיש הליבה של סורקי Bluetooth
HID מקצועיים — הם *נבנו* בשביל זה, בלי שום SDK). Native wrapper
(Capacitor) מוצדק רק אם יתעורר צורך קונקרטי ב-battery level/trigger
button/beep-LED מתוכנת — לא "כי אפשר". להוסיף מעטפת native כרגע פירוש
דבר: pipeline build נוסף, חתימות iOS/Android, ותחזוקה — עלות אמיתית
מול תועלת לא מוכחת. **דחייה מומלצת ל-Phase מאוחר, גזורה על ידי ראיה
תפעולית**, לא על בסיס תיאורטי.

---

## 6. Verification/Packing mode — כבר כמעט קיים

זו הנקודה שבה הקוד הקיים **הכי קרוב** למה שהדרישה מבקשת: יש כבר הפרדה
מלאה בין `mode='pick'` ל-`mode='check'` על אותו קומפוננטה
(`PickChecklist.jsx:17`), נגזרת מ-`workflow_state.status`
(`'picking'` מול `'ready_for_check'`). כל מה שחסר הוא:

1. להפוך `updateItemCheck` (בוליאני, `workflow.js:150-165`) לכמותי —
   הוספת `qty_verified` (סעיף 3.1), כדי שסריקה בשלב בדיקה תוכל לצבור
   ולא רק לסמן "מאושר/לא".
2. ב-endpoint הסריקה החדש (`/items/scan`) — dispatch לפי
   `workflow_state.status`: `picking` → `applyPickDelta` על `qty_picked`;
   `ready_for_check` → פעולה מקבילה על `qty_verified`. זו בדיוק
   "Scan Event → Current Workflow Context → Command" שהדרישה מבקשת,
   וזה נובע **טבעית** מהמבנה הקיים, לא תוספת זרה.

**המלצה:** Phase הזה זול משמעותית מ-Native wrapper (סעיף 5) כי הוא
בעיקר מרחיב קוד קיים. הייתי מזיז אותו **לפני** Native בסדר העדיפויות
(ר' סעיף 8) — לא אחריו כמו בטיוטה המקורית.

---

## 7. הגבול Sigma ↔ SmartCycle/Aladin — כבר קיים, רק לחדד

| נתון | מקור | היום בקוד |
|---|---|---|
| OrderedQty (`quantity`) | Sigma | `order_items_cache.quantity`, מתעדכן בכל סנכרון |
| ברקוד/מיקום קטלוגי | Sigma (`pritim`) | `order_items_cache.barcode/location`, מתעדכן בכל סנכרון |
| PickedQty/pick_status/checked | **SmartCycle בלבד** | `order_items_cache.*`, **מוגן** מדריסה בסנכרון (`sigmaIngest.js:38-42`) |
| Scan events / audit | **SmartCycle בלבד** | חדש: `pick_events` |
| PickingSession/Device | **SmartCycle בלבד** | חדש: `picking_sessions` |

**אין Back Sync ל-Sigma בשום מקום בקוד הקיים** — מאומת: אין קריאת
`INSERT`/`UPDATE` על ה-Sigma DB בשום קובץ backend פעיל (`realSigmaBridge.js`
שמכיל לוגיקת חיבור ל-SQL Server הוא read-only גם הוא, ולא בשימוש
בפרודקשן ממילא — ה-Bridge push הוא המנגנון האמיתי). זה תואם 1:1 את
העיקרון "SmartCycle לא כותבת ל-Sigma בשום מצב" — **אין צורך לשנות כלום
כאן**, רק לשמר את המשמעת הזו גם בקוד החדש (endpoint הסריקה לא נוגע
בשום קריאה לסיגמא, לא pull ולא push).

---

## 8. שינוי הזמנה בסיגמא אחרי שהתחיל ליקוט — מצב קיים + פער

**מה שכבר עובד (ומאומת end-to-end):**
- שורה שנעלמת לגמרי מסיגמא (שורשרה לחשבונית) — נמחקת מה-cache, וגם אם
  ההזמנה כבר בעבודה פעילה, `reconcileOpenOrders`
  (`sigmaIngest.js:127-168`) מזהה שההזמנה כולה נעלמה ומעביר אותה
  ל-`on_hold` עם `hold_reason` מסביר, **לא** סוגר בשקט ו**לא** משאיר
  תקוע. זה תרחיש שכבר קרה בפועל (הזמנה 192821, מתועד ב-`PICKING_QC_SPEC.md`
  סעיף 11.2) ותוקן.

**מה שעדיין חסר (פער אמיתי ביחס לדרישה):** התרחיש הספציפי שהדרישה
מתארת — **לא** שהשורה נעלמת, אלא ש-`quantity` **משתנה** (10→8) בזמן
שכבר יש `qty_picked` קיים על אותה שורה. `insertItem`
(`sigmaIngest.js:43-50`) היום פשוט **כותב את הכמות החדשה בלי לבדוק אם
כבר יש ליקוט על השורה** — אין conflict detection, אין snapshot/version
של הכמות המקורית, ואין שום פעולה מיוחדת אם `qty_picked > quantity`
החדש (למשל אחרי שכבר נסרקו 6 מתוך 10, וההזמנה עודכנה ל-8 — אין בעיה;
אבל אם עודכנה ל-5, יש כבר `qty_picked=6 > quantity=5` ותקוע במצב לא
עקבי בלי שאף אחד יודע).

**המלצה קונקרטית (מוסיפה ל-`insertItem` הקיים, לא מחליפה אותו):**

```
אם quantity חדש != quantity ישן AND qty_picked IS NOT NULL:
  אם qty_picked <= quantity_חדש:
    לעדכן quantity בשקט (אין התנגשות אמיתית) + לרשום workflow_event
    אינפורמטיבי ("כמות ההזמנה השתנתה מ-X ל-Y אחרי שכבר לוקטו Z יח'")
  אם qty_picked > quantity_חדש:
    *לא* לדרוס אוטומטית — להעביר את ההזמנה ל-on_hold (בדיוק כמו
    reconcileOpenOrders עושה היום לתרחיש "נעלמה לגמרי"), עם hold_reason
    מפורש: "כמות שהוזמנה ירדה מתחת למה שכבר נלקט — נדרשת החלטת מנהל".
    זה עקבי לגמרי עם התבנית הקיימת של on_hold, לא מנגנון חדש.
```

זו הרחבה קטנה וממוקדת של `sigmaIngest.js`, לא ארכיטקטורה חדשה — משתמשת
באותו `on_hold` panel שכבר קיים וכבר מוכר למשתמשים.

---

## 9. סיכונים

1. **Multi-tenant gap (סעיף 0)** — הכי גדול. אם "SmartCycle" אמיתי
   (למכור לחברות אחרות) הוא כיוון קרוב, כדאי להחליט על זה **לפני**
   שממשיכים — זה משנה יסודות (auth, realtime, כל טבלה) בצורה שקשה
   לעשות רטרואקטיבית זול יותר ככל שנדחה.
2. **login משותף למלקטים** (`PICKING_QC_SPEC.md` שורה 17) — "מי סרק
   מה" ברמת `user_id` יהיה לא מדויק אם כמה עובדים חולקים יוזר "מחסן"
   אחד. `device_id` (מהמכשיר הפיזי שסרק) הוא בפועל **אינדיקטור זהות
   מדויק יותר** מ-`user_id` בהקשר הזה — כדאי לתכנן את האודיט כך
   שה-device הוא שדה חובה, לא אופציונלי, גם אם ה-user תמיד יהיה אותו
   יוזר משותף.
3. **SQLite + Render free tier ephemeral disk** — כבר מתועד ב-README
   כמגבלה קיימת; אלפי אירועי `pick_events` ביום מגדילים את מחיר האובדן
   אם השירות נופל/נפרס מחדש. לא בעיה שהסריקה יוצרת, אבל דוחפת את
   הדחיפות של מעבר ל-Postgres persistent (שכבר מתוכנן לפי הסכימה —
   "יעד production: PostgreSQL", `schema.sql:1`) קדימה בזמן.
4. **`product_barcodes`/`UnitsPerScan` עלולים להיות over-engineering** —
   צריך לאמת מול סיגמא בפועל (כמו שכבר נעשה לברקוד הבסיסי, שני סבבי
   בירור לפי `PICKING_QC_SPEC.md` סעיף 11) אם יש בכלל יותר מברקוד יחיד
   ליחידה בקטלוג של אלדין, לפני שבונים תשתית לתרחיש שאולי לא קיים אצל
   הלקוח הזה בפועל.
5. **WS broadcast גלובלי** (`realtime.js:16`) — היום כל שינוי משודר
   לכל הלקוחות המחוברים בלי הבחנה. באלפי סריקות ביום, אם כל סריקה
   שולחת `emitChange`, זה אלפי הודעות WS ליום לכל מסך פתוח (כולל מסכי
   סוכנים/מנהל שלא קשורים להזמנה הספציפית). כדאי לשקול לצמצם תדירות
   (debounce ברמת order_key) או לפחות לוודא שהודעה בגודל קבוע וזול
   לשדר (כבר המצב היום — `{type, order_key}` בלבד, לא payload).

---

## 10. Rollout מוצע (עם שינוי סדר מהטיוטה המקורית)

מסכים עם רוב החלוקה שהוצעה, עם שני שינויים: (א) Phase תשתיתי-0 שקודם
לכל UI כי הוא נדרש גם למסך הקיים, לא רק לסריקה; (ב) Verification mode
(זול, כמעט קיים) **לפני** Native wrapper (יקר, לא מוכח כנדרש) — לא
אחריו.

| Phase | תוכן | תלות |
|---|---|---|
| **0 — תשתית** | `pick_events` (idempotency+audit) + הפיכת `updateItemPick` הקיים ל-delta-based מתחת למכסה המנוע, בלי לשנות UX קיים | — |
| **1 — Domain/API לסריקה** | `applyPickDelta`, `resolveBarcodeToLine`, endpoint `/items/scan`, result codes | Phase 0 |
| **2 — Generic HID capture** | `useScannerCapture` hook, Scan Mode screen נקי, feedback צליל/צבע מיידי בלי popup | Phase 1 |
| **3 — Verification mode כמותי** | `qty_verified`, dispatch לפי `workflow_state.status`, מסך בדיקה מקביל | Phase 1 (לא תלוי ב-2!) |
| **4 — ביצועים/עומס** | stress test (20-50 סריקות/שניות ממכשיר בודד, עומס מקבילי), טיפול ב-OFFLINE/CONNECTION LOST | Phase 2 |
| **5 — Native wrapper** | רק אם מתגלה צורך קונקרטי (battery/trigger/beep SDK) — Capacitor, thin bridge בלבד | לפי צורך מוכח בפועל |

Phase 3 (Verification) יכול לרוץ **במקביל** ל-Phase 2 (HID) כי הם לא
תלויים זה בזה — שניהם תלויים רק ב-Phase 1.

---

## 11. סיכום — מה לעשות עכשיו, לא לעשות עדיין

**לעשות (עם אישורך):**
- להחליט על שאלת ה-multi-tenant (סעיף 0) — זו השאלה הכי משפיעה על כל
  החלטה אחרת במסמך הזה.
- לאמת מול סיגמא: יש יותר מברקוד יחיד לפריט? יש UnitsPerScan אמיתי
  בקטלוג? (כמו הבירור הקיים שכבר נעשה לברקוד הבסיסי).
- Phase 0 (idempotency) הוא שווה-ערך גם בלי סריקה בכלל — משפר את
  ה-endpoints הידניים הקיימים.

**לא לעשות (עדיין):**
- Outbox פורמלי, permission matrix מלא, Native wrapper, multi-tenant
  מלא — כולם over-engineering ביחס לגודל הבעיה הנוכחית עד שיש ראיה
  קונקרטית שהם נדרשים.
