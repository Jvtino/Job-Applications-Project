// src/generation/claim-extraction.ts
//
// Decompose a generated document into atomic claims, and pull the verifiable tokens out of
// text: numbers, years, and proper-noun / organization-like named entities. These are the
// things the deterministic ledger gate insists must trace back to an approved fact.

import type { Claim } from "./ledger-check";

/** Split a document into claim-sized units: bullet lines and sentences. */
export function extractClaims(documentText: string): Claim[] {
  const claims: Claim[] = [];
  for (const rawLine of documentText.split("\n")) {
    const line = rawLine.replace(/^\s*(?:[-•*▪◦‣·]|–)\s+/, "").trim();
    if (!line) continue;
    // Drop structural/section-header lines (very short, no verb/number/entity to verify).
    if (line.length < 3) continue;
    // A bullet often holds multiple sentences; split them.
    for (const sentence of splitSentences(line)) {
      const text = sentence.trim();
      if (text) claims.push({ text });
    }
  }
  return claims;
}

// Honorifics and short abbreviations whose trailing period is NOT a sentence
// boundary — splitting after them shatters one sentence into fragments
// ("Reported to Mr. Chen" -> "Reported to Mr." + "Chen ..."). Lowercased for
// case-insensitive lookup.
//
// Org suffixes (Inc, Corp, Ltd, Co, LLC) are DELIBERATELY excluded: they
// genuinely end sentences ("Joined Acme Inc. Grew the desk."), so suppressing
// splits after them would merge two real sentences into one claim — and
// under-splitting is the dangerous direction here, because a fabricated
// statement could then hide inside the merged claim and slip past the
// deterministic ledger gate. When in doubt we keep splitting.
const NON_BOUNDARY_ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "mx", "prof", "sr", "jr",
  "st", "ave", "rd", "no", "vs", "etc",
]);

// Abbreviations written with internal periods, matched as a whole at the split
// point: e.g. / i.e. / a.m. / p.m. (capitalized forms like "A.M." are handled by
// the single-initial rule below, since their last letter is a lone capital).
const DOTTED_ABBREVIATION = /(?:^|[^A-Za-z0-9])(?:e\.g|i\.e|a\.m|p\.m)\.$/i;

/**
 * Decide whether the "." at `periodIdx` is a real sentence boundary or part of
 * an abbreviation / personal initial. Only "." is ambiguous; "!" and "?" always
 * end a sentence. A period is treated as a NON-boundary when it immediately
 * follows:
 *   - a dotted abbreviation (e.g., i.e., a.m., p.m.), or
 *   - a lone capital letter — a personal initial ("J.", "P.", "A."), or
 *   - an allowlisted honorific/abbreviation ("Dr.", "St.", "etc.").
 * The letter run must start at a word boundary (not be preceded by a letter or
 * digit), so "21st." (an ordinal) and "KYC." are still real boundaries.
 */
function isNonBoundaryPeriod(text: string, periodIdx: number): boolean {
  if (text[periodIdx] !== ".") return false;
  if (DOTTED_ABBREVIATION.test(text.slice(0, periodIdx + 1))) return true;

  // The run of letters immediately before the period, and what precedes it.
  let i = periodIdx - 1;
  while (i >= 0 && /[A-Za-z]/.test(text[i]!)) i--;
  const token = text.slice(i + 1, periodIdx);
  const precededByAlnum = i >= 0 && /[A-Za-z0-9]/.test(text[i]!);
  if (!token || precededByAlnum) return false;

  if (token.length === 1 && /[A-Z]/.test(token)) return true; // personal initial
  return NON_BOUNDARY_ABBREVIATIONS.has(token.toLowerCase());
}

/**
 * Split text into sentences on ".", "!", or "?" followed by whitespace and a
 * capital/digit — the same boundary shape the gate has always used — but skip
 * boundaries that are really abbreviations or personal initials (see
 * `isNonBoundaryPeriod`). Deterministic and dependency-free: every split is
 * explainable from the characters around the period alone, with no length- or
 * probability-based heuristics.
 */
