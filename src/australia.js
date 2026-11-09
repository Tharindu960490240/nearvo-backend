// Australia-specific constants and validators.

export const STATES = {
  NSW: 'New South Wales',
  VIC: 'Victoria',
  QLD: 'Queensland',
  WA: 'Western Australia',
  SA: 'South Australia',
  TAS: 'Tasmania',
  ACT: 'Australian Capital Territory',
  NT: 'Northern Territory',
};

// Mainland + Tasmania + Torres Strait + Lord Howe Island.
// (External territories such as Norfolk / Christmas Island are outside this box.)
export const AU_BOUNDS = { minLat: -44.5, maxLat: -9.0, minLng: 112.0, maxLng: 160.0 };

export const inAustralia = (lat, lng) =>
  lat >= AU_BOUNDS.minLat && lat <= AU_BOUNDS.maxLat && lng >= AU_BOUNDS.minLng && lng <= AU_BOUNDS.maxLng;

// First digit of each state's postcode range (ACT and NT share 2xxx/0xxx ranges).
const POSTCODE_PREFIX = { NSW: ['1', '2'], ACT: ['0', '2'], VIC: ['3', '8'], QLD: ['4', '9'], SA: ['5'], WA: ['6'], TAS: ['7'], NT: ['0'] };

export const isValidPostcode = (postcode, state) =>
  /^\d{4}$/.test(postcode) && (!state || POSTCODE_PREFIX[state]?.includes(postcode[0]));

// ABN checksum per the Australian Business Register algorithm.
export function isValidAbn(abn) {
  const digits = String(abn).replace(/\s/g, '');
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = digits.split('').reduce((acc, d, i) => acc + (Number(d) - (i === 0 ? 1 : 0)) * weights[i], 0);
  return sum % 89 === 0;
}

// ACN checksum per ASIC: weights 8..1 over the first 8 digits; check digit = (10 - sum % 10) % 10.
export function isValidAcn(acn) {
  const d = String(acn).replace(/\s/g, '');
  if (!/^\d{9}$/.test(d)) return false;
  const sum = [8, 7, 6, 5, 4, 3, 2, 1].reduce((acc, w, i) => acc + Number(d[i]) * w, 0);
  return (10 - (sum % 10)) % 10 === Number(d[8]);
}

// Accepts landlines (02/03/07/08), mobiles (04), 13/1300/1800 numbers, with optional +61.
export function normaliseAuPhone(phone) {
  let p = String(phone).replace(/[\s\-().]/g, '');
  if (p.startsWith('+61')) p = '0' + p.slice(3);
  if (/^0[2378]\d{8}$/.test(p)) return `(${p.slice(0, 2)}) ${p.slice(2, 6)} ${p.slice(6)}`;
  if (/^04\d{8}$/.test(p)) return `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}`;
  if (/^1[38]00\d{6}$/.test(p)) return `${p.slice(0, 4)} ${p.slice(4, 7)} ${p.slice(7)}`;
  if (/^13\d{4}$/.test(p)) return `${p.slice(0, 2)} ${p.slice(2, 4)} ${p.slice(4)}`;
  return null;
}
