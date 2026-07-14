import { US_STATE_CODES } from './normalizeLocation';

/**
 * US-market classification for a job's location. The app only searches U.S.
 * jobs, but the seeded Greenhouse/Lever boards are global — a US company's
 * board legitimately lists Kraków, London, and Bengaluru roles alongside its
 * US ones. This classifies each posting so the scan can drop the foreign ones.
 *
 * Deliberately three-valued and conservative: we only return `non_us` when the
 * text positively names a foreign country/region. Anything ambiguous —
 * pure-remote with no country, a bare city, empty — is `unknown` and KEPT.
 * Dropping a real US job (false `non_us`) is far worse than keeping a stray
 * foreign one, so the classifier never guesses foreign.
 */
export type UsLocationClass = 'us' | 'non_us' | 'unknown';

/** Multi-word foreign markers — matched as substrings of the raw text. */
const NON_US_MULTIWORD = [
  'united kingdom',
  'great britain',
  'northern ireland',
  'new zealand',
  'south korea',
  'north korea',
  'south africa',
  'united arab emirates',
  'saudi arabia',
  'hong kong',
  'czech republic',
  'costa rica',
  'dominican republic',
  'sri lanka',
  'el salvador',
  'puerto rico', // a US territory, but jobs there are out of the CONUS scope users expect
];

/**
 * Single-word foreign countries/abbreviations/regions — matched against
 * whole words only (so "indiana" never matches "india", "newark" never
 * matches a country). Excludes tokens that collide with US state names
 * (georgia, mexico) — those are disambiguated by the state-code check first.
 */
const NON_US_WORDS = new Set([
  'canada',
  'uk',
  'england',
  'scotland',
  'wales',
  'ireland',
  'germany',
  'deutschland',
  'france',
  'spain',
  'espana',
  'portugal',
  'italy',
  'italia',
  'netherlands',
  'holland',
  'belgium',
  'luxembourg',
  'poland',
  'polska',
  'romania',
  'ukraine',
  'sweden',
  'norway',
  'denmark',
  'finland',
  'iceland',
  'switzerland',
  'austria',
  'czechia',
  'slovakia',
  'hungary',
  'greece',
  'bulgaria',
  'croatia',
  'serbia',
  'lithuania',
  'latvia',
  'estonia',
  'india',
  'china',
  'japan',
  'singapore',
  'australia',
  'brazil',
  'brasil',
  'argentina',
  'colombia',
  'chile',
  'peru',
  'uruguay',
  'israel',
  'uae',
  'dubai',
  'qatar',
  'nigeria',
  'kenya',
  'ghana',
  'egypt',
  'morocco',
  'philippines',
  'indonesia',
  'malaysia',
  'thailand',
  'vietnam',
  'korea',
  'taiwan',
  'turkey',
  'russia',
  'pakistan',
  'bangladesh',
  // Regional groupings that are unambiguously not US-specific.
  'emea',
  'apac',
  'latam',
  'anz',
]);

/** Multi-word explicit US markers, matched as substrings ("… United States"). */
const US_MULTIWORD = ['united states', 'u.s.a', 'u.s.'];
/** Single-word US markers, matched against whole words ("Remote (US)", "USA"). */
const US_WORDS = new Set(['us', 'usa', 'america', 'stateside']);

/**
 * Classify `locationRaw` (with the already-computed `locationNormalized` from
 * {@link normalizeLocation}) as US / non-US / unknown.
 *
 * Order matters: a resolved US state code wins first, so "Mexico, MO" (Missouri)
 * and "Georgia" the state are `us`, never confused with the countries.
 */
export function classifyUsLocation(
  locationRaw: string | null,
  locationNormalized: string,
): UsLocationClass {
  // 1. A resolved US state code is decisive: 'city, st' or a bare 'st'.
  const norm = locationNormalized.trim().toLowerCase();
  const stateMatch = /,\s*([a-z]{2})$/.exec(norm);
  if (stateMatch && US_STATE_CODES.has(stateMatch[1]!)) return 'us';
  if (US_STATE_CODES.has(norm)) return 'us';

  const t = (locationRaw ?? '').toLowerCase();
  if (t.trim().length === 0) return 'unknown';

  // 2. A positively-named foreign country/region → non_us.
  for (const marker of NON_US_MULTIWORD) {
    if (t.includes(marker)) return 'non_us';
  }
  const words = t.split(/[^a-z]+/i).filter(Boolean);
  for (const w of words) {
    if (NON_US_WORDS.has(w)) return 'non_us';
  }

  // 3. An explicit US marker with no foreign signal → us.
  for (const marker of US_MULTIWORD) {
    if (t.includes(marker)) return 'us';
  }
  for (const w of words) {
    if (US_WORDS.has(w)) return 'us';
  }

  // 4. Bare city, pure remote, or anything we can't prove foreign → keep.
  return 'unknown';
}

/** Convenience predicate: true only when the location is confidently foreign. */
export function isNonUsLocation(locationRaw: string | null, locationNormalized: string): boolean {
  return classifyUsLocation(locationRaw, locationNormalized) === 'non_us';
}
