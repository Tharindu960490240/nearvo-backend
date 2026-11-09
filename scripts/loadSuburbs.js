// Loads Australian suburbs & postcodes into the `suburbs` table.
// Source (first that works):
//   1. LOCALITIES_CSV_FILE - path to a local CSV
//   2. LOCALITIES_CSV_URL  - URL to download (defaults to the community-maintained list below)
//   3. db/suburbs-fallback.json - ~110 capital-city suburbs and regional centres, bundled
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV_URL = 'https://raw.githubusercontent.com/matthewproctor/australianpostcodes/master/australian_postcodes.csv';
const STATE_CODES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const titleCase = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s\-'(])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : s);

async function readRows() {
  let text = null;
  if (process.env.LOCALITIES_CSV_FILE) {
    text = fs.readFileSync(process.env.LOCALITIES_CSV_FILE, 'utf8');
  } else {
    try {
      console.log('  Downloading Australian suburbs & postcodes...');
      const res = await fetch(process.env.LOCALITIES_CSV_URL || DEFAULT_CSV_URL, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      console.warn(`  Could not download suburbs (${err.message}); using the bundled fallback list.`);
    }
  }
  if (text) {
    const [header, ...data] = parseCsv(text);
    const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
    const seen = new Map();
    for (const r of data) {
      const type = r[col.type] || '';
      const state = r[col.state];
      const postcode = (r[col.postcode] || '').padStart(4, '0');
      if (!STATE_CODES.includes(state) || !['Delivery Area', ''].includes(type)) continue;
      const precise = type === 'Delivery Area' && Number(r[col.Lat_precise]);
      const lat = precise ? Number(r[col.Lat_precise]) : Number(r[col.lat]);
      const lng = precise ? Number(r[col.Long_precise]) : Number(r[col.long]);
      if (!lat || !lng || !/^\d{4}$/.test(postcode)) continue;
      const name = titleCase(r[col.locality].trim());
      const key = `${name}|${postcode}|${state}`;
      if (seen.has(key) && seen.get(key)[5] === 'Delivery Area') continue;
      seen.set(key, [name, postcode, state, lat, lng, type]);
    }
    if (seen.size > 1000) return [...seen.values()].map((r) => r.slice(0, 5));
    console.warn('  Suburb file looked incomplete; using the bundled fallback list.');
  }
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../db/suburbs-fallback.json'), 'utf8'));
}

export async function loadSuburbs(db) {
  const rows = await readRows();
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await db.query(
      `INSERT INTO suburbs (name, postcode, state, latitude, longitude)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::float8[])
       ON CONFLICT DO NOTHING`,
      [0, 1, 2, 3, 4].map((c) => chunk.map((r) => r[c]))
    );
  }
  return rows.length;
}
