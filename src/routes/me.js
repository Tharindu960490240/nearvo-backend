// The logged-in tradie's own profile, services, photo and verification documents.
import { Router } from 'express';
import { query } from '../db.js';
import pool from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { abrColumns, lookupBusinessNumber } from '../lib/abr.js';
import { photoUpload, removeUpload, verifyFileContent } from '../lib/uploads.js';

const router = Router();
router.use(requireAuth, requireRole('tradie'));

const UNITS = ['per hour', 'per job', 'per m²', 'on quote'];

router.get('/profile', async (req, res) => {
  const { rows } = await query(
    `SELECT tp.*, tp.avg_rating::float AS avg_rating, s.name AS suburb, s.state, s.postcode, s.latitude, s.longitude
     FROM tradie_profiles tp LEFT JOIN suburbs s ON s.id = tp.suburb_id WHERE tp.user_id = $1`,
    [req.user.id]
  );
  const services = await query(
    `SELECT ts.category_id, ts.price_from::float AS price_from, ts.price_unit, c.name, c.slug, c.icon
     FROM tradie_services ts JOIN categories c ON c.id = ts.category_id WHERE ts.tradie_id = $1 ORDER BY c.name`,
    [req.user.id]
  );
  res.json({ ...rows[0], services: services.rows });
});

router.put('/profile', async (req, res) => {
  const b = req.body;
  const businessName = String(b.business_name || '').trim();
  const bio = String(b.bio || '').trim() || null;
  const years = b.years_experience === '' || b.years_experience == null ? null : parseInt(b.years_experience, 10);
  const abnInput = String(b.abn || '').replace(/[\s-]/g, '');
  const licence = String(b.licence_number || '').trim() || null;
  const suburbId = parseInt(b.suburb_id, 10) || null;
  const radius = parseInt(b.service_radius_km, 10);
  const services = Array.isArray(b.services) ? b.services : [];

  if (!businessName) return res.status(400).json({ error: 'Business name is required' });
  if (years !== null && !(years >= 0 && years <= 70)) return res.status(400).json({ error: 'Years of experience must be between 0 and 70' });
  if (!suburbId) return res.status(400).json({ error: 'Please choose the suburb you work from' });
  if (!(radius >= 1 && radius <= 500)) return res.status(400).json({ error: 'Service area must be between 1 and 500 km' });
  if (!services.length) return res.status(400).json({ error: 'Add at least one service you offer' });
  if (services.length > 8) return res.status(400).json({ error: 'You can list up to 8 services' });

  const clean = [];
  for (const s of services) {
    const categoryId = parseInt(s.category_id, 10);
    const unit = UNITS.includes(s.price_unit) ? s.price_unit : 'per hour';
    const price = unit === 'on quote' || s.price_from === '' || s.price_from == null ? null : Number(s.price_from);
    if (!categoryId) return res.status(400).json({ error: 'Each service needs a trade' });
    if (price !== null && !(price >= 0 && price < 100000)) return res.status(400).json({ error: 'Prices must be a positive amount' });
    if (clean.some((c) => c.categoryId === categoryId)) return res.status(400).json({ error: 'Each trade can only be listed once' });
    clean.push({ categoryId, price, unit });
  }

  const sub = await query('SELECT 1 FROM suburbs WHERE id = $1', [suburbId]);
  if (!sub.rowCount) return res.status(400).json({ error: 'Unknown suburb' });

  // Re-check with ABN Lookup whenever the number changes (or was never confirmed).
  const current = (await query('SELECT abn, acn, abn_check, abn_verified_at FROM tradie_profiles WHERE user_id = $1', [req.user.id])).rows[0];
  const isDemo = current?.abn_check === 'demo' && !abnInput;
  if (!abnInput && !isDemo) return res.status(400).json({ error: 'Please enter your ABN or ACN', code: 'ABN_FORMAT' });
  const unchanged = isDemo || (current?.abn_verified_at && (abnInput === current.abn || abnInput === current.acn));
  let abrCols = null;
  if (!unchanged) {
    let r;
    try {
      r = await lookupBusinessNumber(abnInput);
    } catch (err) {
      if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
      throw err;
    }
    if (r.abn) {
      const dupe = await query('SELECT 1 FROM tradie_profiles WHERE abn = $1 AND user_id <> $2', [r.abn, req.user.id]);
      if (dupe.rowCount) return res.status(409).json({ error: 'Another tradie account already uses this ABN', code: 'ABN_TAKEN' });
    }
    abrCols = abrColumns(r);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE tradie_profiles SET business_name = $1, bio = $2, years_experience = $3, licence_number = $4,
              suburb_id = $5, service_radius_km = $6, updated_at = now()
       WHERE user_id = $7`,
      [businessName, bio, years, licence, suburbId, radius, req.user.id]
    );
    if (abrCols) {
      await client.query(
        `UPDATE tradie_profiles SET abn = $1, acn = $2, abn_entity_name = $3, abn_status = $4, abn_gst_registered = $5,
                abn_check = $6, abn_verified_at = now()
         WHERE user_id = $7`,
        [abrCols.abn, abrCols.acn, abrCols.abn_entity_name, abrCols.abn_status, abrCols.abn_gst_registered, abrCols.abn_check, req.user.id]
      );
    }
    await client.query('DELETE FROM tradie_services WHERE tradie_id = $1', [req.user.id]);
    for (const s of clean) {
      await client.query(
        'INSERT INTO tradie_services (tradie_id, category_id, price_from, price_unit) VALUES ($1, $2, $3, $4)',
        [req.user.id, s.categoryId, s.price, s.unit]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(400).json({ error: 'One of the trades no longer exists' });
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});

router.post('/photo', photoUpload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an image' });
  if (!verifyFileContent(req.file)) return res.status(400).json({ error: 'That file is not a valid image' });
  const { rows } = await query('SELECT photo_url FROM tradie_profiles WHERE user_id = $1', [req.user.id]);
  const old = rows[0]?.photo_url;
  const url = `/uploads/${req.file.filename}`;
  await query('UPDATE tradie_profiles SET photo_url = $1, updated_at = now() WHERE user_id = $2', [url, req.user.id]);
  if (old?.startsWith('/uploads/')) removeUpload(`public/${old.slice('/uploads/'.length)}`);
  res.json({ photo_url: url });
});

export default router;
