// src/types/job-search-intent.ts
//
// JobSearchIntent — the normalized, domain-GENERAL description of what a candidate is trying to
// find. It is NOT a raw list of résumé titles: it separates where the person has BEEN from where
// they want to GO (critical for career pivoters), and records the evidence + confidence behind each
// inference so automation can decide how aggressively to act.
//
// Nothing here is hard-coded to a role family or industry. A compliance analyst, a software
// engineer, a nurse, and a warehouse supervisor all produce a JobSearchIntent of the same shape;
// the CONTENT differs, driven by role-family packs + the résumé, never by app defaults.

/** The 9-rung seniority ladder used across intent, packs, and scoring. */
export type SeniorityRung =
  | "intern"
  | "entry"
  | "associate"
  | "mid"
  | "senior"
  | "lead"
  | "manager"
  | "director"
  | "executive";

export const SENIORITY_RUNGS: SeniorityRung[] = [
  "intern", "entry", "associate", "mid", "senior", "lead", "manager", "director", "executive",
];

/** How confident we are about the intent — governs how far automation may go (see the rules below). */
export type IntentConfidence = "confirmed" | "inferred_high" | "inferred_low" | "missing";

export interface SeniorityRange {
  min: SeniorityRung;
  max: SeniorityRung;
  /** Human-readable evidence for the inferred band (years, titles held, etc.). */
  evidence: string[];
}

export interface IntentCompensation {
  min?: number;
  target?: number;
  currency: "USD";
}

export interface JobSearchIntent {
  /** True only when the user explicitly confirmed this intent (not merely inferred). */
  confirmed: boolean;
  confidence: IntentConfidence;

  /** Canonical role-family ids (taxonomy), e.g. "compliance", "engineering", "healthcare". */
  roleFamilies: string[];
  /** Exact titles the user wants (confirmed or inferred-and-approved). */
  targetTitles: string[];
  /** Acceptable nearby titles. */
  adjacentTitles: string[];
  /** Titles to block even when they share keywords with the target. */
  excludedTitles: string[];
  /** Titles the résumé shows the person has HELD — kept SEPARATE from targets (pivot-aware). */
  currentOrPastTitles: string[];

  seniority: SeniorityRange;

  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  transferableSkills: string[];

  requiredCredentials: string[];
  /** Credentials whose ABSENCE should hard-block a role (a subset of requiredCredentials). */
  missingCredentialDealbreakers: string[];

  industries: string[];
  companyTypes: string[];
  locations: string[];
  workArrangement: Array<"onsite" | "hybrid" | "remote_us">;
  compensation?: IntentCompensation;
  dealbreakers: string[];
}

/**
 * Automation-permission rules keyed off intent confidence (brief Part H):
 *   - confirmed:     discover + semi-auto fill strong matches.
 *   - inferred_high: discover freely, but every apply requires review.
 *   - inferred_low:  discovery only — no apply.
 *   - missing:       stop and ask the user to define their target.
 */
export interface IntentPermissions {
  canDiscover: boolean;
  canApply: boolean;
  requiresReviewBeforeApply: boolean;
  mustAskUser: boolean;
  reason: string;
}

export function intentPermissions(confidence: IntentConfidence): IntentPermissions {
  switch (confidence) {
    case "confirmed":
      return { canDiscover: true, canApply: true, requiresReviewBeforeApply: true, mustAskUser: false, reason: "Target confirmed — discovery + review-first apply enabled." };
    case "inferred_high":
      return { canDiscover: true, canApply: true, requiresReviewBeforeApply: true, mustAskUser: false, reason: "Target inferred with high confidence — discovery runs; apply requires your review." };
    case "inferred_low":
      return { canDiscover: true, canApply: false, requiresReviewBeforeApply: true, mustAskUser: true, reason: "Target only weakly inferred — discovery only; confirm your target before applying." };
    case "missing":
      return { canDiscover: false, canApply: false, requiresReviewBeforeApply: true, mustAskUser: true, reason: "No target defined — confirm your target roles before automation runs." };
  }
}

/** Index of a rung on the ladder (0..8), for range math. */
export function rungIndex(rung: SeniorityRung): number {
  return SENIORITY_RUNGS.indexOf(rung);
}

/** Map the taxonomy's coarse 0..6 seniority level to a ladder rung. */
export function rungForLevel(level: number): SeniorityRung {
  if (level <= 0) return "intern";
  if (level === 1) return "entry";
  if (level === 2) return "mid";
  if (level === 3) return "senior";
  if (level === 4) return "lead";
  if (level === 5) return "director";
  return "executive";
}
