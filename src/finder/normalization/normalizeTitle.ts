/**
 * Canonical title form for matching/dedupe (display always shows the raw
 * title). Lowercases, expands common abbreviations, strips location/remote
 * parentheticals and requisition-id suffixes, collapses whitespace. Seniority
 * levels are KEPT — "Engineer II" and "Engineer III" are distinct requisitions.
 */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  // NB: the optional dot sits AFTER the trailing \b — `\.?\b` can never
  // consume the dot (no word boundary follows it), which leaves "sr." → "senior.".
  [/\bsr\b\.?/gi, 'senior'],
  [/\bjr\b\.?/gi, 'junior'],
  [/\bmgr\b\.?/gi, 'manager'],
  [/\bengr\b\.?/gi, 'engineer'],
  [/\bassoc\b\.?/gi, 'associate'],
  [/\bcoord\b\.?/gi, 'coordinator'],
  [/\brep\b\.?(?=\s|$)/gi, 'representative'],
  [/\bspec\b\.?/gi, 'specialist'],
];

const NOISE_PARENS =
  /\((?:[^)]*(?:remote|hybrid|onsite|on-site|contract|m\/f|f\/m|\bus\b|usa|multiple locations)[^)]*)\)/gi;
const REQ_ID_SUFFIX = /[\s–—-]+(?:req|r|job)?[\s#]*\d{3,}\s*$/i;

export function normalizeTitle(title: string): string {
  let text = title.trim();
  text = text.replace(NOISE_PARENS, ' ');
  text = text.replace(REQ_ID_SUFFIX, ' ');
  for (const [pattern, replacement] of ABBREVIATIONS) {
    text = text.replace(pattern, replacement);
  }
  return text
    .toLowerCase()
    .replace(/[|/•]+/g, ' ')
    .replace(/\s*[–—-]\s*/g, ' ')
    .replace(/[^a-z0-9+#., ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[,.]+$/g, '')
    .trim();
}
