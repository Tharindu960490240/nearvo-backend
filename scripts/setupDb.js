// Creates all tables and loads starter data.
// Run with:  npm run db:setup              (demo data for testing)
//            npm run db:setup -- --no-demo  (clean database for launch: no fake tradies, jobs or reviews)
// WARNING: this drops and recreates the tables, so it deletes existing data.
import 'dotenv/config';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pool from '../src/db.js';
import { loadSuburbs } from './loadSuburbs.js';
import { passwordProblem } from '../src/lib/passwords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_PASSWORD = 'Demo@1234';
const NO_DEMO = process.argv.includes('--no-demo');

// name, slug, lucide icon name (see frontend src/components/CategoryIcon.jsx)
const categories = [
  ['Plumber', 'plumber', 'wrench'],
  ['Electrician', 'electrician', 'zap'],
  ['Cleaner', 'cleaner', 'sparkles'],
  ['Gardener', 'gardener', 'leaf'],
  ['Handyman', 'handyman', 'hammer'],
  ['Painter', 'painter', 'paintbrush'],
  ['Carpenter', 'carpenter', 'ruler'],
  ['Tiler', 'tiler', 'grid-3x3'],
  ['Roofer', 'roofer', 'house'],
  ['Locksmith', 'locksmith', 'key-round'],
  ['Air Conditioning', 'air-conditioning', 'snowflake'],
  ['Removalist', 'removalist', 'truck'],
  ['Tutor', 'tutor', 'graduation-cap'],
];

// Demo tradies have no real ABN; they are marked abn_check = 'demo' so they can be used without an ABN Lookup.
// Phone numbers come from the 0491 570 xxx range ACMA reserves for fictional use.
// name, email, business, bio, years, [suburb, state], radius km, [category slug, price, unit][], phone
const tradies = [
  ['Sam Taylor', 'sam@example.com', 'Taylor Plumbing', 'Licensed plumber fixing leaks, hot water and blocked drains across Hobart.', 12, ['Moonah', 'TAS'], 20, [['plumber', 90, 'per hour']], '0491 570 156'],
  ['Priya Nair', 'priya@example.com', 'Bright Spark Electrical', 'Residential electrician. Lighting, power points, safety checks.', 8, ['Sandy Bay', 'TAS'], 15, [['electrician', 95, 'per hour']], '0491 570 157'],
  ["Jack O'Brien", 'jack@example.com', 'Jack of All Trades', 'Handyman and painter. No job too small.', 5, ['Bellerive', 'TAS'], 25, [['handyman', 65, 'per hour'], ['painter', 60, 'per hour']], '0491 570 158'],
  ['Mia Chen', 'mia@example.com', 'Sparkle Clean', 'Home and end-of-lease cleaning with eco-friendly products.', 4, ['Kingston', 'TAS'], 20, [['cleaner', 45, 'per hour']], '0491 570 159'],
  ['Liam Walsh', 'liam@example.com', 'Green Thumb Gardens', 'Lawn mowing, hedging, garden clean-ups.', 6, ['Glenorchy', 'TAS'], 20, [['gardener', 55, 'per hour']], '0491 570 110'],
  ['Daniel Rossi', 'daniel@example.com', 'Harbour City Plumbing', '24/7 emergency plumbing across Western Sydney.', 15, ['Parramatta', 'NSW'], 30, [['plumber', 110, 'per hour']], '0491 570 313'],
  ['Aisha Khan', 'aisha@example.com', 'Bondi Bright Electrical', 'Lighting upgrades, switchboards and EV chargers in the Eastern Suburbs.', 9, ['Bondi', 'NSW'], 20, [['electrician', 120, 'per hour']], '0491 570 737'],
  ['Tom Nguyen', 'tom@example.com', 'Inner North Cleaning Co', "Regular and end-of-lease cleans in Melbourne's inner north.", 6, ['Fitzroy', 'VIC'], 15, [['cleaner', 50, 'per hour']], '0491 571 266'],
  ['Grace Wilson', 'grace@example.com', 'River City Removals', 'Two-person removal teams across Brisbane and the Gold Coast.', 11, ['Brisbane City', 'QLD'], 80, [['removalist', 140, 'per hour']], '0491 571 491'],
  ['Ben Carter', 'ben@example.com', 'Swan Painting', 'Interior and exterior painting across Perth.', 14, ['Perth', 'WA'], 40, [['painter', 70, 'per hour']], '0491 571 804'],
  ['Olivia Brooks', 'olivia@example.com', 'Adelaide Tiling & Bathrooms', 'Bathroom renovations, floor and wall tiling, waterproofing.', 10, ['Norwood', 'SA'], 30, [['tiler', 75, 'per m²'], ['handyman', 70, 'per hour']], '0491 572 549'],
  ['Hamish Reid', 'hamish@example.com', 'Capital Roofing', 'Roof repairs, restorations and gutter replacement around Canberra.', 18, ['Belconnen', 'ACT'], 40, [['roofer', 95, 'per hour']], '0491 572 665'],
  ['Kiri Walker', 'kiri@example.com', 'Top End Cool Air', 'Split-system installs, servicing and repairs. Darwin and Palmerston.', 7, ['Casuarina', 'NT'], 35, [['air-conditioning', 130, 'per hour'], ['electrician', 110, 'per hour']], '0491 572 983'],
  ['Marco Bianchi', 'marco@example.com', 'Bianchi Carpentry', 'Decks, pergolas, doors and custom joinery across Melbourne.', 20, ['Richmond', 'VIC'], 30, [['carpenter', 85, 'per hour']], '0491 573 770'],
  ['Ella Thompson', 'ella@example.com', 'Lock & Key Brisbane', '24/7 lockouts, lock changes and security upgrades.', 9, ['Chermside', 'QLD'], 25, [['locksmith', 120, 'per job']], '0491 573 087'],
];

