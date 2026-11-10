// Sets the admin password (or creates the admin account) WITHOUT touching any other data.
// Uses ADMIN_EMAIL and ADMIN_PASSWORD from .env:   npm run admin:password
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { passwordProblem } from '../src/lib/passwords.js';

const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';
if (!email) { console.error('Set ADMIN_EMAIL in .env'); process.exit(1); }
const weak = passwordProblem(password);
if (weak) { console.error(`ADMIN_PASSWORD: ${weak}`); process.exit(1); }

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
try {
  await client.connect();
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await client.query('SELECT id, role FROM users WHERE email = $1', [email]);
  if (rows[0]) {
    await client.query(
      `UPDATE users SET password_hash = $1, role = 'admin', password_changed_at = now(), suspended_at = NULL,
              email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $2`, [hash, rows[0].id]);
    console.log(`✓ Password updated for ${email}${rows[0].role !== 'admin' ? ' (account is now an admin)' : ''}`);
  } else {
    await client.query(
      `INSERT INTO users (name, email, password_hash, role, email_verified_at, terms_accepted_at) VALUES ('Admin', $1, $2, 'admin', now(), now())`, [email, hash]);
    console.log(`✓ Admin account created for ${email}`);
  }
} catch (err) {
  console.error('Failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
