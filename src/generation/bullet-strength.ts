// src/generation/bullet-strength.ts
//
// Bullet strength analysis: flags passive openers and bullets lacking a quantified result.
// The framework's bullet formula is Verb + what + result/scale — these two checks enforce
// the verb (active, not "responsible for") and the result/scale (a number or unit).

const WEAK_OPENER_PATTERNS: RegExp[] = [
  /^responsible for\b/i,
  /^assisted (?:with|in|on)\b/i,
  /^helped (?:with|to|in)?\b/i,
  /^worked (?:with|on|to)\b/i,
  /^participated in\b/i,
  /^involved in\b/i,
  /^tasked with\b/i,
  /^was responsible\b/i,
  /^provided support\b/i,
  /^supported\b/i,
  /^contributed to\b/i,
  /^collaborated (?:with|on)\b/i,
  /^served as\b/i,
  /^managed the\b/i,
];

// A numeric value OR a dollar/time/headcount anchor counts as a quantifier.
const QUANTIFIER = /\d+(?:[.,]\d+)?%?|\$[\d,.]+|[\d,.]+(?:\+|x\b)?/;

export interface BulletWarning {
  bullet: string;
  /** "weak_opener" = passive lead verb; "no_quantifier" = no metric/result scale present. */
  issue: "weak_opener" | "no_quantifier";
  suggestion: string;
}

function hasWeakOpener(bullet: string): boolean {
  return WEAK_OPENER_PATTERNS.some((p) => p.test(bullet.trim()));
}

function hasQuantifier(bullet: string): boolean {
  return QUANTIFIER.test(bullet);
}

/**
 * Returns one warning per bullet that has a weak opener OR lacks a quantifier.
 * Weak opener is flagged first — fixing the verb is the higher-priority rewrite.
 */
export function checkBulletStrength(bullets: string[]): BulletWarning[] {
  const warnings: BulletWarning[] = [];
  for (const bullet of bullets) {
    if (!bullet.trim()) continue;
    if (hasWeakOpener(bullet)) {
      warnings.push({
        bullet,
        issue: "weak_opener",
        suggestion:
          "Start with a strong action verb (Led, Built, Reduced, Launched, Drove). Describe what you did, not that you were responsible for it.",
      });
    } else if (!hasQuantifier(bullet)) {
      warnings.push({
        bullet,
        issue: "no_quantifier",
        suggestion:
          "Add a metric or scale — %, $, headcount, time saved, volume. E.g. 'Reviewed 120 claims/week' beats 'Reviewed claims'.",
      });
    }
  }
  return warnings;
}
