// Tradies can publicly reply to reviews about them (one reply, editable).
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.post('/:id/reply', requireAuth, requireRole('tradie'), async (req, res) => {
  const reply = String(req.body.reply || '').trim();
  if (reply.length < 2) return res.status(400).json({ error: 'Please write a reply' });
  if (reply.length > 1500) return res.status(400).json({ error: 'Please keep your reply under 1500 characters' });
  const { rows } = await query(
    `UPDATE reviews SET reply = $1, reply_at = now() WHERE id = $2 AND tradie_id = $3 RETURNING id`,
    [reply, parseInt(req.params.id, 10), req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Review not found' });
  res.json({ ok: true });
});

export default router;
