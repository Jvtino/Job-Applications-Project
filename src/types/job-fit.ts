// src/types/job-fit.ts
//
// The job-fit intelligence model. Three structured objects + the scored output:
//
//   CandidateProfile  — a recruiter-grade, normalized read of the résumé (NOT a claims ledger;
//                       inference for MATCHING only, never inserted into generated documents).
//   JobAnalysis       — a structured read of ONE posting (required vs preferred, must-haves,
//                       disqualifiers, years-by-area) — we never score a raw description.
//   JobFitScore       — the transparent, weighted 0..100 result with per-category reasoning,
//                       concerns, missing requirements, a category, and a recommended action.
//
// Everything here is domain-general: the taxonomy and rules work for any résumé/posting, not a
// single industry. See src/discovery/taxonomy.ts for the canonicalization that feeds it.

// ----------------------------------------------------------------------------------------
// Shared enums
// ----------------------------------------------------------------------------------------

/** How the candidate's experience relates to a requirement — the core anti-keyword distinction. */
export type ExperienceDepth = "direct" | "adjacent" | "transferable" | "none";

/** Final fit band. Thresholds in CATEGORY scoring map to these (see categoryForScore). */
export type MatchCategory = "strong" | "good" | "stretch" | "weak" | "reject";

export type InterviewProbability = "high" | "medium" | "low";

export type RecommendedAction =
  | "apply"
  | "apply_with_custom_resume"
  | "save_for_later"
  | "skip";

export type SeniorityBand =
  | "intern"
  | "junior"
  | "mid"
  | "senior"
  | "lead"
  | "director"
  | "executive";

// ----------------------------------------------------------------------------------------
// Layer 1 — Candidate profile (resume-driven, domain-general)
// ----------------------------------------------------------------------------------------

/** A skill the résumé supports, with how strongly the evidence backs it. */
export interface SkillEvidence {
  /** Canonical skill name (lowercased, normalized via taxonomy). */
  name: string;
  /** strong = named in a skills section or repeated; moderate = in bullets; weak = single mention. */
  strength: "strong" | "moderate" | "weak";
  /** Raw mention count across skills + employment bullets (rough weight). */
  mentions: number;
}

export interface CandidateProfile {
  /** Stable id (mirrors the profile id) so the profile can be cached + invalidated on résumé change. */
  profileId: string;

  jobTitles: string[];
  industries: string[];
  /** Canonical hard/technical skills the résumé backs, strongest first. */
  hardSkills: SkillEvidence[];
  softSkills: string[];
  toolsAndSoftware: string[];
  certifications: string[];
  education: { degree: string; field?: string; level: number }[];
  /** Role-family → approximate years of experience in that family (overlap-deduped). */
  yearsOfExperienceByArea: Record<string, number>;
  totalYearsExperience: number;

  strongExperienceAreas: string[];
  moderateExperienceAreas: string[];
  weakOrMissingAreas: string[];

  preferredRoles: string[];
  likelySeniorityLevel: number; // 0..6 ladder (see taxonomy.seniorityLevel)
  likelySeniorityBand: SeniorityBand;

  locationConstraints: string[];
  workAuthorization: string;
  /** Hard "won't take it" conditions derived from preferences (relocation declined, comp floor, …). */
  dealbreakers: string[];
  /** Honest weaknesses that affect competitiveness (thin tenure, career gap, self-taught skill, …). */
  resumeRiskFactors: string[];
  careerDirection: string;

  /** How this profile was produced. "llm" when an LLM enriched the deterministic base. */
  method: "deterministic" | "llm";
  generatedAt: string;
}

// ----------------------------------------------------------------------------------------
// Layer 2 — Job analysis (structured posting, never scored raw)
// ----------------------------------------------------------------------------------------

/** A required/preferred skill the posting asks for, with the years attached when stated. */
export interface JobSkillRequirement {
  name: string; // canonical
  /** Years explicitly tied to THIS skill, e.g. "5+ years of Python" → 5. */
  years?: number;
}

export interface JobAnalysis {
  jobTitle: string;
  company: string;
  location: string;
  /** "remote" | "hybrid" | "onsite" | "unspecified" (multi when the posting lists several). */
  remotePolicy: ("remote" | "hybrid" | "onsite")[];
  employmentType: "full_time" | "part_time" | "contract" | "internship" | "unspecified";
  salaryRange?: { min?: number; max?: number };

  requiredSkills: JobSkillRequirement[];
  preferredSkills: JobSkillRequirement[];
  /** Overall minimum years the role demands, when stated independent of a single skill. */
  requiredExperienceYears?: number;
  seniorityLevel: number; // 0..6
  industry: string[];

