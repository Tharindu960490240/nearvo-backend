-- Nearvo database upgrades. Safe to run any number of times (it only adds what's missing),
-- and it never deletes data. Run with `npm run db:migrate`. `npm run db:setup` runs it too.

-- Accounts: suspension, password reset, last login
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at        TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash    VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;   -- older log-ins stop working after a change
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at       TIMESTAMPTZ;

-- Trades can be hidden instead of deleted (existing jobs keep their trade)
ALTER TABLE categories ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;

-- Tradies: when the ABN was last re-checked, and why a profile was paused
ALTER TABLE tradie_profiles ADD COLUMN IF NOT EXISTS abn_checked_at TIMESTAMPTZ;
ALTER TABLE tradie_profiles ADD COLUMN IF NOT EXISTS paused_reason  TEXT;
UPDATE tradie_profiles SET abn_checked_at = abn_verified_at WHERE abn_checked_at IS NULL AND abn_verified_at IS NOT NULL;

-- Jobs removed by an admin (so they can be restored)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- Deleting a tradie's account must not fail because they were hired for a job
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_assigned_tradie_id_fkey;
ALTER TABLE jobs ADD CONSTRAINT jobs_assigned_tradie_id_fkey FOREIGN KEY (assigned_tradie_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created  ON jobs(created_at);

-- Record of every admin action (and automatic actions such as ABN re-checks)
CREATE TABLE IF NOT EXISTS admin_actions (
  id          SERIAL PRIMARY KEY,
  admin_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admin_name  VARCHAR(100) NOT NULL,          -- kept even if the admin account is later deleted; 'System' for automatic jobs
  action      VARCHAR(40)  NOT NULL,
  target_type VARCHAR(20),
  target_id   INTEGER,
  summary     TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);

-- Small site-wide settings (e.g. the announcement banner)
CREATE TABLE IF NOT EXISTS settings (
  key        VARCHAR(50) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
