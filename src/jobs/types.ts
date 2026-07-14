// src/jobs/types.ts
//
// Discovery sources include employer ATS boards plus supported public job search pages. Newer
// sources may discover jobs before they have a first-class apply adapter; those still flow through
// the generic review gate before the user submits anything.

import type { JobFitScore } from "../types/job-fit";

export type AtsType =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "smartrecruiters"
  | "jobvite"
  | "icims"
  | "linkedin"
  | "indeed"
  | "glassdoor"
  | "ziprecruiter"
  | "monster"
  | "dice"
  | "wellfound"
  | "angellist"
  | "simplyhired"
  | "talentcom"
  | "careerbuilder"
  | "jora"
  | "getwork"
  | "nexxt"
  | "jobcase"
  | "ladders"
  | "craigslist"
  | "adzuna"
  | "jooble"
  | "usajobs"
  | "neogov"
  | "workable"
  | "taleo"
  | "bamboohr"
  | "successfactors"
  | "breezy"
  | "recruitee"
  | "efinancialcareers"
  | "clearancejobs"
  | "roberthalf"
  | "weworkremotely"
  | "remoteok"
  | "handshake"
  | "wayup"
  | "collegerecruiter"
  | "snagajob"
  | "hcareers"
  | "healthecareers"
  | "vivian"
  | "practicelink"
  | "higheredjobs"
  | "idealist"
  | "schoolspring"
  | "dribbble"
  | "mediabistro"
  | "rigzone"
  | "remoteco"
  | "randstad"
  | "aerotek"
  | "kellyservices"
  | "adecco"
  | "unknown";

export interface TargetCompany {
  id: string;
  name: string;
  /** A source URL to scan (employer ATS board, company careers page, or supported job-search URL). */
  boardUrl: string;
  atsType: AtsType;
  enabled: boolean;
  /** Per-employer allowlist for 24/7 auto-submit (CAPTCHA-free, user pre-approved). */
  autoSubmitApproved: boolean;
  createdAt: string;
}

export interface DiscoveredPosting {
  title: string;
  company: string;
  location?: string;
  /** Posting/apply URL from the source. */
  jobUrl: string;
  atsType: AtsType;
}

export interface ScoredPosting extends DiscoveredPosting {
  /** 0..1 fit score against the profile + ledger. */
  score: number;
  rationale: string;
  /** Hard disqualifiers, e.g. "non-US location", "requires sponsorship". */
  knockouts: string[];
  /** Parsed annual base salary, when the posting exposes one. */
  salaryMin?: number;
  salaryMax?: number;
  /** Short posting body excerpt, used only for review UI context. */
  description?: string;
  /** Explainable 0..100 factors derived by the deterministic scorer. */
  fitFactors?: {
    skills: number;
    salary: number;
    location: number;
    seniority: number;
    culture: number;
  };
  /** Lightweight display tags derived from the posting/scoring signals. */
  tags?: string[];
  /**
   * Rich, authoritative job-fit assessment from the structured engine (src/discovery/job-fit.ts).
   * Present once a posting has a description to analyze; carries the category, per-category reasoning,
   * concerns, missing requirements, and recommended action. When present, `score` mirrors
   * fit.overallScore/100 and `knockouts` mirrors fit.hardBlockers.
   */
  fit?: JobFitScore;
}
