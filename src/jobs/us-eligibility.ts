// src/jobs/us-eligibility.ts
//
// THE single canonical US-eligibility classifier for this US-only app. Every location gate
// (discovery scoring, hard filters, apply gates) must route through here instead of copy-pasting
// a "block if a non-US token appears" blacklist. The prior approach treated a bare "Remote",
// "Worldwide", or an unlisted non-US city as US-compatible — a hard-constraint violation.
//
// This is a POSITIVE-eligibility gate: a role is automation-eligible only when it is affirmatively
// US-based (an explicit US state/city/country, or an explicit US-scoped remote). Everything
// ambiguous — plain "Remote", "Global", blank — is held for human review, NOT auto-processed.
// Anything explicitly non-US is blocked. Mixed US/non-US wording never defaults to eligible.
//
// Domain-general: it reasons about geography only, never about role family or industry.

export type UsEligibilityStatus = "eligible_us" | "needs_review" | "blocked_non_us";

export interface UsEligibility {
  status: UsEligibilityStatus;
  reason: string;
}

// ---------------------------------------------------------------------------------------
// Signal dictionaries. Kept explicit and readable; extend as real postings surface new wording.
// ---------------------------------------------------------------------------------------

// Non-US countries / regions / well-known non-US metros. A match here (without an explicit US
// signal) blocks. Word-boundary anchored so "germaNY" / "compaNY" never trip a state code, and
// "us" inside "hous..." never trips the US signal.
const NON_US = new RegExp(
  "\\b(" +
    [
      // countries / nationalities commonly seen in listings
      "canada", "canadian", "mexico", "mexican", "united kingdom", "u\\.?k\\.?", "england", "scotland",
      "wales", "ireland", "northern ireland", "france", "french", "germany", "german", "spain", "spanish",
      "portugal", "portuguese", "italy", "italian", "netherlands", "dutch", "belgium", "switzerland", "swiss",
      "austria", "sweden", "swedish", "norway", "denmark", "finland", "poland", "polish", "czech", "romania",
      "romanian", "hungary", "greece", "greek", "turkey", "turkish", "russia", "ukraine", "india", "indian",
      "pakistan", "bangladesh", "sri lanka", "china", "chinese", "hong kong", "taiwan", "japan", "japanese",
      "south korea", "korea", "singapore", "malaysia", "indonesia", "philippines", "philippine", "vietnam",
      "thailand", "australia", "australian", "new zealand", "brazil", "brazilian", "argentina", "chile",
      "colombia", "peru", "uruguay", "costa rica", "panama", "guatemala", "south africa", "nigeria", "kenya",
      "egypt", "morocco", "israel", "united arab emirates", "u\\.?a\\.?e\\.?", "saudi arabia", "qatar", "bahrain",
      // non-US regions / multi-country scopes ("worldwide"/"global" are AMBIGUOUS, handled below)
      "emea", "apac", "latam", "anz", "mena", "european union", "\\beu\\b", "europe", "european",
      "asia", "asia[- ]pacific", "middle east", "africa", "oceania",
      // non-US metros that show up without a country
      "london", "manchester", "dublin", "paris", "berlin", "munich", "frankfurt", "amsterdam", "madrid",
      "barcelona", "lisbon", "milan", "rome", "zurich", "geneva", "stockholm", "oslo", "copenhagen",
      "helsinki", "warsaw", "prague", "budapest", "athens", "istanbul", "moscow", "dubai", "abu dhabi",
      "bangalore", "bengaluru", "hyderabad", "pune", "mumbai", "delhi", "gurgaon", "noida", "chennai",
      "beijing", "shanghai", "shenzhen", "tokyo", "osaka", "seoul", "sydney", "melbourne", "auckland",
      "toronto", "vancouver", "montreal", "ottawa", "calgary", "sao paulo", "são paulo", "mexico city",
      "buenos aires", "bogota", "bogotá", "tel aviv", "cairo", "lagos", "nairobi", "cape town", "johannesburg",
    ].join("|") +
    ")\\b",
  "i"
);

// "worldwide" / "global" / "anywhere" are AMBIGUOUS (could include the US) — they must not block,
// but must not auto-pass either.
const AMBIGUOUS_REMOTE = /\b(worldwide|world[- ]?wide|global|globally|anywhere|international|nationwide)\b/i;

const REMOTE = /\b(remote|work from home|wfh|distributed|telecommute|virtual)\b/i;

// Explicit US country signals. Lookarounds (not \b) so trailing periods in "u.s." / "u.s.a."
// don't break the boundary, and the "us" token never matches inside a word ("bonus", "focus").
const US_COUNTRY = /(?<![a-z])(?:united states(?: of america)?|u\.?\s?s\.?\s?a\.?|usa|u\.\s?s\.?|us)(?![a-z])/i;

// A US-scoped remote: "Remote - US", "US Remote", "Remote (United States)", "US only",
// "Remote within the United States", "Remote, USA".
const US_REMOTE =
  /\b(remote[^a-z]{0,4}(us|u\.?s\.?a?|united states)|(us|u\.?s\.?a?|united states)[^a-z]{0,4}remote|remote[^.]{0,20}\b(within|in)\b[^.]{0,10}(the )?(us|united states)|us[- ]based remote|us[- ]only)\b/i;

// Full US state / territory names.
const US_STATE_NAMES = new RegExp(
  "\\b(" +
    [
      "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
      "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
      "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri",
      "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york",
      "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
      "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington",
      "west virginia", "wisconsin", "wyoming", "district of columbia", "puerto rico",
    ].join("|") +
    ")\\b",
  "i"
);

