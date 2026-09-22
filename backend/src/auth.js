const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

// תיקון אבטחה (בקשת דניאל 22.9.2026): סיסמאות לא נשמרות יותר כטקסט גלוי.
// hashPassword משמש בכל מקום שכותב סיסמה (יצירת/עדכון משתמש, seed).
// isHashed מזהה אם ערך קיים כבר עבר גיבוב (מתחיל ב-$2a$/$2b$/$2y$, הפורמט
// הסטנדרטי של bcrypt) — כדי להבדיל בין משתמשים שכבר הועברו לבין חשבונות
// ישנים שעדיין שומרים טקסט גלוי מלפני התיקון הזה.
function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}
function isHashed(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

// תיקון אבטחה (סקירה 14.9.2026): הסוד הקבוע הישן ('aladin-dev-secret-do-not-use-in-prod')
// היה גלוי בקוד/בהיסטוריית git — אם JWT_SECRET לא הוגדר בסביבה (משתנה סביבה חסר,
// שירות Render חדש, וכו'), כל אחד שמכיר את המחרוזת הזו יכול לזייף טוקן admin תקין.
// עכשיו: אם לא הוגדר JWT_SECRET, מייצרים סוד אקראי חד-פעמי לכל הפעלת תהליך —
// אין יותר נפילה למחרוזת ציבורית ידועה. המשמעות היחידה: אם השרת יופעל מחדש בלי
// JWT_SECRET מוגדר, טוקנים ישנים לא ימשיכו לעבוד (התנתקות, לא פרצת אבטחה).
if (!process.env.JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.warn('[אבטחה] JWT_SECRET לא מוגדר בסביבה — משתמש בסוד אקראי חד-פעמי לתהליך זה בלבד.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user) return null;

  if (isHashed(user.password)) {
    if (!bcrypt.compareSync(password, user.password)) return null;
  } else {
    // חשבון ישן מלפני המעבר ל-hash — עדיין טקסט גלוי. אם הסיסמה נכונה,
    // מגבבים ושומרים עכשיו (מעבר הדרגתי, בלי צורך ב-migration נפרד לכל
    // המשתמשים בבת אחת). ר' בקשת דניאל 22.9.2026.
    if (user.password !== password) return null;
    db.prepare('UPDATE users SET password = ? WHERE user_id = ?').run(hashPassword(password), user.user_id);
  }

  const token = jwt.sign(
    { sub: user.user_id, role: user.role, name: user.display_name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  return { token, user: { id: user.user_id, name: user.display_name, role: user.role } };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role, name: payload.name };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'טוקן לא תקין' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'אין הרשאה לפעולה זו' });
    }
    next();
  };
}

module.exports = { login, authMiddleware, requireRole, JWT_SECRET, hashPassword };
