// src/jobs/fit-breakdown.ts
//
// FitScoreBreakdown — a TRANSPARENT fit result, not a mystery number. It layers the E2 hard caps and
// the E3 recommendation buckets on top of the existing weighted job-fit score, and records WHY: the
// caps applied, the blockers, and evidence with provenance. If the app can't explain why a job
// scored well, it must not call it a recommendation.
//
// Domain-general: it reasons about JD/URL/US-eligibility/role-family/credentials/source-quality —
// never about a specific industry.

import type { JobFitScore, JobAnalysis, CandidateProfile } from "../types/job-fit";
import type { JobSearchIntent } from "../types/job-search-intent";
import type { UsEligibilityStatus } from "./us-eligibility";
import type { ApplyCapability } from "./apply-capability";
import { roleFamilies } from "./taxonomy";

export type FitCategory = "strong" | "good" | "possible" | "weak" | "reject";

/** Source tiers (brief F1). 1 = employer ATS, 2 = keyed API, 3 = user-pasted, 4 = aggregator. */
export type SourceTier = 1 | 2 | 3 | 4;

export interface FitComponents {
  titleAlignment: number;
  requiredSkillMatch: number;
  seniorityFit: number;
  industryFit: number;
  experienceEvidence: number;
  locationFit: number;
  compensationFit: number | null;
  credentialFit: number;
  sourceQuality: number;
}

export interface FitEvidence {
  reason: string;
  source: "resume_fact" | "job_description" | "user_intent";
  ref?: string;
}

export interface FitScoreBreakdown {
  finalScore: number; // 0..100
  category: FitCategory;
  components: FitComponents;
  capsApplied: string[];
  blockers: string[];
  evidence: FitEvidence[];
  /** True only when the role is safe to route into the automated form-fill queue. */
  applyReady: boolean;
  /** True when it's a recommendation the user should see but must apply to manually. */
  manualRecommended: boolean;
}

export interface FitBreakdownInput {
  fit: JobFitScore;
  usEligibility: UsEligibilityStatus;
  fullJdFetched: boolean;
  employerUrlConfirmed: boolean;
  applyCapability: ApplyCapability;
  sourceTier: SourceTier;
  intent: JobSearchIntent;
  /** Structured posting, for role-family + seniority checks against the intent. */
  analysis?: JobAnalysis;
  candidate?: CandidateProfile;
}

const CAP_NO_JD = 49;
const CAP_NO_URL = 49;
const CAP_US_REVIEW = 59;
const CAP_WRONG_FAMILY = 39;
const CAP_WEAK_SKILL = 59;

function sourceQualityScore(tier: SourceTier): number {
  return tier === 1 ? 95 : tier === 3 ? 82 : tier === 2 ? 68 : 30;
}

function mapComponents(input: FitBreakdownInput): FitComponents {
  const cs = input.fit.categoryScores;
  return {
    titleAlignment: cs.titleAlignment,
    requiredSkillMatch: cs.hardSkillMatch,
    seniorityFit: cs.seniorityMatch,
    industryFit: cs.industryMatch,
    experienceEvidence: cs.experienceMatch,
    locationFit: cs.locationWorkArrangement,
    compensationFit: null,
    credentialFit: cs.educationCertificationMatch,
    sourceQuality: sourceQualityScore(input.sourceTier),
  };
}

/** Does the posting share a role family with the intent? Uncertain (no analysis) → treated as OK. */
function familyAligned(intent: JobSearchIntent, analysis?: JobAnalysis): boolean {
  if (!analysis || intent.roleFamilies.length === 0) return true;
  const fams = roleFamilies(analysis.jobTitle, `${analysis.coreResponsibilities.join(" ")} ${analysis.requiredSkills.map((s) => s.name).join(" ")}`);
  for (const f of fams) if (intent.roleFamilies.includes(f)) return true;
  return fams.size === 0; // untyped title → don't hard-reject on family
}

export function buildFitBreakdown(input: FitBreakdownInput): FitScoreBreakdown {
  const components = mapComponents(input);
  const capsApplied: string[] = [];
  const blockers: string[] = [...input.fit.hardBlockers];
  const evidence: FitEvidence[] = [];

  let score = input.fit.overallScore;
  const cap = (ceiling: number, why: string) => {
    if (score > ceiling) {
      score = ceiling;
      capsApplied.push(why);
    }
  };

  // --- hard blockers (reject regardless of score) ---
  if (input.usEligibility === "blocked_non_us" && !blockers.some((b) => /non-us/i.test(b))) {
    blockers.push("explicit non-US location");
  }
  if (input.sourceTier === 4) {
    blockers.push("aggregator-only apply route (not employer-owned)");
  }

  // --- caps (hold below the Recommended band, but not a reject) ---
  if (!input.fullJdFetched) cap(CAP_NO_JD, "no full job description fetched — lead only");
  if (!input.employerUrlConfirmed) cap(CAP_NO_URL, "no confirmed employer apply URL — lead only");
  if (input.usEligibility === "needs_review") cap(CAP_US_REVIEW, "US eligibility ambiguous — manual review only");
  if (!familyAligned(input.intent, input.analysis)) cap(CAP_WRONG_FAMILY, "wrong role family for your target");
  if (components.requiredSkillMatch < 50) cap(CAP_WEAK_SKILL, "required-skill match below threshold");

  // --- evidence (why it scored where it did) ---
  for (const r of input.fit.topMatchReasons.slice(0, 4)) evidence.push({ reason: r, source: "resume_fact" });
  if (input.analysis) {
    evidence.push({ reason: `role analyzed: ${input.analysis.jobTitle}`, source: "job_description" });
  }
  if (input.intent.targetTitles.length) {
    evidence.push({ reason: `targeting ${input.intent.targetTitles.slice(0, 3).join(", ")}`, source: "user_intent" });
  }
  for (const c of capsApplied) evidence.push({ reason: c, source: "job_description" });

  score = Math.max(0, Math.min(100, Math.round(score)));

  // --- category (E3 buckets) ---
  const usEligible = input.usEligibility === "eligible_us";
  const recommendable = input.fullJdFetched && input.employerUrlConfirmed && usEligible;
  let category: FitCategory;
  if (blockers.length > 0) {
    category = "reject";
    score = Math.min(score, 39);
  } else if (score >= 85 && recommendable) {
    category = "strong";
  } else if (score >= 75 && recommendable) {
    category = "good";
  } else if (score >= 60) {
    category = "possible";
  } else {
    category = "weak";
  }

  const isRecommended = category === "strong" || category === "good";
  const applyReady = isRecommended && input.applyCapability === "supported_form_fill" && usEligible;
  const manualRecommended = isRecommended && !applyReady;

  return { finalScore: score, category, components, capsApplied, blockers, evidence, applyReady, manualRecommended };
}
