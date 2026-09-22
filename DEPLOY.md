# איך מעדכנים את השרת (Cloudways) אחרי שינוי קוד

התהליך הזה רלוונטי בכל פעם שיש קוד חדש ב-GitHub (למשל אחרי ששיחה כאן ב-Claude
Code עשתה `git push`) שצריך להגיע לאתר החי `https://orders.aladincorp.com`.

**חשוב**: קוד חדש שנדחף (push) ל-GitHub לא מגיע לבד לשרת. יש שני שלבים נפרדים:
1. Push ל-GitHub (כבר קורה אוטומטית בסוף כל שיחה שמבצעת שינוי קוד).
2. **Pull** מהשרת — זה השלב הידני שמתואר כאן.

## שלב 0 — להתחבר לשרת (עושים פעם אחת בכל session עבודה)

```bash
ssh daniel@159.223.9.37
```
(סיסמה מ-Cloudways Access Details → SSH/SFTP Details)

## שלב 1 — למשוך את הקוד החדש

```bash
cd ~/private_html/repo
git pull origin main
```

⚠️ שים לב: זה מושך מהענף `main` ב-GitHub. אם עבדתם על ענף אחר (למשל
`claude/...`) — הוא צריך קודם להתמזג (merge / Pull Request) לתוך `main`
ב-GitHub לפני שה-`pull` הזה יראה אותו.

## שלב 2 — אם יש שינוי ב-backend (הקבצים תחת `backend/src/`)

```bash
cd ~/private_html/repo/backend
npm install --cache ~/private_html/.npm-cache   # רק אם package.json השתנה
export PM2_HOME=~/private_html/.pm2
export PATH=~/private_html/tools/node_modules/.bin:$PATH
pm2 restart aladin-backend
pm2 logs aladin-backend --lines 20 --nostream    # לוודא שעלה בלי שגיאות
```

## שלב 3 — אם יש שינוי ב-frontend (הקבצים תחת `frontend/src/`)

⚠️ **זה שלב שעוד לא בוצע היום** — אם עדכנתם קוד frontend, הוא **לא** יופיע
באתר עד שתעשו את זה:

```bash
cd ~/private_html/repo/frontend
npm install --cache ~/private_html/.npm-cache
VITE_API_BASE=https://orders.aladincorp.com npm run build
cp -r dist/* ~/public_html/
```

## שלב 4 — אם יש שינוי ב-bridge/.env או ב-backend/.env

עריכת `.env` בלבד לא מספיקה — צריך גם להפעיל מחדש:
- `backend/.env` (בשרת): `pm2 restart aladin-backend` (כמו בשלב 2).
- `bridge/.env` (במחשב במשרד): להפעיל מחדש את שירות "Aladin Sigma Bridge"
  (או `Ctrl+C` + `npm start` אם רץ ידנית מהתיקייה `bridge/`).

## בדיקה מהירה שהכול תקין אחרי עדכון

1. `https://orders.aladincorp.com` → "עוד" → "כלי ניהול" → כרטיס Sigma —
   אמור להראות "Bridge מקומי מחובר" וזמן סנכרון עדכני.
2. טאב "הזמנות" — אמורות להיות הזמנות אמיתיות, לא דמו.

## הערה על תהליך אוטומטי יותר (לעתיד)

אפשר להגדיר GitHub Action שיעשה את שלבים 1-2 אוטומטית בכל push ל-`main`
(בלי להתחבר ידנית ב-SSH בכלל). זה דורש הגדרה חד-פעמית עם פרטי ה-SSH
שמורים כ-secret מוצפן ב-GitHub. אם תרצו — זה משתלם במיוחד אם עדכונים
קורים הרבה.
