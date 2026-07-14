import { createHash } from 'node:crypto';

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

/** Tracking params that make identical apply URLs look different (§17 / R4). */
const TRACKING_PARAMS = /^(utm_|gh_|lever-|ref$|ref_|source$|src$|fbclid|gclid|mc_)/i;

/**
 * Canonical URL form for dedupe: lowercase scheme+host, tracking params and
 * fragments stripped, remaining query sorted, trailing slash dropped, default
 * ports removed. Conservative — path and non-tracking params are preserved.
 */
export function canonicalizeUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return rawUrl.trim().toLowerCase();
  }
  url.hash = '';
  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (!TRACKING_PARAMS.test(key)) kept.push([key, value]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  const query = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : '';
  const path = url.pathname.replace(/\/+$/, '') || '';
  return `${url.protocol}//${url.host.toLowerCase()}${path}${query}`;
}

export function urlHash(rawUrl: string): string {
  return sha256(canonicalizeUrl(rawUrl));
}

/** '<source_type>:<source_id>:<external_id>' — identity of a posting on its board. */
export function atsKey(sourceType: string, sourceId: string, externalJobId: string): string {
  return `${sourceType}:${sourceId}:${externalJobId}`;
}

/** Hash of the whitespace-normalized clean description (token stream). */
export function descriptionHash(descriptionClean: string): string | null {
  const normalized = descriptionClean.toLowerCase().replace(/\s+/g, ' ').trim();
  // Short blurbs ("Apply now!") collide constantly and carry no identity.
  if (normalized.length < 120) return null;
  return sha256(normalized);
}

/** Company+title+location candidate key (canonical forms from ../normalization). */
export function ctlKey(
  canonicalCompany: string,
  canonicalTitle: string,
  canonicalLocation: string,
): string | null {
  if (!canonicalCompany || !canonicalTitle) return null;
  return sha256(`${canonicalCompany}|${canonicalTitle}|${canonicalLocation}`);
}
