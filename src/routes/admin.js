// Light-touch admin: platform stats and the reports/complaints inbox.
// Actions: hide a review, pause a tradie profile, cancel a job - or dismiss. Every action can be undone.
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recomputeRatingSql } from '../lib/tradieQuery.js';
import { notify } from '../lib/mailer.js';

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
      (SELECT COUNT(*)::int FROM reports WHERE status = 'open') AS open_reports`);
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
  const act = req.body.action === 'act';
  const note = String(req.body.note || '').trim() || null;
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
  res.json({ ok: true });
});

export default router;
