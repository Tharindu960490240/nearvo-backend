import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { query } from './db.js';
import { PUBLIC_DIR, useDisk } from './lib/uploads.js';
import authRoutes from './routes/auth.js';
import metaRoutes from './routes/meta.js';
import tradieRoutes from './routes/tradies.js';
import meRoutes from './routes/me.js';
import jobRoutes, { BUDGETS, TIMINGS } from './routes/jobs.js';
import adminRoutes from './routes/admin.js';
import cronRoutes from './routes/cron.js';
import abrRoutes from './routes/abr.js';
import reportRoutes from './routes/reports.js';
import reviewRoutes from './routes/reviews.js';
import { abrEnabled } from './lib/abr.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('JWT_SECRET is missing or too short. Copy .env.example to .env and set a long random value.');
  process.exit(1);
}

const app = express();
// Allowed website addresses (comma-separated). Trailing "/" and letter case are ignored, so
// "https://nearvo-frontend.vercel.app/" and "https://nearvo-frontend.vercel.app" both work.
const clean = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
const origins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',').map(clean).filter(Boolean);
const corsOrigin = (origin, cb) => {
  if (!origin || origins.includes(clean(origin))) return cb(null, true);
  console.warn(`CORS: blocked ${origin}. Add it to CLIENT_URL (currently: ${origins.join(', ')})`);
  return cb(null, false);
};

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));

// Profile photos only. Verification documents live in a private folder and are streamed to admins.
if (useDisk) app.use('/uploads', express.static(PUBLIC_DIR, { maxAge: '7d', index: false }));

app.get('/api/health', async (_req, res) => {
  await query('SELECT 1');
  res.json({ status: 'ok', app: 'Nearvo API' });
});
app.get('/api/options', (_req, res) => res.json({ budgets: BUDGETS, timings: TIMINGS }));

app.use('/api/auth', authRoutes);
app.use('/api', metaRoutes);
app.use('/api/tradies', tradieRoutes);
app.use('/api/me', meRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/abr', abrRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api', jobRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Express 5 forwards rejected promises from async handlers here.
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large (max 5 MB)' });
  if (err.expose || err.status === 400) return res.status(err.status || 400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// Vercel imports this file and runs the exported app as a function.
// Locally (npm run dev / npm start) we start a normal server.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Nearvo API running on http://localhost:${port}`);
    if (!abrEnabled()) console.warn('ABR_GUID is not set: ABNs/ACNs are only checksum-checked, not looked up. Add your ABN Lookup GUID to .env.');
  });
}

export default app;