// Completed jobs with reviews: [customer email, tradie email, category, [suburb, state], title, description, rating, comment, days ago]
const completedJobs = [
  ['customer@example.com', 'sam@example.com', 'plumber', ['New Town', 'TAS'], 'Fix leaking kitchen tap', 'Tap drips constantly.', 5, 'Quick, tidy and fair price.', 40],
  ['customer@example.com', 'priya@example.com', 'electrician', ['Sandy Bay', 'TAS'], 'Install two new power points', 'Need two double power points in the study.', 5, 'Priya was on time and explained everything.', 25],
  ['alex@example.com', 'jack@example.com', 'painter', ['Lindisfarne', 'TAS'], 'Paint front fence', 'Timber picket fence, about 15 metres.', 4, 'Good job, finished a day later than planned.', 30],
  ['alex@example.com', 'daniel@example.com', 'plumber', ['Parramatta', 'NSW'], 'Blocked bathroom drain', 'Shower drain is very slow.', 5, 'Came out the same evening. Lifesaver!', 20],
  ['customer@example.com', 'aisha@example.com', 'electrician', ['Bondi', 'NSW'], 'Replace downlights with LEDs', '12 old halogen downlights.', 5, 'Neat work and great advice on the switchboard.', 15],
  ['alex@example.com', 'grace@example.com', 'removalist', ['South Brisbane', 'QLD'], 'Move 2-bedroom apartment', 'Third floor, lift available.', 4, 'Careful with our furniture, slightly late start.', 12],
  ['customer@example.com', 'ben@example.com', 'painter', ['Subiaco', 'WA'], 'Repaint living room and hallway', 'Walls and ceilings, light colour.', 5, 'Beautiful finish. Highly recommend.', 10],
  ['alex@example.com', 'hamish@example.com', 'roofer', ['Belconnen', 'ACT'], 'Fix leaking roof after storm', 'Water coming in near the chimney.', 5, 'Found the problem fast and fixed it properly.', 8],
  ['customer@example.com', 'marco@example.com', 'carpenter', ['Richmond', 'VIC'], 'Build small timber deck', 'About 3m x 4m off the back door.', 4, 'Solid deck, good communication.', 6],
];

