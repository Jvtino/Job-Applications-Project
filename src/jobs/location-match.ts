// src/jobs/location-match.ts
//
// Domain-general US location matching for the desired-location hard filter. Two bugs motivated this:
//   1. desired "Brooklyn, NY" was stored as ["Brooklyn","NY"], and the matcher used naive substring
//      `locText.includes("ny")` — which matched "germaNY"/"compaNY" and MISSED "New York, New York"
//      (state spelled out). Real NYC roles were rejected; some non-NY roles slipped through.
//   2. State name <-> abbreviation were never reconciled ("New York" never matched "NY").
//
// This module matches on word boundaries, reconciles state name<->abbr both ways, and expands a small
// set of major-metro aliases. It is US-general (any city/state), not tuned to one profile.

const STATE_ABBR_TO_NAME: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
  ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho",
  il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi",
  mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio",
  ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia",
  wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", dc: "district of columbia",
};
const STATE_NAME_TO_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_ABBR_TO_NAME).map(([abbr, name]) => [name, abbr])
);

// Major-metro nicknames -> the location tokens that should count as the same place. Kept small and
// US-general; extend as needed. Each alias key, when present in a desired OR job location, also matches
// any of its expansion tokens.
const METRO_ALIASES: Record<string, string[]> = {
  nyc: ["new york", "ny", "manhattan", "brooklyn", "queens", "bronx"],
  "new york city": ["new york", "ny", "manhattan", "brooklyn", "queens", "bronx"],
  "bay area": ["san francisco", "ca", "oakland", "san jose", "palo alto", "mountain view"],
  sf: ["san francisco", "ca"],
  la: ["los angeles", "ca"],
  dc: ["washington", "district of columbia"],
  "d.c.": ["washington", "district of columbia"],
};

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whole-word/phrase test: `needle` appears in `hay` at word boundaries (so "ny" misses "germany"). */
function hasWord(hay: string, needle: string): boolean {
  const n = needle.trim();
  if (!n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, "i").test(hay);
}

/** Expand one location string into all the surface tokens that should count as "the same place". */
function expandTokens(loc: string): string[] {
  const out = new Set<string>();
  const base = norm(loc);
  if (!base) return [];
  out.add(base);

  // Metro aliases (whole phrase).
  for (const [alias, tokens] of Object.entries(METRO_ALIASES)) {
    if (base === alias || hasWord(base, alias)) for (const t of tokens) out.add(t);
  }

  // Split "City, ST" / "City, State" into city + state, and reconcile state name<->abbr.
  const parts = base.split(",").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    out.add(part);
    if (STATE_ABBR_TO_NAME[part]) out.add(STATE_ABBR_TO_NAME[part]); // ny -> new york
    if (STATE_NAME_TO_ABBR[part]) out.add(STATE_NAME_TO_ABBR[part]); // new york -> ny
  }
  // Whole-string state reconciliation too (e.g. desired is bare "New York" or "NY").
  if (STATE_ABBR_TO_NAME[base]) out.add(STATE_ABBR_TO_NAME[base]);
  if (STATE_NAME_TO_ABBR[base]) out.add(STATE_NAME_TO_ABBR[base]);

  return [...out].filter(Boolean);
}

/** A 2-letter US state abbreviation ("NY","CA"). Used to re-join "City, ST" — full state NAMES are
 *  deliberately excluded because "New York"/"Washington" are also cities and would over-merge. */
function isStateAbbr(token: string): boolean {
  const t = norm(token);
  return /^[a-z]{2}$/.test(t) && Boolean(STATE_ABBR_TO_NAME[t]);
}

/**
 * Parse a user-entered location list into clean entries WITHOUT shredding "City, ST". Splits on
 * newlines/semicolons first; for comma-separated input, re-joins a bare state token onto the preceding
 * city so "Brooklyn, NY, Jersey City, NJ" -> ["Brooklyn, NY", "Jersey City, NJ"] rather than four pieces.
 * This is the fix for the profile-form bug that stored "Brooklyn, NY" as ["Brooklyn","NY"].
 */
export function parseLocationList(input: string): string[] {
  const out: string[] = [];
  for (const chunk of input.split(/[\n;]+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    if (!trimmed.includes(",")) {
      out.push(trimmed);
      continue;
    }
    for (const frag of trimmed.split(",").map((f) => f.trim()).filter(Boolean)) {
      if (isStateAbbr(frag) && out.length && !isStateAbbr(out[out.length - 1]!)) {
        out[out.length - 1] = `${out[out.length - 1]}, ${frag}`;
      } else {
        out.push(frag);
      }
    }
  }
  return out;
}

/**
 * Does a job location satisfy ANY of the candidate's desired locations? Word-boundary, state-aware,
 * metro-alias-aware. `desiredLocations` may be the historically-split form (["Brooklyn","NY"]) or
 * clean ("Brooklyn, NY") — both work, since each desired entry is expanded to its tokens.
 */
export function locationMatchesDesired(desiredLocations: string[], jobLocation: string): boolean {
  const hay = norm(jobLocation);
  if (!hay) return false;
  for (const desired of desiredLocations) {
    for (const token of expandTokens(desired)) {
      // A 2-letter token is a state abbr: only a word-boundary match counts (avoids "ny" in "germany").
      // Longer tokens use word-boundary match too, which also covers multi-word phrases.
      if (hasWord(hay, token)) return true;
    }
  }
  return false;
}
