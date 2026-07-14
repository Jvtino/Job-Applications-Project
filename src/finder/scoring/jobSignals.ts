import {
  canonicalSkillKey,
  CERTIFICATION_DICTIONARY,
  dedupeByCanonicalSkill,
  dictionaryMatches,
  SKILL_DICTIONARY,
} from '../shared';

/** What the job posting itself asks for, extracted from its text. */
export interface JobSignals {
  requiredSkills: string[];
  preferredSkills: string[];
  requiredCerts: string[];
  /** Minimum years demanded ("3+ years", "at least 5 years"), if stated. */
  minYears: number | null;
  /** Degree demanded by the posting, if any. */
  requiredDegree: 'bachelor' | 'master' | 'phd' | 'associate' | null;
}

const REQUIRED_HEADINGS =
  /(requirements|qualifications|what you(?:'|’)ll need|what we(?:'|’)re looking for|who you are|must have|minimum qualifications|basic qualifications|required skills)/i;
const PREFERRED_HEADINGS =
  /(nice to have|preferred qualifications|preferred skills|bonus points|plus(?:es)?:|great to have|desired)/i;

// "5+ years experience", "3-5 years of experience", "2+ years of regulatory
// compliance experience". Range-aware (take the low end) and tolerant of domain
// words between "years" and "experience", but bounded to one clause (no period /
// newline) so it stays within a single requirement.
const MIN_YEARS_G =
  /(\d{1,2})\s*(?:[-–—]\s*\d{1,2})?\s*\+?\s*years?['’]?[^.\n]{0,40}?\bexperience/gi;
const AT_LEAST_YEARS_G = /at least\s+(\d{1,2})\s+years?/gi;
// A "N years … experience" span that is NOT a candidate requirement — company
// tenure or a combined team total. Tested against the whole matched span.
const YEARS_FALSE = /combined|collective|\bteam['’]?s?\b|company|firm|founded|in business|of history/i;

/** Lowest stated years-of-experience bar in the text, ignoring company/tenure boilerplate. */
function extractMinYears(text: string): number | null {
  const candidates: number[] = [];
  for (const m of text.matchAll(MIN_YEARS_G)) {
    if (YEARS_FALSE.test(m[0])) continue; // e.g. "20 years of combined team experience"
    candidates.push(Number(m[1])); // group 1 = low end of a range, or the single value
  }
  for (const m of text.matchAll(AT_LEAST_YEARS_G)) candidates.push(Number(m[1]));
  return candidates.length ? Math.min(...candidates) : null;
}

// Degree demanded by the posting. Tolerant of the many surface forms real
// postings use — "Bachelor degree" (no apostrophe-s), "bachelor's", "BS/BA
// degree", "undergraduate/college/four-year degree", "degree in <field>".
const DEGREE_DEMAND: Array<[RegExp, JobSignals['requiredDegree']]> = [
  [/\b(ph\.?d|doctorate|doctoral degree)\b/i, 'phd'],
  [
    /\b(master(?:'|’)?s?(?:\s+degree)?|m\.?s\.?\s+degree|m\.?a\.?\s+degree|mba|graduate degree)\b/i,
    'master',
  ],
  [
    /\b(bachelor(?:'|’)?s?(?:\s+degree)?|b\.?s\.?\s+degree|b\.?a\.?\s+degree|four[- ]year degree|4-year degree|undergraduate degree|college degree|degree in\b)/i,
    'bachelor',
  ],
  [/\b(associate(?:'|’)?s?(?:\s+degree)?)\b/i, 'associate'],
];

/**
 * Splits the description at required/preferred headings and dictionary-extracts
 * skills from each region. When no headings exist (common), the whole
 * description counts as "required-ish" — a softer signal the scorer treats
 * accordingly.
 */
export function extractJobSignals(descriptionClean: string): JobSignals & {
  /** false when no explicit required section was found (whole-text fallback). */
  hasExplicitSections: boolean;
} {
  const text = descriptionClean;
  const lines = text.split('\n');

  // Three buckets: text before any heading ("neutral"), text under a required
  // heading, and text under a preferred heading.
  let neutralText = '';
  let requiredText = '';
  let preferredText = '';
  let bucket: 'none' | 'required' | 'preferred' = 'none';
  for (const line of lines) {
    const isHeadingish = line.trim().length <= 60;
    if (isHeadingish && PREFERRED_HEADINGS.test(line)) {
      bucket = 'preferred';
      continue;
    }
    if (isHeadingish && REQUIRED_HEADINGS.test(line)) {
      bucket = 'required';
      continue;
    }
    if (bucket === 'required') requiredText += line + '\n';
    else if (bucket === 'preferred') preferredText += line + '\n';
    else neutralText += line + '\n';
  }

  // Only an explicit "Requirements"-style heading counts as a hard requirement
  // section. Without one, we score against the NON-preferred body (never the
  // preferred section — a "Preferred qualifications" list is not a requirement),
  // and the caller treats these as a soft "mentioned" signal, not a hard bar.
  const hasExplicitRequired = requiredText.trim().length > 0;
  const nonPreferred = `${neutralText}\n${requiredText}`;
  const requiredRegion = hasExplicitRequired
    ? requiredText
    : nonPreferred.trim()
      ? nonPreferred
      : text;

  const requiredSkills = dedupeByCanonicalSkill(dictionaryMatches(requiredRegion, SKILL_DICTIONARY));
  const requiredKeys = new Set(requiredSkills.map(canonicalSkillKey));
  const preferredOnly = dedupeByCanonicalSkill(
    dictionaryMatches(preferredText, SKILL_DICTIONARY),
  ).filter((s) => !requiredKeys.has(canonicalSkillKey(s)));
  const requiredCerts = dictionaryMatches(requiredRegion, CERTIFICATION_DICTIONARY);

  // Prefer a bar stated inside the requirements section; fall back to the whole
  // posting so a minimum stated up top is still caught.
  const minYears = extractMinYears(requiredRegion) ?? extractMinYears(text);

  let requiredDegree: JobSignals['requiredDegree'] = null;
  for (const [pattern, degree] of DEGREE_DEMAND) {
    if (pattern.test(requiredRegion)) {
      requiredDegree = degree;
      break;
    }
  }

  return {
    requiredSkills,
    preferredSkills: preferredOnly,
    requiredCerts,
    minYears,
    requiredDegree,
    hasExplicitSections: hasExplicitRequired,
  };
}