// Open jobs: [customer email, category, [suburb, state], title, description, budget, timing, quotes: [tradie email, amount, type, message][]]
const openJobs = [
  ['customer@example.com', 'plumber', ['Sandy Bay', 'TAS'], 'Replace electric hot water system', 'Our 250L electric hot water cylinder is leaking from the base. Looking to replace with a similar size unit. Easy access in the laundry.', '$1,000 – $5,000', 'Within a week',
    [['sam@example.com', 1850, 'fixed', 'Hi! I can supply and install a 250L Rheem unit including removal of the old one. Available Thursday.']]],
  ['customer@example.com', 'painter', ['Bellerive', 'TAS'], 'Paint 3-bedroom house interior', 'Walls only in three bedrooms and the hallway. Ceilings are fine. Prefer low-VOC paint.', '$1,000 – $5,000', 'Within a month',
    [['jack@example.com', 2400, 'estimate', 'Happy to help. Estimate includes low-VOC paint and two coats. I can come and measure first.']]],
  ['alex@example.com', 'electrician', ['Newtown', 'NSW'], 'Install ceiling fan in bedroom', 'Existing light point in the main bedroom. Fan already purchased.', '$200 – $500', "I'm flexible", []],
  ['alex@example.com', 'cleaner', ['Brunswick', 'VIC'], 'End-of-lease clean, 2-bedroom unit', 'Two bedrooms, one bathroom, carpets need steam cleaning. Need it done before Friday inspection.', '$200 – $500', 'As soon as possible',
    [['tom@example.com', 380, 'fixed', 'Bond-back guarantee included. Carpet steam clean for 2 rooms is in the price.']]],
];

const sub = (name, state) => `(SELECT id FROM suburbs WHERE lower(name) = lower('${name.replace(/'/g, "''")}') AND state = '${state}' ORDER BY postcode LIMIT 1)`;

