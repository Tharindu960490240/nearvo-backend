// Jobs (posted by customers), quotes (sent by tradies) and reviews (after completion).
import { Router } from 'express';
import pool, { query } from '../db.js';
import { requireAuth, requireRole, requireVerifiedEmail } from '../middleware/auth.js';
import { recomputeRatingSql, tradieSelect } from '../lib/tradieQuery.js';
import { notify } from '../lib/mailer.js';

const router = Router();
router.use(requireAuth);

export const BUDGETS = ['Under $200', '$200 – $500', '$500 – $1,000', '$1,000 – $5,000', 'Over $5,000', 'Not sure'];
export const TIMINGS = ['As soon as possible', 'Within a week', 'Within a month', "I'm flexible"];
const AMOUNT_TYPES = ['fixed', 'per hour', 'estimate'];
const appUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0];

const jobSelect = `
  SELECT j.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon,
         s.name AS suburb, s.state, s.postcode, s.latitude, s.longitude,
         (SELECT COUNT(*)::int FROM quotes q WHERE q.job_id = j.id AND q.status <> 'withdrawn') AS quote_count
  FROM jobs j
  JOIN categories c ON c.id = j.category_id
  JOIN suburbs s ON s.id = j.suburb_id`;

// Is this open job something the tradie can quote on? (offers the trade + job is inside their service area)
async function tradieCanSee(tradieId, jobId) {
  const { rows } = await query(
    `SELECT km_between(ts_sub.latitude, ts_sub.longitude, s.latitude, s.longitude) AS distance_km
     FROM jobs j
     JOIN suburbs s ON s.id = j.suburb_id
     JOIN tradie_profiles tp ON tp.user_id = $1 AND tp.abn_verified_at IS NOT NULL AND tp.suspended_at IS NULL
     JOIN suburbs ts_sub ON ts_sub.id = tp.suburb_id
     JOIN tradie_services svc ON svc.tradie_id = tp.user_id AND svc.category_id = j.category_id
     WHERE j.id = $2
       AND km_between(ts_sub.latitude, ts_sub.longitude, s.latitude, s.longitude) <= tp.service_radius_km`,
    [tradieId, jobId]
  );
  return rows[0] || null;
}

// ---------- Customers ----------

