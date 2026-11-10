-- Nearvo: tradie marketplace schema (PostgreSQL)
-- Run via `npm run db:setup`, which DROPS and recreates everything below (then applies db/migrate.sql).
-- To upgrade a live database without losing data, use `npm run db:migrate` instead.

DROP TABLE IF EXISTS admin_actions, settings, reports, reviews, quotes, jobs, verification_documents, tradie_services, tradie_profiles,
  categories, suburbs, users CASCADE;
-- Tables from earlier Nearvo versions
DROP TABLE IF EXISTS businesses, localities CASCADE;

-- Great-circle distance in km between two points.
CREATE OR REPLACE FUNCTION km_between(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
RETURNS float8 LANGUAGE sql IMMUTABLE AS $$
  SELECT 6371 * acos(LEAST(1, GREATEST(-1,
    cos(radians(lat1)) * cos(radians(lat2)) * cos(radians(lng2) - radians(lng1))
    + sin(radians(lat1)) * sin(radians(lat2)))))
$$;

CREATE TABLE users (
  id                   SERIAL PRIMARY KEY,
  name                 VARCHAR(100) NOT NULL,
  email                VARCHAR(255) NOT NULL UNIQUE,
  password_hash        VARCHAR(255) NOT NULL,
  phone                VARCHAR(30),
  role                 VARCHAR(10)  NOT NULL CHECK (role IN ('customer', 'tradie', 'admin')),
  email_verified_at    TIMESTAMPTZ,
  email_token_hash     VARCHAR(64),
  email_token_expires  TIMESTAMPTZ,
  terms_accepted_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Australian suburbs / towns with postcode and centre point
CREATE TABLE suburbs (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(120) NOT NULL,
  postcode  CHAR(4) NOT NULL,
  state     VARCHAR(3) NOT NULL CHECK (state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  latitude  DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  UNIQUE (name, postcode, state)
);
CREATE INDEX idx_suburbs_name     ON suburbs (lower(name) text_pattern_ops);
CREATE INDEX idx_suburbs_postcode ON suburbs (postcode);

CREATE TABLE categories (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(80) NOT NULL,
  slug  VARCHAR(80) NOT NULL UNIQUE,
  icon  VARCHAR(40) NOT NULL          -- lucide icon name used by the frontend, e.g. "wrench"
);

CREATE TABLE tradie_profiles (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name     VARCHAR(150) NOT NULL,
  bio               TEXT,
  years_experience  SMALLINT CHECK (years_experience BETWEEN 0 AND 70),
  abn               VARCHAR(11),
  acn               VARCHAR(9),
  abn_entity_name   VARCHAR(200),                       -- legal name from the ABN Lookup service
  abn_status        VARCHAR(20),
  abn_gst_registered BOOLEAN,
  abn_check         VARCHAR(10) CHECK (abn_check IN ('abr', 'checksum', 'demo')),
  abn_verified_at   TIMESTAMPTZ,                        -- set when the ABN/ACN passed the check; required to work
  licence_number    VARCHAR(50),                        -- self-declared by the tradie, not checked by Nearvo
  suburb_id         INTEGER REFERENCES suburbs(id),     -- base location; NULL until onboarding is done
  service_radius_km INTEGER NOT NULL DEFAULT 25 CHECK (service_radius_km BETWEEN 1 AND 500),
  photo_url         VARCHAR(300),
  suspended_at      TIMESTAMPTZ,                        -- hidden from customers by an admin (e.g. after a report)
  avg_rating        NUMERIC(2,1) NOT NULL DEFAULT 0,
  review_count      INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tradie_profiles_suburb ON tradie_profiles(suburb_id);

CREATE TABLE tradie_services (
  tradie_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  price_from  NUMERIC(8,2) CHECK (price_from >= 0),
  price_unit  VARCHAR(20) NOT NULL DEFAULT 'per hour' CHECK (price_unit IN ('per hour', 'per job', 'per m²', 'on quote')),
  PRIMARY KEY (tradie_id, category_id)
);
CREATE INDEX idx_tradie_services_category ON tradie_services(category_id);

CREATE TABLE jobs (
  id                 SERIAL PRIMARY KEY,
  customer_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id        INTEGER NOT NULL REFERENCES categories(id),
  suburb_id          INTEGER NOT NULL REFERENCES suburbs(id),
  title              VARCHAR(150) NOT NULL,
  description        TEXT NOT NULL,
  budget             VARCHAR(30),
  timing             VARCHAR(30),
  status             VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'completed', 'cancelled')),
  assigned_tradie_id INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at        TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ
);
CREATE INDEX idx_jobs_status   ON jobs(status);
CREATE INDEX idx_jobs_customer ON jobs(customer_id);

CREATE TABLE quotes (
  id         SERIAL PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tradie_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  amount_type VARCHAR(20) NOT NULL DEFAULT 'fixed' CHECK (amount_type IN ('fixed', 'per hour', 'estimate')),
  message    TEXT,
  status     VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, tradie_id)
);
CREATE INDEX idx_quotes_tradie ON quotes(tradie_id);

CREATE TABLE reviews (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,  -- one review per completed job
  tradie_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  reply       TEXT,                     -- the tradie's public response
  reply_at    TIMESTAMPTZ,
  hidden_at   TIMESTAMPTZ,              -- set by an admin after a valid report (kept for the record, not shown)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reviews_tradie ON reviews(tradie_id);

-- Complaints / reports about content. Open to anyone (including people without an account),
-- which is the "accessible complaints mechanism" Australian defamation law expects of platforms.
CREATE TABLE reports (
  id             SERIAL PRIMARY KEY,
  target_type    VARCHAR(10) NOT NULL CHECK (target_type IN ('review', 'tradie', 'job', 'other')),
  target_id      INTEGER,
  reason         VARCHAR(20) NOT NULL CHECK (reason IN ('defamatory', 'fake', 'offensive', 'scam', 'privacy', 'other')),
  details        TEXT NOT NULL,
  reporter_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reporter_name  VARCHAR(100) NOT NULL,
  reporter_email VARCHAR(255) NOT NULL,
  status         VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  action         VARCHAR(20),
  admin_note     TEXT,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reports_status ON reports(status);
