// Admin API: stats, alerts, charts, reports inbox, users, jobs, reviews, trades, site banner and the action log.
// Every change is written to the admin action log (lib/audit.js).
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recomputeRatingSql } from '../lib/tradieQuery.js';
import { appUrl, notify } from '../lib/mailer.js';
import { logAction } from '../lib/audit.js';
import { getAlerts } from '../lib/alerts.js';
import { CATEGORY_ICONS } from '../lib/icons.js';
import { recheckAbns, recheckTradieAbn, sendDailySummary } from '../lib/daily.js';
import { abrEnabled } from '../lib/abr.js';
import { deleteAccount, issueEmailToken } from './auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get('/stats', async (_req, res) => {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE role = 'customer') AS customers,
      (SELECT COUNT(*)::int FROM users WHERE role = 'tradie') AS tradies,
      (SELECT COUNT(*)::int FROM jobs WHERE status = 'open') AS open_jobs,
      (SELECT COUNT(*)::int FROM jobs WHERE status = 'completed') AS completed_jobs,
      (SELECT COUNT(*)::int FROM reviews WHERE hidden_at IS NULL) AS reviews,
      (SELECT COUNT(*)::int FROM reports WHERE status = 'open') AS open_reports,
      (SELECT COUNT(*)::int FROM users WHERE suspended_at IS NOT NULL) AS suspended_users,
      (SELECT COUNT(*)::int FROM tradie_profiles WHERE suspended_at IS NOT NULL) AS paused_tradies,
      (SELECT COUNT(*)::int FROM users WHERE created_at > now() - interval '7 days') AS new_users_7d,
      (SELECT COUNT(*)::int FROM jobs WHERE created_at > now() - interval '7 days') AS new_jobs_7d`);
  res.json(rows[0]);
});

// Reports with a preview of the reported item.
router.get('/reports', async (req, res) => {
  const status = ['open', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const { rows } = await query(
    `SELECT r.*,
       EXTRACT(EPOCH FROM (now() - r.created_at)) / 86400 AS age_days,
       CASE r.target_type
         WHEN 'review' THEN (SELECT json_build_object('rating', rv.rating, 'comment', rv.comment, 'reply', rv.reply, 'hidden', rv.hidden_at IS NOT NULL,
                               'tradie_id', rv.tradie_id, 'business_name', tp.business_name, 'customer', cu.name, 'created_at', rv.created_at)
                             FROM reviews rv JOIN tradie_profiles tp ON tp.user_id = rv.tradie_id JOIN users cu ON cu.id = rv.customer_id
                             WHERE rv.id = r.target_id)
         WHEN 'tradie' THEN (SELECT json_build_object('business_name', tp.business_name, 'name', u.name, 'email', u.email, 'abn', tp.abn,
                               'abn_entity_name', tp.abn_entity_name, 'suspended', tp.suspended_at IS NOT NULL, 'tradie_id', tp.user_id)
                             FROM tradie_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.user_id = r.target_id)
         WHEN 'job' THEN (SELECT json_build_object('title', j.title, 'description', j.description, 'status', j.status, 'customer', u.name)
                          FROM jobs j JOIN users u ON u.id = j.customer_id WHERE j.id = r.target_id)
       END AS target
     FROM reports r
     WHERE r.status = $1
     ORDER BY r.created_at ${status === 'open' ? 'ASC' : 'DESC'}
     LIMIT 200`,
    [status]
  );
  res.json(rows);
});

async function applyAction(report, undo = false) {
  const t = report.target_type;
  if (t === 'review') {
    const r = await query(`UPDATE reviews SET hidden_at = ${undo ? 'NULL' : 'now()'} WHERE id = $1 RETURNING tradie_id`, [report.target_id]);
    if (r.rows[0]) await query(recomputeRatingSql, [r.rows[0].tradie_id]);
  } else if (t === 'tradie') {
    await query(`UPDATE tradie_profiles SET suspended_at = ${undo ? 'NULL' : 'now()'} WHERE user_id = $1`, [report.target_id]);
  } else if (t === 'job' && !undo) {
    await query(`UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND status = 'open'`, [report.target_id]);
    await query(`UPDATE quotes SET status = 'declined', updated_at = now() WHERE job_id = $1 AND status = 'pending'`, [report.target_id]);
  }
}

const ACTION_NAME = { review: 'hide_review', tradie: 'pause_tradie', job: 'cancel_job', other: 'noted' };

// POST /api/admin/reports/:id/resolve { action: 'act' | 'dismiss', note }
router.post('/reports/:id/resolve', async (req, res) => {
  const act = (req.body || {}).action === 'act';
  const note = String((req.body || {}).note || '').trim() || null;
  const { rows } = await query('SELECT * FROM reports WHERE id = $1', [parseInt(req.params.id, 10)]);
  const report = rows[0];
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (report.status !== 'open') return res.status(400).json({ error: 'This report has already been handled' });

  if (act) await applyAction(report);
  const action = act ? ACTION_NAME[report.target_type] : 'dismissed';
  await query(
    `UPDATE reports SET status = $1, action = $2, admin_note = $3, resolved_at = now() WHERE id = $4`,
    [act ? 'actioned' : 'dismissed', action, note, report.id]
  );
  // Apply the same outcome to other open reports about the same item.
  if (act && report.target_id) {
    await query(
      `UPDATE reports SET status = 'actioned', action = $1, admin_note = 'Handled with report #' || $2::text, resolved_at = now()
       WHERE status = 'open' AND target_type = $3 AND target_id = $4`,
      [action, report.id, report.target_type, report.target_id]
    );
  }
  await logAction(req.user, act ? `report_${action}` : 'report_dismissed', { type: 'report', id: report.id },
    `${act ? 'Actioned' : 'Dismissed'} report #${report.id} about a ${report.target_type}${act ? ` (${action.replace('_', ' ')})` : ''}`, note);
  notify(report.reporter_email, `Update on your report (#${report.id})`,
    `Hi ${report.reporter_name},\n\nWe've reviewed your report. ${act ? 'We have taken action on the content you reported.' : 'After review, the content does not break our rules, so it will stay up.'}${note ? `\n\nNote from our team: ${note}` : ''}\n\nNearvo`);
  res.json({ ok: true });
});

