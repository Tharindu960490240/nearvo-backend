// Upgrades an existing database to the latest version WITHOUT deleting anything.
// Usage: npm run db:migrate   (uses DATABASE_URL / DATABASE_SSL from .env)
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATE_SQL = path.join(__dirname, '../db/migrate.sql');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.connect();
    await client.query(readFileSync(MIGRATE_SQL, 'utf8'));
    console.log('✓ Database is up to date (nothing was deleted)');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
