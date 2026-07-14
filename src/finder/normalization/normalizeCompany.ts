/**
 * Canonical company form for dedupe: lowercase, legal suffixes and punctuation
 * stripped. Display always shows the raw name.
 */
const LEGAL_SUFFIXES =
  /[,.]?\s+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|lp|llp|gmbh|holdings|group)\.?\s*$/i;

export function normalizeCompany(name: string): string {
  let text = name.trim().toLowerCase();
  // Applied twice: "Acme Holdings, Inc." → "acme holdings" → "acme".
  text = text.replace(LEGAL_SUFFIXES, '');
  text = text.replace(LEGAL_SUFFIXES, '');
  return text
    .replace(/[^a-z0-9& ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
