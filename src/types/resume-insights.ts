// src/types/resume-insights.ts
//
// DERIVED, INFERRED understanding of the résumé — explicitly NOT part of the facts ledger.
//
// The facts ledger holds only literal, user-approved claims and is the sole source for generated
// documents (anti-fabrication). ResumeInsights is the opposite: best-effort inference (years of
// experience, seniority, domains, normalized skills) used ONLY to rank/match jobs. It is never
// submitted as a résumé claim and never feeds document generation.

export interface ResumeSkillSignal {
  name: string;
  /** How often the skill surfaced across skills + employment bullets (rough importance weight). */
  mentions: number;
}

export interface ResumeInsights {
  /** Approximate total years of professional experience (career span, overlap-deduplicated). */
  totalYearsExperience: number;
  /** 0..6 ladder: intern(0) -> vp(6). Highest level observed across employment titles. */
  seniorityLevel: number;
  seniorityLabel: string;
  /** Inferred function/industry domains (e.g. "engineering", "data", "product"). */
  domains: string[];
  /** Normalized skills with frequency, most-mentioned first. */
  skills: ResumeSkillSignal[];
  /** Distinct employment titles, most recent first. */
  topTitles: string[];
  /** Degrees the résumé shows, so a posting's degree requirement can be scored (not just neutral). */
  education: Array<{ degree: string | null; institution: string | null; year: string | null }>;
  method: "deterministic" | "llm";
  generatedAt: string;
}