router.post('/jobs', requireRole('customer'), requireVerifiedEmail, async (req, res) => {
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim();
  const categoryId = parseInt(req.body.category_id, 10);
  const suburbId = parseInt(req.body.suburb_id, 10);
  const budget = BUDGETS.includes(req.body.budget) ? req.body.budget : 'Not sure';
  const timing = TIMINGS.includes(req.body.timing) ? req.body.timing : "I'm flexible";

  if (!categoryId) return res.status(400).json({ error: 'Please choose the type of tradie you need' });
  if (title.length < 5) return res.status(400).json({ error: 'Please give your job a short title (at least 5 characters)' });
  if (title.length > 150) return res.status(400).json({ error: 'Title is too long' });
  if (description.length < 20) return res.status(400).json({ error: 'Please describe the job in a bit more detail (at least 20 characters)' });
  if (!suburbId) return res.status(400).json({ error: 'Please choose the suburb where the job is' });

  const { rows } = await query(
    `INSERT INTO jobs (customer_id, category_id, suburb_id, title, description, budget, timing)
     SELECT $1, c.id, s.id, $4, $5, $6, $7 FROM categories c, suburbs s WHERE c.id = $2 AND s.id = $3
     RETURNING id`,
    [req.user.id, categoryId, suburbId, title, description, budget, timing]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Unknown trade or suburb' });

  // Let matching tradies know (fire and forget).
  query(
    `SELECT u.email, u.name FROM jobs j
     JOIN suburbs js ON js.id = j.suburb_id
     JOIN tradie_services svc ON svc.category_id = j.category_id
     JOIN tradie_profiles tp ON tp.user_id = svc.tradie_id
     JOIN suburbs ts ON ts.id = tp.suburb_id
     JOIN users u ON u.id = tp.user_id
     WHERE j.id = $1 AND u.email_verified_at IS NOT NULL AND tp.abn_verified_at IS NOT NULL AND tp.suspended_at IS NULL
       AND km_between(ts.latitude, ts.longitude, js.latitude, js.longitude) <= tp.service_radius_km
     LIMIT 50`,
    [rows[0].id]
  ).then(({ rows: tradies }) => tradies.forEach((t) =>
    notify(t.email, `New job near you: ${title}`, `Hi ${t.name},\n\nA customer near you needs help: "${title}".\nView and quote: ${appUrl()}/jobs/${rows[0].id}\n\nNearvo`)
  )).catch(() => {});

  res.status(201).json({ id: rows[0].id });
});

router.get('/jobs/mine', requireRole('customer'), async (req, res) => {
  const { rows } = await query(
    `${jobSelect.replace('FROM jobs j', `, tp.business_name AS assigned_business_name FROM jobs j`)}
     LEFT JOIN tradie_profiles tp ON tp.user_id = j.assigned_tradie_id
     WHERE j.customer_id = $1
     ORDER BY CASE j.status WHEN 'open' THEN 0 WHEN 'assigned' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, j.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

router.post('/quotes/:id/accept', requireRole('customer'), async (req, res) => {
  const quoteId = parseInt(req.params.id, 10);
  const client = await pool.connect();
  let info;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT q.*, j.customer_id, j.status AS job_status, j.title FROM quotes q JOIN jobs j ON j.id = q.job_id
       WHERE q.id = $1 FOR UPDATE OF j`,
      [quoteId]
    );
    const q = rows[0];
    if (!q || q.customer_id !== req.user.id) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Quote not found' }); }
    if (q.job_status !== 'open') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'You have already hired someone for this job' }); }
    if (q.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This quote is no longer available' }); }

    await client.query(`UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = $1`, [quoteId]);
    await client.query(`UPDATE quotes SET status = 'declined', updated_at = now() WHERE job_id = $1 AND id <> $2 AND status = 'pending'`, [q.job_id, quoteId]);
    await client.query(`UPDATE jobs SET status = 'assigned', assigned_tradie_id = $1, assigned_at = now() WHERE id = $2`, [q.tradie_id, q.job_id]);
    await client.query('COMMIT');
    info = q;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const t = await query('SELECT email, name FROM users WHERE id = $1', [info.tradie_id]);
  if (t.rows[0]) notify(t.rows[0].email, `You got the job: ${info.title}`, `Congratulations ${t.rows[0].name}!\n\nYour quote was accepted. The customer's contact details are now on the job page:\n${appUrl()}/jobs/${info.job_id}\n\nNearvo`);
  res.json({ ok: true });
});

