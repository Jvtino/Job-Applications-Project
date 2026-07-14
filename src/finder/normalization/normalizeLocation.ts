import type { RemoteType } from '../shared';

export interface NormalizedLocation {
  /** 'city, st' lowercase; '' when unknown; 'remote' for pure-remote roles. */
  locationNormalized: string;
  /** Only set when the location text itself signals it; else 'unknown'. */
  remoteType: RemoteType;
}

const STATE_ABBR: Record<string, string> = {
  alabama: 'al',
  alaska: 'ak',
  arizona: 'az',
  arkansas: 'ar',
  california: 'ca',
  colorado: 'co',
  connecticut: 'ct',
  delaware: 'de',
  florida: 'fl',
  georgia: 'ga',
  hawaii: 'hi',
  idaho: 'id',
  illinois: 'il',
  indiana: 'in',
  iowa: 'ia',
  kansas: 'ks',
  kentucky: 'ky',
  louisiana: 'la',
  maine: 'me',
  maryland: 'md',
  massachusetts: 'ma',
  michigan: 'mi',
  minnesota: 'mn',
  mississippi: 'ms',
  missouri: 'mo',
  montana: 'mt',
  nebraska: 'ne',
  nevada: 'nv',
  'new hampshire': 'nh',
  'new jersey': 'nj',
  'new mexico': 'nm',
  'new york': 'ny',
  'north carolina': 'nc',
  'north dakota': 'nd',
  ohio: 'oh',
  oklahoma: 'ok',
  oregon: 'or',
  pennsylvania: 'pa',
  'rhode island': 'ri',
  'south carolina': 'sc',
  'south dakota': 'sd',
  tennessee: 'tn',
  texas: 'tx',
  utah: 'ut',
  vermont: 'vt',
  virginia: 'va',
  washington: 'wa',
  'west virginia': 'wv',
  wisconsin: 'wi',
  wyoming: 'wy',
  'district of columbia': 'dc',
};

/** The 50 states + DC as lowercase two-letter codes. Exported for US classification. */
export const US_STATE_CODES = new Set(Object.values(STATE_ABBR));
const STATE_CODES = US_STATE_CODES;

const CITY_ALIASES: Record<string, string> = {
  nyc: 'new york, ny',
  sf: 'san francisco, ca',
  la: 'los angeles, ca',
  dc: 'washington, dc',
};

const COUNTRY_SUFFIXES = [
  'united states of america',
  'united states',
  'usa',
  'us',
  'u.s.',
  'u.s.a.',
  'america',
];

const REMOTE_PATTERN = /\b(remote|work from home|wfh|anywhere)\b/i;
const HYBRID_PATTERN = /\bhybrid\b/i;

/**
 * Raw location text → canonical 'city, st' + remote signal. Handles state
 * name expansion, country suffixes, parenthetical arrangements, aliases, and
 * multi-location strings (first location wins; the rest ride along in raw).
 */
export function normalizeLocation(locationRaw: string | null): NormalizedLocation {
  if (!locationRaw) return { locationNormalized: '', remoteType: 'unknown' };

  let text = locationRaw.trim().toLowerCase();

  const hybrid = HYBRID_PATTERN.test(text);
  const remote = REMOTE_PATTERN.test(text);

  // Strip parentheticals ("(hybrid)", "(remote eligible)") after sampling them.
  text = text.replace(/\([^)]*\)/g, ' ');
  // Multiple locations: take the first.
  text = text.split(/[;|/•]| or /)[0] ?? '';
  // Remote/hybrid markers out of the location text itself.
  text = text
    .replace(/\b(remote|hybrid|work from home|wfh|anywhere)\b[\s,-]*/gi, ' ')
    .replace(/^[\s,–—-]+|[\s,–—-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const remoteType: RemoteType = hybrid ? 'hybrid' : remote ? 'remote' : 'unknown';

  if (text.length === 0) {
    return { locationNormalized: remote ? 'remote' : '', remoteType };
  }

  const alias = CITY_ALIASES[text];
  if (alias) {
    return { locationNormalized: alias, remoteType };
  }

  // Tokenize on commas; drop country parts.
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !COUNTRY_SUFFIXES.includes(p));

  // Expand a full state name to its code — but ONLY in the trailing (state)
  // position. Mapping every part would destroy city names that double as
  // state names ("New York, NY" → "ny, ny"; "Washington, DC" → "wa, dc").
  if (parts.length > 0) {
    const lastIndex = parts.length - 1;
    parts[lastIndex] = STATE_ABBR[parts[lastIndex]!] ?? parts[lastIndex]!;
  }

  if (parts.length === 0) {
    return { locationNormalized: remote ? 'remote' : '', remoteType };
  }

  // 'city, st' when the last part is a state code; else join what remains.
  const last = parts[parts.length - 1]!;
  if (parts.length >= 2 && STATE_CODES.has(last)) {
    return { locationNormalized: `${parts.slice(0, -1).join(' ')}, ${last}`, remoteType };
  }
  if (parts.length === 1 && STATE_CODES.has(parts[0]!)) {
    return { locationNormalized: parts[0]!, remoteType };
  }
  return { locationNormalized: parts.join(', '), remoteType };
}