// POST /api/admin/reports/:id/undo - reverses a hide/pause and reopens the report.
router.post('/reports/:id/undo', async (req, res) => {
  const { rows } = await query('SELECT * FROM reports WHERE id = $1', [parseInt(req.params.id, 10)]);
  const report = rows[0];
  if (!report || report.status === 'open') return res.status(400).json({ error: 'Nothing to undo' });
  if (report.status === 'actioned') await applyAction(report, true);
  await query(`UPDATE reports SET status = 'open', action = NULL, resolved_at = NULL WHERE id = $1`, [report.id]);
  await logAction(req.user, 'report_undo', { type: 'report', id: report.id }, `Undid the decision on report #${report.id} (reopened)`);
  res.json({ ok: true });
});



const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const page = (req) => Math.max(0, int(req.query.page) || 0);
const PAGE_SIZE = 30;
const likeParam = (q) => `%${String(q).trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

// ---------- Needs a look + charts ----------
router.get('/alerts', async (_req, res) => res.json(await getAlerts()));

router.get('/charts', async (req, res) => {
  const weeks = Math.min(52, Math.max(4, int(req.query.weeks) || 12));
  const [weekly, trades, states] = await Promise.all([
    query(`WITH w AS (SELECT generate_series(date_trunc('week', now()) - make_interval(weeks => $1 - 1), date_trunc('week', now()), interval '1 week') AS start)
      SELECT to_char(w.start, 'YYYY-MM-DD') AS week,
        (SELECT COUNT(*)::int FROM users u WHERE u.role = 'customer' AND date_trunc('week', u.created_at) = w.start) AS customers,
        (SELECT COUNT(*)::int FROM users u WHERE u.role = 'tradie' AND date_trunc('week', u.created_at) = w.start) AS tradies,
        (SELECT COUNT(*)::int FROM jobs j WHERE date_trunc('week', j.created_at) = w.start) AS jobs_posted,
        (SELECT COUNT(*)::int FROM jobs j WHERE date_trunc('week', j.completed_at) = w.start) AS jobs_completed
      FROM w ORDER BY w.start`, [weeks]),
    query(`SELECT c.name, COUNT(j.id)::int AS jobs FROM categories c LEFT JOIN jobs j ON j.category_id = c.id AND j.created_at > now() - interval '90 days'
           GROUP BY c.id ORDER BY jobs DESC, c.name LIMIT 8`),
    query(`SELECT s.state, COUNT(*)::int AS jobs FROM jobs j JOIN suburbs s ON s.id = j.suburb_id WHERE j.created_at > now() - interval '90 days'
           GROUP BY s.state ORDER BY jobs DESC`),
  ]);
  res.json({ weekly: weekly.rows, trades: trades.rows, states: states.rows });
});

// ---------- Users ----------
router.get('/users', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) {
    params.push(likeParam(req.query.q));
    const p = `$${params.length}`;
    params.push(String(req.query.q).replace(/\D/g, '') || '-');
    where.push(`(u.name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone ILIKE ${p} OR tp.business_name ILIKE ${p} OR tp.abn = $${params.length} OR u.id::text = $${params.length})`);
  }
  if (['customer', 'tradie', 'admin'].includes(req.query.role)) { params.push(req.query.role); where.push(`u.role = $${params.length}`); }
  if (req.query.status === 'suspended') where.push('(u.suspended_at IS NOT NULL OR tp.suspended_at IS NOT NULL)');
  if (req.query.status === 'unverified') where.push('u.email_verified_at IS NULL');
  if (req.query.status === 'active') where.push('u.suspended_at IS NULL AND tp.suspended_at IS NULL');
  params.push(PAGE_SIZE + 1, page(req) * PAGE_SIZE);
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at, u.last_login_at, u.email_verified_at IS NOT NULL AS email_verified,
            u.suspended_at, u.suspended_reason, tp.business_name, tp.abn, tp.abn_status, tp.abn_check, tp.suspended_at AS profile_paused_at,
            tp.paused_reason, tp.avg_rating::float, tp.review_count,
            (SELECT COUNT(*)::int FROM jobs j WHERE j.customer_id = u.id) AS jobs_posted,
            (SELECT COUNT(*)::int FROM quotes q WHERE q.tradie_id = u.id) AS quotes_sent
     FROM users u LEFT JOIN tradie_profiles tp ON tp.user_id = u.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY u.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ items: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE });
});

async function loadUser(id) {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at, u.last_login_at, u.email_verified_at, u.suspended_at, u.suspended_reason,
            tp.business_name, tp.abn, tp.acn, tp.abn_entity_name, tp.abn_status, tp.abn_check, tp.abn_checked_at, tp.licence_number,
            tp.suspended_at AS profile_paused_at, tp.paused_reason, tp.avg_rating::float, tp.review_count, tp.photo_url,
            s.name AS suburb, s.state, s.postcode
     FROM users u LEFT JOIN tradie_profiles tp ON tp.user_id = u.id LEFT JOIN suburbs s ON s.id = tp.suburb_id WHERE u.id = $1`, [id]);
  return rows[0];
}