router.post('/jobs/:id/cancel', requireRole('customer'), async (req, res) => {
  const { rows } = await query(
    `UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND customer_id = $2 AND status = 'open' RETURNING id`,
    [parseInt(req.params.id, 10), req.user.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Only open jobs can be cancelled' });
  await query(`UPDATE quotes SET status = 'declined', updated_at = now() WHERE job_id = $1 AND status = 'pending'`, [rows[0].id]);
  res.json({ ok: true });
});

router.post('/jobs/:id/complete', requireRole('customer'), async (req, res) => {
  const { rows } = await query(
    `UPDATE jobs SET status = 'completed', completed_at = now()
     WHERE id = $1 AND customer_id = $2 AND status = 'assigned' RETURNING id`,
    [parseInt(req.params.id, 10), req.user.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Only jobs with a hired tradie can be marked complete' });
  res.json({ ok: true });
});

router.post('/jobs/:id/review', requireRole('customer'), async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  const rating = parseInt(req.body.rating, 10);
  const comment = String(req.body.comment || '').trim() || null;
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Please choose a rating from 1 to 5 stars' });

  const { rows } = await query('SELECT * FROM jobs WHERE id = $1 AND customer_id = $2', [jobId, req.user.id]);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed') return res.status(400).json({ error: 'You can review once the job is marked complete' });

  try {
    await query(
      'INSERT INTO reviews (job_id, tradie_id, customer_id, rating, comment) VALUES ($1, $2, $3, $4, $5)',
      [jobId, job.assigned_tradie_id, req.user.id, rating, comment]
    );
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'You have already reviewed this job' });
    throw err;
  }
  await query(recomputeRatingSql, [job.assigned_tradie_id]);
  res.status(201).json({ ok: true });
});

// ---------- Tradies ----------

// Open jobs in the tradie's trades and service area ("leads").
router.get('/jobs/leads', requireRole('tradie'), async (req, res) => {
  const chk = await query('SELECT abn_verified_at, suspended_at FROM tradie_profiles WHERE user_id = $1', [req.user.id]);
  if (chk.rows[0]?.suspended_at) return res.status(403).json({ error: 'Your profile has been paused. Please contact us.', code: 'SUSPENDED' });
  if (!chk.rows[0]?.abn_verified_at) return res.status(403).json({ error: 'Add your ABN to your profile to see jobs', code: 'ABN_REQUIRED' });
  const { rows } = await query(
    `${jobSelect.replace('FROM jobs j', `,
        km_between(base.latitude, base.longitude, s.latitude, s.longitude) AS distance_km,
        split_part(cu.name, ' ', 1) AS customer_first_name,
        mq.id AS my_quote_id, mq.amount::float AS my_amount, mq.status AS my_quote_status
      FROM jobs j`)}
     JOIN users cu ON cu.id = j.customer_id
     JOIN tradie_profiles tp ON tp.user_id = $1
     JOIN suburbs base ON base.id = tp.suburb_id
     JOIN tradie_services svc ON svc.tradie_id = tp.user_id AND svc.category_id = j.category_id
     LEFT JOIN quotes mq ON mq.job_id = j.id AND mq.tradie_id = $1
     WHERE j.status = 'open'
       AND km_between(base.latitude, base.longitude, s.latitude, s.longitude) <= tp.service_radius_km
     ORDER BY (mq.id IS NULL) DESC, j.created_at DESC
     LIMIT 100`,
    [req.user.id]
  );
  res.json(rows);
});

router.get('/quotes/mine', requireRole('tradie'), async (req, res) => {
  const { rows } = await query(
    `SELECT q.id, q.amount::float AS amount, q.amount_type, q.message, q.status, q.created_at,
            j.id AS job_id, j.title, j.status AS job_status, j.assigned_tradie_id, j.created_at AS job_created_at,
            c.name AS category_name, c.icon AS category_icon, s.name AS suburb, s.state, s.postcode,
            split_part(cu.name, ' ', 1) AS customer_first_name
     FROM quotes q
     JOIN jobs j ON j.id = q.job_id
     JOIN categories c ON c.id = j.category_id
     JOIN suburbs s ON s.id = j.suburb_id
     JOIN users cu ON cu.id = j.customer_id
     WHERE q.tradie_id = $1
     ORDER BY q.updated_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

router.post('/jobs/:id/quotes', requireRole('tradie'), requireVerifiedEmail, async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  const amount = Number(req.body.amount);
  const amountType = AMOUNT_TYPES.includes(req.body.amount_type) ? req.body.amount_type : 'fixed';
  const message = String(req.body.message || '').trim();

  if (!(amount > 0 && amount < 1000000)) return res.status(400).json({ error: 'Please enter your price' });
  if (message.length < 10) return res.status(400).json({ error: 'Add a short message to the customer (at least 10 characters)' });

  const prof = await query('SELECT suburb_id, abn_verified_at, suspended_at FROM tradie_profiles WHERE user_id = $1', [req.user.id]);
  if (prof.rows[0]?.suspended_at) return res.status(403).json({ error: 'Your profile has been paused. Please contact us.', code: 'SUSPENDED' });
  if (!prof.rows[0]?.abn_verified_at) return res.status(403).json({ error: 'Your ABN needs to be confirmed before you can quote', code: 'ABN_REQUIRED' });
  if (!prof.rows[0]?.suburb_id) return res.status(400).json({ error: 'Finish your tradie profile before quoting', code: 'PROFILE_INCOMPLETE' });

  const job = await query('SELECT id, status, title, customer_id FROM jobs WHERE id = $1', [jobId]);
  if (!job.rows[0]) return res.status(404).json({ error: 'Job not found' });
  if (job.rows[0].status !== 'open') return res.status(400).json({ error: 'This job is no longer taking quotes' });
  if (!(await tradieCanSee(req.user.id, jobId))) return res.status(403).json({ error: "This job is outside your trades or service area" });

  const { rows } = await query(
    `INSERT INTO quotes (job_id, tradie_id, amount, amount_type, message) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id, tradie_id) DO UPDATE
       SET amount = EXCLUDED.amount, amount_type = EXCLUDED.amount_type, message = EXCLUDED.message,
           status = 'pending', updated_at = now()
       WHERE quotes.status IN ('pending', 'withdrawn')
     RETURNING id, (xmax = 0) AS created`,
    [jobId, req.user.id, amount, amountType, message]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Your quote on this job can no longer be changed' });

  if (rows[0].created) {
    const c = await query('SELECT email, name FROM users WHERE id = $1', [job.rows[0].customer_id]);
    if (c.rows[0]) notify(c.rows[0].email, `New quote for "${job.rows[0].title}"`, `Hi ${c.rows[0].name},\n\nYou've received a new quote. Compare quotes and hire here:\n${appUrl()}/jobs/${jobId}\n\nNearvo`);
  }
  res.status(rows[0].created ? 201 : 200).json({ id: rows[0].id });
});