async function main() {
  const client = await pool.connect();
  try {
    await client.query(readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
    await client.query(readFileSync(path.join(__dirname, '../db/migrate.sql'), 'utf8'));
    console.log('✓ Tables created');

    const suburbCount = await loadSuburbs(client);
    for (const [name, slug, icon] of categories) {
      await client.query('INSERT INTO categories (name, slug, icon) VALUES ($1, $2, $3)', [name, slug, icon]);
    }
    console.log(`✓ ${suburbCount.toLocaleString()} Australian suburbs and ${categories.length} trade categories added`);

    if (NO_DEMO) {
      const email = String(process.env.ADMIN_EMAIL || '').toLowerCase();
      const password = process.env.ADMIN_PASSWORD || '';
      if (!email || password.length < 10) throw new Error('For --no-demo, set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) in .env');
      const weak = passwordProblem(password);
      if (weak) throw new Error(`ADMIN_PASSWORD: ${weak}`);
      await client.query(
        `INSERT INTO users (name, email, password_hash, role, email_verified_at, terms_accepted_at) VALUES ('Admin', $1, $2, 'admin', now(), now())`,
        [email, await bcrypt.hash(password, 10)]
      );
      console.log(`✓ Clean database ready (no demo data). Admin login: ${email}`);
      return;
    }

    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const ids = {};
    const addUser = async (name, email, role, phone = null) => {
      const r = await client.query(
        'INSERT INTO users (name, email, password_hash, phone, role, email_verified_at, terms_accepted_at) VALUES ($1, $2, $3, $4, $5, now(), now()) RETURNING id',
        [name, email, hash, phone, role]
      );
      ids[email] = r.rows[0].id;
      return r.rows[0].id;
    };

    await addUser('Demo Customer', 'customer@example.com', 'customer', '0491 574 118');
    await addUser('Alex Morgan', 'alex@example.com', 'customer', '0491 574 632');
    const adminId = await addUser('Site Admin', 'admin@example.com', 'admin');

    for (const [name, email, business, bio, years, [suburb, state], radius, services, phone] of tradies) {
      const id = await addUser(name, email, 'tradie', phone);
      const r = await client.query(
        `INSERT INTO tradie_profiles (user_id, business_name, bio, years_experience, suburb_id, service_radius_km, abn_check, abn_verified_at)
         VALUES ($1, $2, $3, $4, ${sub(suburb, state)}, $5, 'demo', now()) RETURNING suburb_id`,
        [id, business, bio, years, radius]
      );
      if (!r.rows[0].suburb_id) throw new Error(`Suburb not found for ${name}: ${suburb} ${state}`);
      for (const [slug, price, unit] of services) {
        await client.query(
          `INSERT INTO tradie_services (tradie_id, category_id, price_from, price_unit)
           VALUES ($1, (SELECT id FROM categories WHERE slug = $2), $3, $4)`,
          [id, slug, price, unit]
        );
      }
    }
    console.log(`✓ ${tradies.length} tradies added across all states and territories`);

    mkdirSync(path.join(path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')), 'public'), { recursive: true });

    for (const [cust, tradie, cat, [suburb, state], title, desc, rating, comment, daysAgo] of completedJobs) {
      const j = await client.query(
        `INSERT INTO jobs (customer_id, category_id, suburb_id, title, description, budget, timing, status, assigned_tradie_id,
                           created_at, assigned_at, completed_at)
         VALUES ($1, (SELECT id FROM categories WHERE slug = $2), ${sub(suburb, state)}, $3, $4, 'Not sure', 'Within a week',
                 'completed', $5, now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval + interval '1 day',
                 now() - ($6 || ' days')::interval + interval '3 days')
         RETURNING id`,
        [ids[cust], cat, title, desc, ids[tradie], daysAgo]
      );
      await client.query(
        `INSERT INTO quotes (job_id, tradie_id, amount, amount_type, message, status) VALUES ($1, $2, 250, 'fixed', 'Happy to help with this.', 'accepted')`,
        [j.rows[0].id, ids[tradie]]
      );
      await client.query(
        `INSERT INTO reviews (job_id, tradie_id, customer_id, rating, comment, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval + interval '4 days')`,
        [j.rows[0].id, ids[tradie], ids[cust], rating, comment, daysAgo]
      );
    }
    await client.query(`UPDATE reviews SET reply = 'Thanks for having us, glad the tap is behaving now!', reply_at = now() - interval '35 days'
                        WHERE tradie_id = $1`, [ids['sam@example.com']]);
    await client.query(`
      UPDATE tradie_profiles tp SET
        avg_rating = COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews r WHERE r.tradie_id = tp.user_id), 0),
        review_count = (SELECT COUNT(*) FROM reviews r WHERE r.tradie_id = tp.user_id)`);

    for (const [cust, cat, [suburb, state], title, desc, budget, timing, quotes] of openJobs) {
      const j = await client.query(
        `INSERT INTO jobs (customer_id, category_id, suburb_id, title, description, budget, timing, created_at)
         VALUES ($1, (SELECT id FROM categories WHERE slug = $2), ${sub(suburb, state)}, $3, $4, $5, $6, now() - interval '1 day')
         RETURNING id`,
        [ids[cust], cat, title, desc, budget, timing]
      );
      for (const [tradie, amount, type, message] of quotes) {
        await client.query(
          'INSERT INTO quotes (job_id, tradie_id, amount, amount_type, message) VALUES ($1, $2, $3, $4, $5)',
          [j.rows[0].id, ids[tradie], amount, type, message]
        );
      }
    }
    console.log(`✓ ${completedJobs.length} completed jobs with reviews and ${openJobs.length} open jobs added`);


    // One open report so the admin inbox has an example.
    await client.query(
      `INSERT INTO reports (target_type, target_id, reason, details, reporter_name, reporter_email)
       SELECT 'review', r.id, 'fake', 'I am the owner of this business and I have no record of this customer or job. Please check this review.',
              'Jack O''Brien', 'jack@example.com'
       FROM reviews r WHERE r.tradie_id = $1 LIMIT 1`,
      [ids['jack@example.com']]
    );

    console.log(`✓ Demo users added (password for all: ${DEMO_PASSWORD})`);
    console.log('  admin@example.com, customer@example.com, sam@example.com (Hobart), daniel@example.com (Sydney) … see README');
    console.log('  NOTE: demo tradies, jobs and reviews are fake. Use `npm run db:setup -- --no-demo` for a real launch.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error('Setup failed:', err.message);
  process.exitCode = 1;
});