export function splitSentences(text: string): string[] {
  const boundary = /[.!?]\s+(?=[A-Z0-9])/g;
  const sentences: string[] = [];
  let start = 0;
  for (let m = boundary.exec(text); m !== null; m = boundary.exec(text)) {
    if (isNonBoundaryPeriod(text, m.index)) continue;
    sentences.push(text.slice(start, m.index + 1).trim());
    start = m.index + m[0].length; // resume just past the boundary whitespace
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.filter(Boolean);
}

/** Normalized numeric values appearing in text (commas stripped, % and units dropped). */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) {
    out.push(m[0].replace(/,/g, ""));
  }
  return out;
}

/** Four-digit years specifically (a frequent fabrication vector for employment dates). */
export function extractYears(text: string): string[] {
  return [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
}

// Common words that are routinely capitalized (sentence start, headers, generic resume
// vocabulary) and must NOT be treated as ledger-bound named entities.
const COMMON_WORDS = new Set(
  [
    "the","a","an","and","or","but","for","to","of","in","on","at","by","with","from","as",
    "i","we","my","our","me","you","your","it","this","that","these","those","their","his","her",
    "led","managed","built","created","developed","designed","drove","delivered","improved",
    "increased","reduced","launched","owned","ran","oversaw","spearheaded","implemented",
    "collaborated","partnered","achieved","responsible","experience","experienced","skilled",
    "proficient","summary","education","skills","certifications","languages","projects",
    "dear","hiring","manager","team","sincerely","regards","thank","please","role","position",
    "best","yours","truly","opportunity","consideration","application","letter","resume","cv",
    "company","am","is","are","was","were","have","has","had","will","would","can","could",
    "january","february","march","april","may","june","july","august","september","october",
    "november","december","present","current","monday","tuesday","wednesday","thursday","friday",
  ].map((w) => w)
);

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","US","USA",
]);

/**
 * Candidate named entities (organizations, institutions, product/proper names). We capture:
 *  - multi-word Capitalized sequences ("Stanford University", "Acme Corporation")
 *  - single Capitalized tokens that appear MID-sentence (not sentence-initial)
 *  - ALL-CAPS acronyms of length >= 2 ("IBM", "NASA")
 * and drop anything that is purely common words, a US state code, or a bare month.
 */
export function extractEntities(text: string): string[] {
  const found = new Set<string>();
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    // Multi-word capitalized sequences. Connectors are limited to words that occur INSIDE a
    // proper name ("Bank of America", "Johnson & Johnson"); "and"/"for" are excluded because
    // they normally join two SEPARATE entities ("SQL and Tableau"), which must verify apart.
    for (const m of sentence.matchAll(/\b([A-Z][\w&.'-]*(?:\s+(?:of|the|&)?\s*[A-Z][\w&.'-]*)+)\b/g)) {
      const phrase = m[1]!.replace(/\s+/g, " ").trim();
      if (!isCommonPhrase(phrase)) found.add(phrase);
    }
    // Single tokens (skip the sentence-initial word, which is capitalized by convention).
    const tokens = sentence.split(/\s+/);
    tokens.forEach((tok, idx) => {
      const clean = tok.replace(/^[^\w]+|[^\w]+$/g, "");
      if (!clean) return;
      const isAcronym = /^[A-Z]{2,}$/.test(clean);
      const isCapitalized = /^[A-Z][a-z][\w&.'-]*$/.test(clean);
      if (!isAcronym && !isCapitalized) return;
      if (idx === 0 && !isAcronym) return; // sentence-initial, ambiguous
      if (US_STATES.has(clean.toUpperCase())) return;
      if (COMMON_WORDS.has(clean.toLowerCase())) return;
      found.add(clean);
    });
  }
  return [...found];
}

function isCommonPhrase(phrase: string): boolean {
  const words = phrase.toLowerCase().split(/\s+/);
  return words.every((w) => COMMON_WORDS.has(w) || US_STATES.has(w.toUpperCase()));
}

/** Normalize text for substring / token containment checks. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function significantTokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .filter((t) => t.length > 2 && !COMMON_WORDS.has(t));
}