  coreResponsibilities: string[];
  /** Hard, non-negotiable gates (licenses, degrees, clearances, citizenship, named certs). */
  mustHaveQualifications: string[];
  niceToHaveQualifications: string[];
  /** Conditions that should REJECT or heavily penalize when the candidate fails them. */
  disqualifiers: string[];
  /** Unstated-but-implied bar (e.g. a "senior" title implying ownership/mentoring). */
  hiddenRequirements: string[];

  applicationEffortLevel: "low" | "medium" | "high";
  method: "deterministic" | "llm";
}

// ----------------------------------------------------------------------------------------
// Layer 3 — Weighted fit score (transparent + explainable)
// ----------------------------------------------------------------------------------------

/** The weighted categories. Each value is 0..100 (its own scale); the weights below combine them. */
export interface CategoryScores {
  titleAlignment: number;
  hardSkillMatch: number;
  experienceMatch: number;
  industryMatch: number;
  seniorityMatch: number;
  locationWorkArrangement: number;
  educationCertificationMatch: number;
  resumeStrengthForRole: number;
  interviewProbability: number;
}

/**
 * Category weights (sum = 100). Adjusted from the brief's defaults for one reason: depth-of-
 * experience (direct vs adjacent vs transferable) is the single most predictive signal of whether
 * an application converts, so experience + hard-skill matching carry the most weight, and seniority
 * over-reach is treated as a near-hard gate rather than a soft factor.
 */
export const CATEGORY_WEIGHTS: Record<keyof CategoryScores, number> = {
  hardSkillMatch: 18,
  experienceMatch: 22,
  titleAlignment: 13,
  seniorityMatch: 12,
  industryMatch: 10,
  locationWorkArrangement: 10,
  educationCertificationMatch: 7,
  resumeStrengthForRole: 4,
  interviewProbability: 4,
};

/** Per-category one-line explanation of why it scored as it did (the "good output", not just a number). */
export type CategoryReasoning = Partial<Record<keyof CategoryScores, string>>;

export interface JobFitScore {
  /** 0..100 weighted overall fit. Hard rejects floor this regardless of category sub-scores. */
  overallScore: number;
  matchCategory: MatchCategory;
  interviewProbability: InterviewProbability;

  categoryScores: CategoryScores;
  categoryReasoning: CategoryReasoning;

  reasoningSummary: string;
  topMatchReasons: string[];
  mainConcerns: string[];
  /** Must-have / required items the candidate does NOT demonstrably have. */
  missingRequirements: string[];

  recommendedAction: RecommendedAction;
  resumeKeywordsToEmphasize: string[];
  coverLetterAngle: string;

  /** Hard knockouts that forced a reject (location, license, degree, seniority over-reach, …). */
  hardBlockers: string[];
  /** Overall confidence in this assessment (degrades when the posting/résumé is thin). */
  confidence: "high" | "medium" | "low";
  /** "llm" when an LLM reasoner adjusted the deterministic base within bounds. */
  method: "deterministic" | "llm";
  /**
   * Structured requirement/qualification breakdown for the UI: what the résumé
   * meets, the negotiable gaps, the recommended (nice-to-have) coverage, adjacent
   * strengths, and any hard dealbreakers. Optional — older rows omit it.
   */
  requirementListing?: {
    requirementsMet: string[];
    requirementsMissing: string[];
    preferredMet: string[];
    preferredMissing: string[];
    transferable: string[];
    dealbreakers: string[];
  };
}

// ----------------------------------------------------------------------------------------
// Band thresholds: strong 90-100, good 75-89, stretch 60-74, weak 40-59, reject <40.
// Only strong/good roles (75+) are recommended for application.
// ----------------------------------------------------------------------------------------

export function categoryForScore(score: number): MatchCategory {
  if (score >= 90) return "strong";
  if (score >= 75) return "good";
  if (score >= 60) return "stretch";
  if (score >= 40) return "weak";
  return "reject";
}

export function actionForCategory(category: MatchCategory): RecommendedAction {
  switch (category) {
    case "strong":
      return "apply";
    case "good":
      return "apply_with_custom_resume";
    case "stretch":
      return "save_for_later";
    default:
      return "skip";
  }
}

export function seniorityBandFor(level: number): SeniorityBand {
  if (level <= 0) return "intern";
  if (level === 1) return "junior";
  if (level === 2) return "mid";
  if (level === 3) return "senior";
  if (level === 4) return "lead";
  if (level === 5) return "director";
  return "executive";
}

/** Combine 0..100 category scores by CATEGORY_WEIGHTS into a single 0..100 number. */
export function weightedOverall(scores: CategoryScores): number {
  let total = 0;
  for (const key of Object.keys(CATEGORY_WEIGHTS) as (keyof CategoryScores)[]) {
    total += (scores[key] / 100) * CATEGORY_WEIGHTS[key];
  }
  return Math.round(Math.max(0, Math.min(100, total)));
}
