import pg from 'pg';
import 'dotenv/config';
import { attachDatabasePool } from '@vercel/functions';

const onVercel = Boolean(process.env.VERCEL);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  // Serverless: keep few connections per instance and release idle ones quickly.
  max: onVercel ? 5 : 10,
  idleTimeoutMillis: onVercel ? 5000 : 10000,
});

pool.on('error', (err) => console.error('Unexpected PostgreSQL error', err));

// On Vercel, lets idle connections close cleanly before an instance is suspended.
if (onVercel) attachDatabasePool(pool);

export const query = (text, params) => pool.query(text, params);
export default pool;
