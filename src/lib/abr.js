// Australian Business Register (ABN Lookup) integration.
// Docs: https://abr.business.gov.au/json/  (JSONP responses, free GUID from the ABR)
import { isValidAbn, isValidAcn } from '../australia.js';

const BASE = (process.env.ABR_BASE_URL || 'https://abr.business.gov.au/json').replace(/\/$/, '');
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

export const abrEnabled = () => Boolean(process.env.ABR_GUID);

export class AbrError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

function parseJsonp(text) {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  const body = start >= 0 && end > start ? text.slice(start + 1, end) : text;
  return JSON.parse(body);
}

/**
 * Looks up an ABN (11 digits) or ACN (9 digits) and returns normalised details.
 * Throws AbrError for invalid / not found / inactive numbers or when the service is unavailable.
 */
export async function lookupBusinessNumber(raw, { fresh = false } = {}) {
  const number = String(raw || '').replace(/[\s-]/g, '');
  const kind = number.length === 11 ? 'abn' : number.length === 9 ? 'acn' : null;
  if (!kind || !/^\d+$/.test(number)) throw new AbrError('Enter an 11-digit ABN or a 9-digit ACN', 'ABN_FORMAT');
  if (kind === 'abn' && !isValidAbn(number)) throw new AbrError("That ABN isn't valid. Please check the digits.", 'ABN_CHECKSUM');
  if (kind === 'acn' && !isValidAcn(number)) throw new AbrError("That ACN isn't valid. Please check the digits.", 'ACN_CHECKSUM');

  // Without a GUID (local development) only the checksum can be confirmed.
  if (!abrEnabled()) {
    return { abn: kind === 'abn' ? number : null, acn: kind === 'acn' ? number : null, status: 'Unchecked', source: 'checksum', entity_name: null, business_names: [] };
  }

  const hit = fresh ? null : cache.get(number);   // re-checks always ask the ABR again
  if (hit && hit.expires > Date.now()) return hit.value;

  const url = `${BASE}/${kind === 'abn' ? 'AbnDetails' : 'AcnDetails'}.aspx?${kind}=${number}&callback=callback&guid=${encodeURIComponent(process.env.ABR_GUID)}`;
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = parseJsonp(await res.text());
  } catch (err) {
    console.error('ABN Lookup request failed:', err.message);
    throw new AbrError("We couldn't reach the ABN Lookup service. Please try again in a minute.", 'ABR_UNAVAILABLE', 503);
  }

  if (data.Message) {
    // e.g. GUID problems or "Search text is not a valid ABN or ACN"
    if (/guid/i.test(data.Message)) {
      console.error('ABN Lookup GUID problem:', data.Message);
      throw new AbrError('ABN checking is temporarily unavailable. Please try again later.', 'ABR_UNAVAILABLE', 503);
    }
    throw new AbrError(`ABN Lookup: ${data.Message}`, 'ABN_NOT_FOUND');
  }
  const abn = /^\d{11}$/.test(String(data.Abn || '')) ? String(data.Abn) : null;
  if (!abn && !data.EntityName) throw new AbrError(`No business was found for that ${kind.toUpperCase()}`, 'ABN_NOT_FOUND');

  const value = {
    abn,
    acn: /^\d{9}$/.test(String(data.Acn || '')) ? String(data.Acn) : kind === 'acn' ? number : null,
    status: data.AbnStatus || 'Unknown',
    status_from: data.AbnStatusEffectiveFrom || null,
    entity_name: data.EntityName || null,
    entity_type: data.EntityTypeName || null,
    gst_from: data.Gst || null,
    state: data.AddressState || null,
    postcode: data.AddressPostcode || null,
    business_names: Array.isArray(data.BusinessName) ? data.BusinessName.filter(Boolean) : [],
    source: 'abr',
  };

  if (!/^active$/i.test(value.status)) {
    throw new AbrError(`This ${kind.toUpperCase()} is not active (status: ${value.status}). Tradies need an active ABN to join Nearvo.`, 'ABN_INACTIVE');
  }
  if (!value.abn) {
    throw new AbrError('We found the company, but no active ABN is linked to that ACN. Please enter your ABN instead.', 'ABN_MISSING');
  }

  cache.set(number, { value, expires: Date.now() + CACHE_MS });
  return value;
}

/** Columns to store on tradie_profiles after a successful lookup. */
export const abrColumns = (r) => ({
  abn: r.abn,
  acn: r.acn,
  abn_entity_name: r.entity_name,
  abn_status: r.status,
  abn_gst_registered: r.gst_from ? true : r.source === 'abr' ? false : null,
  abn_check: r.source,
});
