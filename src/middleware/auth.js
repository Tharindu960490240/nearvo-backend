import jwt from 'jsonwebtoken';
import { query } from '../db.js';

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// Checks the token, then the account itself, so a suspended or deleted account (or a log-in from
// before a password change) stops working straight away instead of when the token expires.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in to continue' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Your session has expired, please log in again' });
  }
  const { rows } = await query('SELECT id, name, role, suspended_at, password_changed_at FROM users WHERE id = $1', [payload.id]);
  const u = rows[0];
  if (!u) return res.status(401).json({ error: 'This account no longer exists', code: 'ACCOUNT_GONE' });
  if (u.suspended_at) return res.status(403).json({ error: SUSPENDED_MESSAGE, code: 'ACCOUNT_SUSPENDED' });
  if (u.password_changed_at && payload.iat < Math.floor(new Date(u.password_changed_at).getTime() / 1000)) {
    return res.status(401).json({ error: 'Your password was changed. Please log in again.', code: 'PASSWORD_CHANGED' });
  }
  req.user = { id: u.id, role: u.role, name: u.name };
  next();
}

export const SUSPENDED_MESSAGE = 'This account has been suspended. If you think this is a mistake, please contact us.';

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'You do not have access to this' });

// Checked against the database so a freshly confirmed email works without logging in again.
export async function requireVerifiedEmail(req, res, next) {
  const { rows } = await query('SELECT email_verified_at FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(401).json({ error: 'Account not found' });
  if (!rows[0].email_verified_at) {
    return res.status(403).json({ error: 'Please confirm your email address first (check your inbox)', code: 'EMAIL_NOT_VERIFIED' });
  }
  next();
}
