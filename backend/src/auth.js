const jwt = require('jsonwebtoken');
const { db } = require('./db');

// MOCK: סוד קבוע לדמו בלבד. בפרודקשן — בכספת סודות, לא בקוד.
const JWT_SECRET = process.env.JWT_SECRET || 'aladin-dev-secret-do-not-use-in-prod';

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user || user.password !== password) return null;
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

module.exports = { login, authMiddleware, requireRole, JWT_SECRET };