// US state / territory two-letter codes. Matched ONLY as a standalone token that follows a comma
// or is bounded by spaces (the "City, ST" and "ST" forms), so English words like "in"/"or"/"me"/
// "hi"/"ok"/"oh" in prose don't masquerade as Indiana/Oregon/Maine/Hawaii/Oklahoma/Ohio.
const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR";
const US_STATE_CODE_AFTER_COMMA = new RegExp(`,\\s*(?:${US_STATE_CODES})\\b`);
const US_STATE_CODE_STANDALONE = new RegExp(`(?:^|\\s)(?:${US_STATE_CODES})(?=\\s|,|$)`);

// A representative set of large US metros that appear without a state code.
const US_CITY = new RegExp(
  "\\b(" +
    [
      "new york city", "nyc", "san francisco", "sf bay area", "bay area", "silicon valley", "los angeles",
      "san diego", "san jose", "seattle", "portland", "austin", "dallas", "houston", "san antonio",
      "chicago", "boston", "cambridge", "atlanta", "miami", "orlando", "tampa", "denver", "boulder",
      "phoenix", "scottsdale", "las vegas", "salt lake city", "minneapolis", "detroit", "cleveland",
      "columbus", "cincinnati", "pittsburgh", "philadelphia", "washington dc", "washington, d.c.",
      "baltimore", "charlotte", "raleigh", "durham", "nashville", "memphis", "new orleans", "kansas city",
      "st. louis", "saint louis", "indianapolis", "milwaukee", "sacramento", "oakland", "san mateo",
      "palo alto", "mountain view", "sunnyvale", "santa clara", "irvine", "brooklyn",
    ].join("|") +
    ")\\b",
  "i"
);

/** True when the text carries an affirmative US-geography signal (state, city, country, US-remote). */
export function hasUsSignal(text: string): boolean {
  return (
    US_REMOTE.test(text) ||
    US_STATE_NAMES.test(text) ||
    US_CITY.test(text) ||
    US_STATE_CODE_AFTER_COMMA.test(text) ||
    US_STATE_CODE_STANDALONE.test(text) ||
    US_COUNTRY.test(text)
  );
}

/** True when the text carries an explicit non-US country / region / metro signal. */
export function hasNonUsSignal(text: string): boolean {
  return NON_US.test(text);
}

/**
 * Classify a role's US eligibility from its location string (+ optional description for extra
 * context). Returns one of three statuses; the caller decides how each maps to scoring/gating.
 *
 * Decision order (safety-first):
 *   1. Explicit non-US present:
 *        - and NO explicit US signal  -> blocked_non_us
 *        - and an explicit US signal too (mixed, e.g. "US or Canada") -> needs_review (never eligible)
 *   2. No non-US, explicit US signal  -> eligible_us
 *   3. Ambiguous remote / plain remote / worldwide / blank / anything else -> needs_review
 */
export function classifyUsEligibility(location?: string | null, description?: string | null): UsEligibility {
  const loc = (location ?? "").replace(/\s+/g, " ").trim();
  // Location is the primary, high-signal field. The description is only consulted to CONFIRM a US
  // signal or surface a non-US one the terse location omitted — never to override an explicit
  // non-US location.
  const primary = loc;
  const combined = `${loc} ${(description ?? "").replace(/\s+/g, " ").trim()}`.trim();

  const usInLoc = hasUsSignal(primary);
  const nonUsInLoc = hasNonUsSignal(primary);

  // 1) Explicit non-US in the location field.
  if (nonUsInLoc) {
    if (usInLoc) {
      return { status: "needs_review", reason: `location names both US and non-US ("${loc}") — confirm the US posting` };
    }
    return { status: "blocked_non_us", reason: `explicit non-US location ("${loc}")` };
  }

  // 2) Explicit US signal in the location field → eligible.
  if (usInLoc) {
    return { status: "eligible_us", reason: US_REMOTE.test(primary) ? `US-scoped remote ("${loc}")` : `explicit US location ("${loc}")` };
  }

  // No decisive signal in the location FIELD. Consult the surrounding text (title/description) for a
  // non-US red flag — this catches "Analyst | Ontario, Canada" when the structured location is blank.
  // A non-US mention with NO offsetting US signal blocks; a US signal in the body is too weak to
  // auto-PROMOTE to eligible, so mixed text only ever falls through to needs_review.
  if (hasNonUsSignal(combined) && !hasUsSignal(combined)) {
    return { status: "blocked_non_us", reason: loc ? `posting text indicates a non-US location ("${loc}")` : "posting text indicates a non-US location" };
  }

  // 3) Ambiguous or empty.
  if (!loc) return { status: "needs_review", reason: "no location stated — confirm this is a US role" };
  if (AMBIGUOUS_REMOTE.test(primary)) {
    return { status: "needs_review", reason: `location is unscoped ("${loc}") — could include non-US; confirm US eligibility` };
  }
  if (REMOTE.test(primary)) {
    return { status: "needs_review", reason: `plain "remote" without a US scope — confirm US eligibility` };
  }
  return { status: "needs_review", reason: `location "${loc}" is not clearly US — confirm eligibility` };
}

/** Convenience: is this role affirmatively US-based (the ONLY status automation may act on)? */
export function isUsEligible(location?: string | null, description?: string | null): boolean {
  return classifyUsEligibility(location, description).status === "eligible_us";
}

/** Convenience: is this role explicitly non-US (a hard block)? */
export function isBlockedNonUs(location?: string | null, description?: string | null): boolean {
  return classifyUsEligibility(location, description).status === "blocked_non_us";
}
