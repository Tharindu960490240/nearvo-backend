import { Router } from 'express';
import { query } from '../db.js';
import { STATES } from '../australia.js';
import { tradieSelect } from '../lib/tradieQuery.js';

const router = Router();
const num = (v) => (v === undefined || v === '' ? NaN : Number(v));

/**
 * GET /api/tradies
 * Query: category (slug), lat, lng (customer location: only tradies whose service area covers it),
 *        state, q, sort (rating|distance|price|experience|newest), page, limit
 */
router.get('/', async (req, res) => {
  const lat = num(req.query.lat);
  const lng = num(req.query.lng);
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));

  const params = [];
  const where = ['tp.abn_verified_at IS NOT NULL', 'tp.suspended_at IS NULL', 'EXISTS (SELECT 1 FROM tradie_services x WHERE x.tradie_id = u.id)'];
  let distanceFrom = null;
  if (hasLoc) {
    params.push(lat, lng);
    distanceFrom = [`$${params.length - 1}`, `$${params.length}`];
    where.push(`km_between($${params.length - 1}::float8, $${params.length}::float8, s.latitude, s.longitude) <= tp.service_radius_km`);
  }
  let categorySlug = null;
  if (req.query.category) {
    categorySlug = String(req.query.category);
    params.push(categorySlug);
    where.push(`EXISTS (SELECT 1 FROM tradie_services x JOIN categories c ON c.id = x.category_id WHERE x.tradie_id = u.id AND c.slug = $${params.length})`);
  }
  const state = String(req.query.state || '').toUpperCase();
  if (STATES[state]) {
    params.push(state);
    where.push(`s.state = $${params.length}`);
  }
  if (req.query.q && String(req.query.q).trim()) {
    params.push(`%${String(req.query.q).trim()}%`);
    const p = `$${params.length}`;
    where.push(`(tp.business_name ILIKE ${p} OR tp.bio ILIKE ${p} OR u.name ILIKE ${p} OR s.name ILIKE ${p}
                 OR EXISTS (SELECT 1 FROM tradie_services x JOIN categories c ON c.id = x.category_id WHERE x.tradie_id = u.id AND c.name ILIKE ${p}))`);
  }

  const sort = req.query.sort || (hasLoc ? 'distance' : 'rating');
  let priceOrder = '(SELECT MIN(x.price_from) FROM tradie_services x WHERE x.tradie_id = t.id) ASC NULLS LAST';
  if (sort === 'price' && categorySlug) {
    params.push(categorySlug);
    priceOrder = `(SELECT x.price_from FROM tradie_services x JOIN categories c ON c.id = x.category_id WHERE x.tradie_id = t.id AND c.slug = $${params.length}) ASC NULLS LAST`;
  }
  const orderBy = {
    rating: 'avg_rating DESC, review_count DESC',
    distance: hasLoc ? 'distance_km ASC' : 'avg_rating DESC',
    price: priceOrder,
    experience: 'years_experience DESC NULLS LAST',
    newest: 'created_at DESC',
  }[sort] || 'avg_rating DESC';

  params.push(limit, (page - 1) * limit);
  const { rows } = await query(
    `SELECT t.*, COUNT(*) OVER()::int AS total_count
     FROM (${tradieSelect(distanceFrom)} WHERE ${where.join(' AND ')}) t
     ORDER BY ${orderBy}, t.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = rows[0]?.total_count || 0;
  res.json({
    results: rows.map(({ total_count, abn, licence_number, ...r }) => r),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  });
});

// GET /api/tradies/:id - public profile with services and reviews
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const { rows } = await query(`${tradieSelect()} WHERE u.id = $1 AND tp.suspended_at IS NULL`, [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Tradie not found' });

  const reviews = await query(
    `SELECT r.id, r.rating, r.comment, r.reply, r.reply_at, r.created_at, split_part(u.name, ' ', 1) AS customer_name,
            j.title AS job_title, c.name AS category_name, s.name AS suburb
     FROM reviews r
     JOIN users u ON u.id = r.customer_id
     JOIN jobs j ON j.id = r.job_id
     JOIN categories c ON c.id = j.category_id
     JOIN suburbs s ON s.id = j.suburb_id
     WHERE r.tradie_id = $1 AND r.hidden_at IS NULL ORDER BY r.created_at DESC`,
    [id]
  );
  res.json({ ...rows[0], reviews: reviews.rows });
});

export default router;