router.get('/users/:id', async (req, res) => {
  const user = await loadUser(int(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const [jobs, quotes, reviews, reports, actions] = await Promise.all([
    query(`SELECT j.id, j.title, j.status, j.created_at, j.removed_at FROM jobs j WHERE j.customer_id = $1 ORDER BY j.created_at DESC LIMIT 10`, [user.id]),
    query(`SELECT q.id, q.amount::float, q.status, q.created_at, j.id AS job_id, j.title FROM quotes q JOIN jobs j ON j.id = q.job_id WHERE q.tradie_id = $1 ORDER BY q.created_at DESC LIMIT 10`, [user.id]),
    query(`SELECT r.id, r.rating, r.comment, r.hidden_at, r.created_at, CASE WHEN r.tradie_id = $1 THEN 'received' ELSE 'written' END AS kind
           FROM reviews r WHERE r.tradie_id = $1 OR r.customer_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [user.id]),
    query(`SELECT id, reason, status, created_at FROM reports WHERE target_type = 'tradie' AND target_id = $1 ORDER BY created_at DESC LIMIT 10`, [user.id]),
    query(`SELECT id, admin_name, action, summary, note, created_at FROM admin_actions WHERE target_type = 'user' AND target_id = $1 ORDER BY created_at DESC LIMIT 20`, [user.id]),
  ]);
  res.json({ user, jobs: jobs.rows, quotes: quotes.rows, reviews: reviews.rows, reports: reports.rows, actions: actions.rows });
});

const who = (u) => `${u.business_name || u.name} (${u.role}, #${u.id})`;

router.post('/users/:id/suspend', async (req, res) => {
  const user = await loadUser(int(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(400).json({ error: "Admin accounts can't be suspended here" });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500) || null;
  await query('UPDATE users SET suspended_at = now(), suspended_reason = $2 WHERE id = $1', [user.id, reason]);
  await query(`UPDATE tradie_profiles SET suspended_at = COALESCE(suspended_at, now()), paused_reason = COALESCE(paused_reason, 'Account suspended') WHERE user_id = $1`, [user.id]);
  await logAction(req.user, 'suspend_user', { type: 'user', id: user.id }, `Suspended ${who(user)}`, reason);
  if ((req.body || {}).notify !== false) {
    notify(user.email, 'Your Nearvo account has been suspended',
      `Hi ${user.name},\n\nYour Nearvo account has been suspended${reason ? ` for this reason: ${reason}` : ''}. You won't be able to log in while it is suspended.\n\nIf you think this is a mistake, reply to this email.\n\nNearvo`);
  }
  res.json({ ok: true });
});

router.post('/users/:id/restore', async (req, res) => {
  const user = await loadUser(int(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  await query('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1', [user.id]);
  await query('UPDATE tradie_profiles SET suspended_at = NULL, paused_reason = NULL WHERE user_id = $1', [user.id]);
  await logAction(req.user, 'restore_user', { type: 'user', id: user.id }, `Restored ${who(user)}`, String((req.body || {}).note || '').trim() || null);
  if (user.suspended_at || user.profile_paused_at) {
    notify(user.email, 'Your Nearvo account is active again', `Hi ${user.name},\n\nGood news: your Nearvo account is active again${user.role === 'tradie' ? ' and your profile is visible to customers' : ''}.\n\n${appUrl()}/login\n\nNearvo`);
  }
  res.json({ ok: true });
});

// Hide only the tradie's public profile (they can still log in), e.g. while a complaint is checked.
router.post('/users/:id/pause-profile', async (req, res) => {
  const user = await loadUser(int(req.params.id));
  if (!user || user.role !== 'tradie') return res.status(404).json({ error: 'Tradie not found' });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500) || 'Paused by admin';
  await query('UPDATE tradie_profiles SET suspended_at = now(), paused_reason = $2 WHERE user_id = $1', [user.id, reason]);
  await logAction(req.user, 'pause_profile', { type: 'user', id: user.id }, `Paused the public profile of ${who(user)}`, reason);
  res.json({ ok: true });
});

router.post('/users/:id/resend-verification', async (req, res) => {
  const user = await loadUser(int(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.email_verified_at) return res.status(400).json({ error: 'This email is already confirmed' });
  await issueEmailToken(user);
  await logAction(req.user, 'resend_verification', { type: 'user', id: user.id }, `Resent the email confirmation to ${who(user)}`);
  res.json({ ok: true });
});

router.post('/users/:id/recheck-abn', async (req, res) => {
  const user = await loadUser(int(req.params.id));
  if (!user || user.role !== 'tradie' || !user.abn) return res.status(400).json({ error: 'This user has no ABN to check' });
  if (!abrEnabled()) return res.status(400).json({ error: 'ABN Lookup is not set up on this server (ABR_GUID)' });
  const result = await recheckTradieAbn({ user_id: user.id, abn: user.abn, business_name: user.business_name, name: user.name, email: user.email }, req.user);
  if (result === 'ok') await logAction(req.user, 'abn_recheck', { type: 'user', id: user.id }, `Re-checked the ABN of ${who(user)}: still active`);
  res.json({ result });
});

router.delete('/users/:id', async (req, res) => {
  const user = await loadUser(int(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin') return res.status(400).json({ error: "Admin accounts can't be deleted here" });
  if (String((req.body || {}).confirm || '').trim().toLowerCase() !== 'delete') return res.status(400).json({ error: 'Type DELETE to confirm' });
  await deleteAccount(user.id);
  // Only a minimal record is kept, without the email address or phone number.
  await logAction(req.user, 'delete_user', { type: 'user', id: user.id }, `Deleted the account of ${who(user)}`, String((req.body || {}).note || '').trim() || null);
  if ((req.body || {}).notify !== false) {
    notify(user.email, 'Your Nearvo account has been deleted', `Hi ${user.name},\n\nYour Nearvo account and personal details have been deleted.\n\nNearvo`);
  }
  res.json({ ok: true });
});

// ---------- Jobs ----------
router.get('/jobs', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) {
    params.push(likeParam(req.query.q));
    where.push(`(j.title ILIKE $${params.length} OR j.description ILIKE $${params.length} OR cu.name ILIKE $${params.length} OR s.name ILIKE $${params.length} OR j.id::text = trim($${params.length}, '%'))`);
  }
  if (['open', 'assigned', 'completed', 'cancelled'].includes(req.query.status)) { params.push(req.query.status); where.push(`j.status = $${params.length}`); }
  if (req.query.status === 'removed') where.push('j.removed_at IS NOT NULL');
  params.push(PAGE_SIZE + 1, page(req) * PAGE_SIZE);
  const { rows } = await query(
    `SELECT j.id, j.title, j.description, j.status, j.created_at, j.removed_at, c.name AS category_name, c.icon AS category_icon,
            s.name AS suburb, s.state, s.postcode, cu.id AS customer_id, cu.name AS customer_name,
            (SELECT COUNT(*)::int FROM quotes q WHERE q.job_id = j.id) AS quote_count
     FROM jobs j JOIN categories c ON c.id = j.category_id JOIN suburbs s ON s.id = j.suburb_id JOIN users cu ON cu.id = j.customer_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY j.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ items: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE });
});

router.post('/jobs/:id/remove', async (req, res) => {
  const note = String((req.body || {}).note || '').trim() || null;
  const { rows } = await query(
    `UPDATE jobs j SET status = 'cancelled', removed_at = now() FROM users u
     WHERE j.id = $1 AND u.id = j.customer_id AND j.status = 'open' RETURNING j.id, j.title, u.name, u.email`, [int(req.params.id)]);
  if (!rows[0]) return res.status(400).json({ error: 'Only open jobs can be removed' });
  await query(`UPDATE quotes SET status = 'declined', updated_at = now() WHERE job_id = $1 AND status = 'pending'`, [rows[0].id]);
  await logAction(req.user, 'remove_job', { type: 'job', id: rows[0].id }, `Removed job #${rows[0].id} "${rows[0].title}"`, note);
  if ((req.body || {}).notify !== false) {
    notify(rows[0].email, `Your job "${rows[0].title}" was removed`, `Hi ${rows[0].name},\n\nYour job "${rows[0].title}" was removed because it doesn't meet our rules${note ? `: ${note}` : '.'}\n\nIf you think this is a mistake, reply to this email.\n\nNearvo`);
  }
  res.json({ ok: true });
});

router.post('/jobs/:id/restore', async (req, res) => {
  const job = await query(`SELECT id, title, removed_at FROM jobs WHERE id = $1 AND removed_at IS NOT NULL AND status = 'cancelled'`, [int(req.params.id)]);
  if (!job.rows[0]) return res.status(400).json({ error: 'This job was not removed by an admin' });
  // Quotes that were declined only because of the removal become pending again.
  await query(`UPDATE quotes SET status = 'pending', updated_at = now() WHERE job_id = $1 AND status = 'declined' AND updated_at >= $2`, [job.rows[0].id, job.rows[0].removed_at]);
  const { rows } = await query(`UPDATE jobs SET status = 'open', removed_at = NULL WHERE id = $1 RETURNING id, title`, [job.rows[0].id]);
  await logAction(req.user, 'restore_job', { type: 'job', id: rows[0].id }, `Restored job #${rows[0].id} "${rows[0].title}"`);
  res.json({ ok: true });
});

// ---------- Reviews ----------
router.get('/reviews', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) {
    params.push(likeParam(req.query.q));
    where.push(`(r.comment ILIKE $${params.length} OR r.reply ILIKE $${params.length} OR tp.business_name ILIKE $${params.length} OR cu.name ILIKE $${params.length})`);
  }
  if (int(req.query.rating)) { params.push(int(req.query.rating)); where.push(`r.rating = $${params.length}`); }
  if (req.query.status === 'hidden') where.push('r.hidden_at IS NOT NULL');
  if (req.query.status === 'visible') where.push('r.hidden_at IS NULL');
  params.push(PAGE_SIZE + 1, page(req) * PAGE_SIZE);
  const { rows } = await query(
    `SELECT r.id, r.rating, r.comment, r.reply, r.hidden_at, r.created_at, r.tradie_id, tp.business_name, cu.id AS customer_id, cu.name AS customer_name, j.title AS job_title
     FROM reviews r JOIN tradie_profiles tp ON tp.user_id = r.tradie_id JOIN users cu ON cu.id = r.customer_id JOIN jobs j ON j.id = r.job_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ items: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE });
});

async function setReviewHidden(req, res, hide) {
  const { rows } = await query(
    `UPDATE reviews r SET hidden_at = ${hide ? 'now()' : 'NULL'} FROM tradie_profiles tp
     WHERE r.id = $1 AND tp.user_id = r.tradie_id RETURNING r.id, r.tradie_id, r.rating, tp.business_name`, [int(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'Review not found' });
  await query(recomputeRatingSql, [rows[0].tradie_id]);
  await logAction(req.user, hide ? 'hide_review' : 'show_review', { type: 'review', id: rows[0].id },
    `${hide ? 'Hid' : 'Showed again'} a ${rows[0].rating}-star review of ${rows[0].business_name}`, String(req.body?.note || '').trim() || null);
  res.json({ ok: true });
}
router.post('/reviews/:id/hide', (req, res) => setReviewHidden(req, res, true));
router.post('/reviews/:id/show', (req, res) => setReviewHidden(req, res, false));

// ---------- Trades (categories) ----------
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

router.get('/categories', async (_req, res) => {
  const { rows } = await query(`
    SELECT c.*, (SELECT COUNT(*)::int FROM tradie_services ts WHERE ts.category_id = c.id) AS tradie_count,
           (SELECT COUNT(*)::int FROM jobs j WHERE j.category_id = c.id) AS job_count
    FROM categories c ORDER BY c.hidden_at IS NOT NULL, c.name`);
  res.json({ items: rows, icons: CATEGORY_ICONS });
});

function categoryInput(body) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw Object.assign(new Error('Trade name must be 2–60 characters'), { status: 400, expose: true });
  const icon = String(body.icon || '');
  if (!CATEGORY_ICONS.includes(icon)) throw Object.assign(new Error('Please choose an icon'), { status: 400, expose: true });
  return { name, icon };
}

router.post('/categories', async (req, res) => {
  const { name, icon } = categoryInput(req.body);
  const slug = slugify(name);
  const dup = await query('SELECT id FROM categories WHERE slug = $1 OR lower(name) = lower($2)', [slug, name]);
  if (dup.rows[0]) return res.status(400).json({ error: 'A trade with that name already exists' });
  const { rows } = await query('INSERT INTO categories (name, slug, icon) VALUES ($1, $2, $3) RETURNING *', [name, slug, icon]);
  await logAction(req.user, 'add_trade', { type: 'category', id: rows[0].id }, `Added the trade "${name}"`);
  res.status(201).json(rows[0]);
});

// The web address (slug) stays the same when renaming, so existing links keep working.
router.put('/categories/:id', async (req, res) => {
  const { name, icon } = categoryInput(req.body);
  const id = int(req.params.id);
  const dup = await query('SELECT id FROM categories WHERE lower(name) = lower($1) AND id <> $2', [name, id]);
  if (dup.rows[0]) return res.status(400).json({ error: 'A trade with that name already exists' });
  const old = await query('SELECT * FROM categories WHERE id = $1', [id]);
  if (!old.rows[0]) return res.status(404).json({ error: 'Trade not found' });
  const hidden = (req.body || {}).hidden === undefined ? Boolean(old.rows[0].hidden_at) : Boolean((req.body || {}).hidden);
  const { rows } = await query(
    `UPDATE categories SET name = $2, icon = $3, hidden_at = CASE WHEN $4 THEN COALESCE(hidden_at, now()) ELSE NULL END WHERE id = $1 RETURNING *`,
    [id, name, icon, hidden]);
  const changes = [];
  if (old.rows[0].name !== name) changes.push(`renamed "${old.rows[0].name}" to "${name}"`);
  if (old.rows[0].icon !== icon) changes.push('changed the icon');
  if (Boolean(old.rows[0].hidden_at) !== hidden) changes.push(hidden ? 'hid it' : 'showed it again');
  if (changes.length) await logAction(req.user, 'edit_trade', { type: 'category', id }, `Trade "${name}": ${changes.join(', ')}`);
  res.json(rows[0]);
});

// ---------- Site banner ----------
router.get('/announcement', async (_req, res) => {
  const { rows } = await query(`SELECT value, updated_at FROM settings WHERE key = 'announcement'`);
  res.json(rows[0] ? { ...rows[0].value, updated_at: rows[0].updated_at } : { active: false, text: '', tone: 'info' });
});

router.put('/announcement', async (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 300);
  const active = Boolean((req.body || {}).active) && text.length > 0;
  const tone = ['info', 'warning', 'success'].includes((req.body || {}).tone) ? (req.body || {}).tone : 'info';
  let link_url = String((req.body || {}).link_url || '').trim().slice(0, 300) || null;
  if (link_url && !/^(https:\/\/|\/)/.test(link_url)) return res.status(400).json({ error: 'The link must start with https:// or /' });
  const link_label = link_url ? String((req.body || {}).link_label || '').trim().slice(0, 40) || 'Learn more' : null;
  const ends_at = (req.body || {}).ends_at ? new Date((req.body || {}).ends_at) : null;
  if (ends_at && Number.isNaN(ends_at.getTime())) return res.status(400).json({ error: 'The end date is not valid' });
  const value = { active, text, tone, link_url, link_label, ends_at: ends_at ? ends_at.toISOString() : null };
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('announcement', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [value]);
  await logAction(req.user, active ? 'banner_on' : 'banner_off', { type: 'setting' }, active ? `Turned on the site banner: "${text}"` : 'Turned off the site banner');
  res.json(value);
});

// ---------- Action log ----------
router.get('/actions', async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.q) {
    params.push(likeParam(req.query.q));
    where.push(`(summary ILIKE $${params.length} OR note ILIKE $${params.length} OR admin_name ILIKE $${params.length})`);
  }
  params.push(50 + 1, page(req) * 50);
  const { rows } = await query(
    `SELECT * FROM admin_actions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ items: rows.slice(0, 50), more: rows.length > 50 });
});

// ---------- Daily jobs, run by hand ----------
router.post('/daily/summary', async (req, res) => {
  const r = await sendDailySummary();
  if (!r.sent) return res.status(400).json({ error: r.reason });
  await logAction(req.user, 'send_summary', null, 'Sent the daily summary email by hand');
  res.json(r);
});

router.post('/daily/abn-check', async (req, res) => {
  if (!abrEnabled()) return res.status(400).json({ error: 'ABN Lookup is not set up on this server (ABR_GUID)' });
  const r = await recheckAbns();
  await logAction(req.user, 'abn_recheck_batch', null, `Ran the ABN re-check by hand: ${r.checked} checked, ${r.paused} paused`);
  res.json(r);
});

export default router;
