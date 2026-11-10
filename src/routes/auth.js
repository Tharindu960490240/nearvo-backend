import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { requireAuth, signToken, SUSPENDED_MESSAGE } from '../middleware/auth.js';
import { notify, sendPasswordResetEmail, sendVerificationEmail } from '../lib/mailer.js';
import { passwordProblem } from '../lib/passwords.js';
import { recomputeRatingSql } from '../lib/tradieQuery.js';
import { removePhoto } from '../lib/uploads.js';
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

export async function issueEmailToken(user) {
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
  const weak = passwordProblem(password);
  if (weak) return res.status(400).json({ error: weak });
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
  if (user.suspended_at) return res.status(403).json({ error: SUSPENDED_MESSAGE, code: 'ACCOUNT_SUSPENDED' });
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
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

// ---------- Forgot / reset password ----------
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later' } });

// Always answers the same way, so nobody can use it to find out which emails have accounts.
router.post('/forgot-password', resetLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (EMAIL_RE.test(email)) {
    const { rows } = await query('SELECT id, name, email, suspended_at FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (user && !user.suspended_at) {
      const token = crypto.randomBytes(32).toString('hex');
      await query(`UPDATE users SET reset_token_hash = $1, reset_token_expires = now() + interval '1 hour' WHERE id = $2`, [sha256(token), user.id]);
      await sendPasswordResetEmail(user, token).catch((err) => console.error('Reset email failed:', err.message));
    }
  }
  res.json({ ok: true });
});

router.post('/reset-password', resetLimiter, async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'This reset link is invalid' });
  const weak = passwordProblem(password);
  if (weak) return res.status(400).json({ error: weak });
  const hash = await bcrypt.hash(password, 10);
  // Opening the emailed link also proves the email address, so it counts as confirmed.
  const { rows } = await query(
    `UPDATE users SET password_hash = $1, password_changed_at = now(), reset_token_hash = NULL, reset_token_expires = NULL,
            email_verified_at = COALESCE(email_verified_at, now())
     WHERE reset_token_hash = $2 AND reset_token_expires > now() AND suspended_at IS NULL
     RETURNING id, name, email`,
    [hash, sha256(token)]
  );
  if (!rows[0]) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please ask for a new one.' });
  notify(rows[0].email, 'Your Nearvo password was changed', `Hi ${rows[0].name},\n\nYour Nearvo password was just changed. If this wasn't you, reset it again straight away and contact us.\n\nNearvo`);
  res.json({ ok: true });
});

// ---------- Change password (logged in) ----------
router.put('/password', limiter, requireAuth, async (req, res) => {
  const { rows } = await query('SELECT id, name, email, role, password_hash FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!(await bcrypt.compare(String(req.body.current_password || ''), user.password_hash))) {
    return res.status(400).json({ error: 'Your current password is not right' });
  }
  const weak = passwordProblem(req.body.password);
  if (weak) return res.status(400).json({ error: weak });
  if (await bcrypt.compare(String(req.body.password), user.password_hash)) {
    return res.status(400).json({ error: 'Please choose a password different from your current one' });
  }
  // Log-ins from before this moment stop working; the new one issued below stays valid.
  await query(`UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2`,
    [await bcrypt.hash(String(req.body.password), 10), user.id]);
  notify(user.email, 'Your Nearvo password was changed', `Hi ${user.name},\n\nYour Nearvo password was just changed. If this wasn't you, reset it straight away and contact us.\n\nNearvo`);
  res.json({ token: signToken(user) });
});

// ---------- Delete my account ----------
export async function deleteAccount(userId) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.role, tp.photo_url FROM users u LEFT JOIN tradie_profiles tp ON tp.user_id = u.id WHERE u.id = $1`, [userId]);
  const user = rows[0];
  if (!user) return null;
  // Tradies whose rating includes this person's reviews need their rating recalculated afterwards.
  const affected = await query('SELECT DISTINCT tradie_id FROM reviews WHERE customer_id = $1', [userId]);
  await query('DELETE FROM users WHERE id = $1', [userId]);
  for (const r of affected.rows) await query(recomputeRatingSql, [r.tradie_id]);
  if (user.photo_url) await removePhoto(user.photo_url);
  return user;
}

router.delete('/me', limiter, requireAuth, async (req, res) => {
  const { rows } = await query('SELECT password_hash, role FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.password || ''), rows[0].password_hash))) {
    return res.status(400).json({ error: 'Your password is not right' });
  }
  if (rows[0].role === 'admin') {
    const admins = await query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'`);
    if (admins.rows[0].n <= 1) return res.status(400).json({ error: "You're the only admin, so this account can't be deleted" });
  }
  const user = await deleteAccount(req.user.id);
  notify(user.email, 'Your Nearvo account was deleted', `Hi ${user.name},\n\nYour Nearvo account and personal details have been deleted, as you asked. Thanks for using Nearvo.\n\nNearvo`);
  res.json({ ok: true });
});

export default router;
