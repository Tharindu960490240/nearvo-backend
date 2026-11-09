import jwt from 'jsonwebtoken';
import { query } from '../db.js';

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in to continue' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired, please log in again' });
  }
}

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
