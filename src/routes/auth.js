import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { sendVerificationEmail } from '../lib/mailer.js';
import { normaliseAuPhone } from '../australia.js';
import { abrColumns, lookupBusinessNumber } from '../lib/abr.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, please try again in a few minutes' } });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function getMe(userId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.email_verified_at IS NOT NULL AS email_verified, u.created_at,
            tp.business_name, tp.photo_url, tp.suburb_id IS NOT NULL AS has_base, tp.suspended_at IS NOT NULL AS suspended,
            tp.abn_verified_at IS NOT NULL AS abn_verified,
            (SELECT COUNT(*)::int FROM tradie_services ts WHERE ts.tradie_id = u.id) AS service_count
     FROM users u LEFT JOIN tradie_profiles tp ON tp.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) return null;
  if (u.role === 'tradie') u.profile_complete = u.has_base && u.service_count > 0 && u.abn_verified;
  return u;
}

async function issueEmailToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `UPDATE users SET email_token_hash = $1, email_token_expires = now() + interval '24 hours' WHERE id = $2`,
    [sha256(token), user.id]
  );
  await sendVerificationEmail(user, token);
}

router.post('/register', limiter, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'tradie' ? 'tradie' : 'customer';
  let phone = String(req.body.phone || '').trim() || null;

  if (req.body.accept_terms !== true) return res.status(400).json({ error: 'Please agree to the Terms of Use and Privacy Policy' });
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (phone) {
    phone = normaliseAuPhone(phone);
    if (!phone) return res.status(400).json({ error: 'Please enter an Australian phone number, e.g. 0412 345 678' });
  }
  if (role === 'tradie' && !phone) return res.status(400).json({ error: 'Tradies need a mobile number so hired customers can reach them' });

  const exists = await query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (exists.rowCount) return res.status(409).json({ error: 'An account with this email already exists' });

  // Tradies must have an active ABN (or an ACN linked to one), checked with ABN Lookup before the account is created.
  let abr = null;
  if (role === 'tradie') {
    if (!String(req.body.abn || '').trim()) return res.status(400).json({ error: 'Please enter your ABN or ACN', code: 'ABN_FORMAT' });
    try {
      abr = await lookupBusinessNumber(req.body.abn);
    } catch (err) {
      if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
      throw err;
    }
    const dupe = abr.abn ? await query('SELECT 1 FROM tradie_profiles WHERE abn = $1', [abr.abn]) : { rowCount: 0 };
    if (dupe.rowCount) return res.status(409).json({ error: 'A tradie account with this ABN already exists. Try logging in instead.', code: 'ABN_TAKEN' });
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    'INSERT INTO users (name, email, password_hash, phone, role, terms_accepted_at) VALUES ($1, $2, $3, $4, $5, now()) RETURNING id, name, email, role',
    [name, email, hash, phone, role]
  );
  const user = rows[0];
  if (role === 'tradie') {
    const c = abrColumns(abr);
    const businessName = String(req.body.business_name || '').trim() || abr.business_names[0] || abr.entity_name || name;
    await query(
      `INSERT INTO tradie_profiles (user_id, business_name, abn, acn, abn_entity_name, abn_status, abn_gst_registered, abn_check, abn_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [user.id, businessName.slice(0, 150), c.abn, c.acn, c.abn_entity_name, c.abn_status, c.abn_gst_registered, c.abn_check]
    );
  }
  await issueEmailToken(user);
  res.status(201).json({ token: signToken(user), user: await getMe(user.id) });
});

router.post('/login', limiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: await getMe(user.id) });
});

router.get('/me', requireAuth, async (req, res) => {
  const me = await getMe(req.user.id);
  if (!me) return res.status(404).json({ error: 'User not found' });
  res.json({ user: me });
});

router.post('/verify-email', limiter, async (req, res) => {
  const token = String(req.body.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'This confirmation link is invalid' });
  const { rows } = await query(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), email_token_hash = NULL, email_token_expires = NULL
     WHERE email_token_hash = $1 AND email_token_expires > now()
     RETURNING id`,
    [sha256(token)]
  );
  if (!rows[0]) return res.status(400).json({ error: 'This confirmation link is invalid or has expired. Log in and request a new one.' });
  res.json({ ok: true });
});

router.post('/resend-verification', limiter, requireAuth, async (req, res) => {
  const { rows } = await query('SELECT id, name, email, email_verified_at FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  if (rows[0].email_verified_at) return res.json({ ok: true, already: true });
  await issueEmailToken(rows[0]);
  res.json({ ok: true });
});

router.put('/me', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  let phone = String(req.body.phone || '').trim() || null;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (phone) {
    phone = normaliseAuPhone(phone);
    if (!phone) return res.status(400).json({ error: 'Please enter an Australian phone number' });
  }
  await query('UPDATE users SET name = $1, phone = $2 WHERE id = $3', [name, phone, req.user.id]);
  res.json({ user: await getMe(req.user.id) });
});

export default router;
