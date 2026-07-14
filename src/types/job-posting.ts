// src/types/job-posting.ts
//
// A job posting that document generation tailors toward. In Milestone 2 the posting is
// supplied by the user (a saved posting text + company/title); Module 3 (discovery) will later
// produce these automatically. Generation uses `keywords` / `requirements` only to SELECT,
// REORDER, and REWEIGHT approved facts — never to invent new ones.

export interface JobPosting {
  title: string;
  company: string;
  location?: string;
  /** The employer's own career-page apply URL (used by later browser milestones, not here). */
  applyUrl?: string;
  source?: string;
  /** Full posting text, for keyword/requirement extraction. */
  rawText: string;
  /** Requirement / qualification lines pulled from the posting. */
  requirements: string[];
  /** Significant keywords for fact ranking (lowercased, deduped, frequency-ordered). */
  keywords: string[];
}