router.post('/quotes/:id/withdraw', requireRole('tradie'), async (req, res) => {
  const { rows } = await query(
    `UPDATE quotes SET status = 'withdrawn', updated_at = now() WHERE id = $1 AND tradie_id = $2 AND status = 'pending' RETURNING id`,
    [parseInt(req.params.id, 10), req.user.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Only pending quotes can be withdrawn' });
  res.json({ ok: true });
});

// ---------- Shared job page ----------

router.get('/jobs/:id', async (req, res) => {
  const jobId = parseInt(req.params.id, 10);
  if (!jobId) return res.status(400).json({ error: 'Invalid id' });
  const { rows } = await query(`${jobSelect} WHERE j.id = $1`, [jobId]);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const me = req.user;
  const isOwner = job.customer_id === me.id;
  const isAdmin = me.role === 'admin';
  const isAssigned = job.assigned_tradie_id === me.id;

  const customer = (await query('SELECT name, phone, email FROM users WHERE id = $1', [job.customer_id])).rows[0];

  if (isOwner || isAdmin) {
    // Each row: quote fields (quote_*) plus the tradie summary (t.id = tradie's user id).
    const quotes = await query(
      `SELECT q.id AS quote_id, q.amount::float AS amount, q.amount_type, q.message, q.status AS quote_status,
              q.updated_at AS quoted_at, t.*
       FROM quotes q
       JOIN LATERAL (${tradieSelect(['$2', '$3'])} WHERE u.id = q.tradie_id) t ON true
       WHERE q.job_id = $1 AND q.status <> 'withdrawn'
       ORDER BY (q.status = 'accepted') DESC, q.amount ASC`,
      [jobId, job.latitude, job.longitude]
    );
    const list = quotes.rows.map(({ abn, licence_number, ...r }) => r);

    let hired = null;
    if (job.assigned_tradie_id) {
      hired = (await query(
        `SELECT u.id, u.name, u.phone, u.email, tp.business_name FROM users u JOIN tradie_profiles tp ON tp.user_id = u.id WHERE u.id = $1`,
        [job.assigned_tradie_id]
      )).rows[0];
    }
    const review = (await query('SELECT id, rating, comment, reply, created_at, hidden_at FROM reviews WHERE job_id = $1', [jobId])).rows[0] || null;
    return res.json({ ...job, viewer: isOwner ? 'owner' : 'admin', customer, quotes: list, hired, review });
  }

  if (me.role === 'tradie') {
    const myQuote = (await query(
      `SELECT id, amount::float AS amount, amount_type, message, status, created_at, updated_at FROM quotes WHERE job_id = $1 AND tradie_id = $2`,
      [jobId, me.id]
    )).rows[0] || null;
    const eligible = job.status === 'open' ? await tradieCanSee(me.id, jobId) : null;
    if (!isAssigned && !myQuote && !eligible) return res.status(404).json({ error: 'Job not found' });

    const review = isAssigned ? (await query('SELECT id, rating, comment, reply, created_at, hidden_at FROM reviews WHERE job_id = $1', [jobId])).rows[0] || null : null;
    return res.json({
      ...job,
      viewer: 'tradie',
      can_quote: Boolean(eligible) && (!myQuote || ['pending', 'withdrawn'].includes(myQuote.status)),
      distance_km: eligible?.distance_km ?? null,
      my_quote: myQuote,
      // Full contact details only once this tradie is hired.
      customer: isAssigned ? customer : { name: customer.name.split(' ')[0] },
      review,
    });
  }

  res.status(404).json({ error: 'Job not found' });
});

export default router;
