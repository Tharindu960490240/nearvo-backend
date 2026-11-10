// Scheduled jobs. Vercel calls GET /api/cron/daily on the schedule in vercel.json and sends
// "Authorization: Bearer <CRON_SECRET>" automatically when CRON_SECRET is set on the project.
import crypto from 'node:crypto';
import { Router } from 'express';
import { runDaily } from '../lib/daily.js';
import { logAction } from '../lib/audit.js';

const router = Router();

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

router.get('/daily', async (req, res) => {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'Set CRON_SECRET to turn on scheduled jobs' });
  if (!authorised(req)) return res.status(401).json({ error: 'Not allowed' });
  const result = await runDaily();
  if (result.abn.enabled) {
    await logAction(null, 'daily_run', null, `Daily check: ABNs ${result.abn.checked} checked, ${result.abn.paused} paused; summary ${result.summary.sent ? 'emailed' : 'not sent'}`);
  }
  res.json(result);
});

export default router;
