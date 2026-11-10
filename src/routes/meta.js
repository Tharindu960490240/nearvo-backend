import { Router } from 'express';
import { query } from '../db.js';
import { STATES } from '../australia.js';

const router = Router();

// GET /api/categories - trade categories with how many tradies offer each
router.get('/categories', async (_req, res) => {
  const { rows } = await query(`
    SELECT c.*, COUNT(tp.user_id)::int AS tradie_count
    FROM categories c
    LEFT JOIN tradie_services ts ON ts.category_id = c.id
    LEFT JOIN tradie_profiles tp ON tp.user_id = ts.tradie_id AND tp.suburb_id IS NOT NULL AND tp.suspended_at IS NULL
    WHERE c.hidden_at IS NULL
    GROUP BY c.id ORDER BY c.name`);
  res.json(rows);
});

// GET /api/suburbs?q=bondi | 2026 | richmond vic
router.get('/suburbs', async (req, res) => {
  let q = String(req.query.q || '').trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (q.length < 2) return res.json([]);

  let state = null;
  let postcode = null;
  const parts = q.split(' ');
  if (parts.length > 1 && STATES[parts.at(-1).toUpperCase()]) state = parts.pop().toUpperCase();
  if (parts.length > 1 && /^\d{4}$/.test(parts.at(-1))) postcode = parts.pop();
  q = parts.join(' ');

  const params = [];
  const where = [];
  if (/^\d{1,4}$/.test(q)) {
    params.push(`${q}%`);
    where.push(`postcode LIKE $${params.length}`);
  } else {
    params.push(`${q.toLowerCase()}%`);
    where.push(`lower(name) LIKE $${params.length}`);
  }
  if (state) { params.push(state); where.push(`state = $${params.length}`); }
  if (postcode) { params.push(postcode); where.push(`postcode = $${params.length}`); }
  params.push(q.toLowerCase());

  const { rows } = await query(
    `SELECT id, name, postcode, state, latitude, longitude FROM suburbs
     WHERE ${where.join(' AND ')}
     ORDER BY (lower(name) = $${params.length}) DESC, length(name), name, postcode
     LIMIT 10`,
    params
  );
  res.json(rows);
});

// GET /api/states - tradie counts per state/territory
router.get('/states', async (_req, res) => {
  const { rows } = await query(`
    SELECT s.state, COUNT(*)::int AS n FROM tradie_profiles tp JOIN suburbs s ON s.id = tp.suburb_id GROUP BY s.state`);
  const counts = Object.fromEntries(rows.map((r) => [r.state, r.n]));
  res.json(Object.entries(STATES).map(([code, name]) => ({ code, name, tradie_count: counts[code] || 0 })));
});

// GET /api/announcement - the site-wide banner set by an admin (null when there isn't one)
router.get('/announcement', async (_req, res) => {
  const { rows } = await query(`SELECT value, updated_at FROM settings WHERE key = 'announcement'`);
  const a = rows[0]?.value;
  const live = a?.active && a.text && (!a.ends_at || new Date(a.ends_at) > new Date());
  res.set('Cache-Control', 'no-cache');
  res.json(live ? { text: a.text, tone: a.tone || 'info', link_url: a.link_url || null, link_label: a.link_label || null, id: rows[0].updated_at } : null);
});

export default router;
