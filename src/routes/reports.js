// POST /api/reports - anyone (logged in or not) can report a review, tradie profile or job.
// This is the "accessible complaints mechanism" referred to in the 2024 defamation reforms.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { notify } from '../lib/mailer.js';

const router = Router();
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many reports from this connection. Please email us instead.' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPES = ['review', 'tradie', 'job', 'other'];
const REASONS = ['defamatory', 'fake', 'offensive', 'scam', 'privacy', 'other'];
const appUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0];

function optionalUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try { return jwt.verify(h.slice(7), process.env.JWT_SECRET); } catch { return null; }
}

router.post('/', limiter, async (req, res) => {
  const user = optionalUser(req);
  const targetType = TYPES.includes(req.body.target_type) ? req.body.target_type : 'other';
  const targetId = parseInt(req.body.target_id, 10) || null;
  const reason = REASONS.includes(req.body.reason) ? req.body.reason : null;
  const details = String(req.body.details || '').trim();
  let name = String(req.body.name || '').trim();
  let email = String(req.body.email || '').trim().toLowerCase();

  if (user) {
    const u = (await query('SELECT name, email FROM users WHERE id = $1', [user.id])).rows[0];
    if (u) { name = name || u.name; email = email || u.email; }
  }
  if (!reason) return res.status(400).json({ error: 'Please choose a reason' });
  if (details.length < 15) return res.status(400).json({ error: 'Please tell us what the problem is (at least 15 characters)' });
  if (details.length > 4000) return res.status(400).json({ error: 'Please keep your report under 4000 characters' });
  if (!name) return res.status(400).json({ error: 'Please enter your name' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter an email address so we can reply' });
  if (targetType !== 'other' && !targetId) return res.status(400).json({ error: 'Missing item to report' });

  const { rows } = await query(
    `INSERT INTO reports (target_type, target_id, reason, details, reporter_id, reporter_name, reporter_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [targetType, targetId, reason, details, user?.id || null, name.slice(0, 100), email]
  );

  if (process.env.ADMIN_EMAIL) {
    notify(process.env.ADMIN_EMAIL, `[Nearvo] New report #${rows[0].id}: ${reason} ${targetType}`,
      `A new report needs a look (aim to act within 7 days).\n\nType: ${targetType} ${targetId || ''}\nReason: ${reason}\nFrom: ${name} <${email}>\n\n${details}\n\nReview it: ${appUrl()}/admin`);
  }
  notify(email, `We received your report (#${rows[0].id})`,
    `Hi ${name},\n\nThanks for letting us know. We'll review your report and get back to you, usually within 7 days.\n\nYour report:\n${details}\n\nNearvo`);
  res.status(201).json({ id: rows[0].id });
});

export default router;
