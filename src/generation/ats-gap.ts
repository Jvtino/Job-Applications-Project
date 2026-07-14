// src/generation/ats-gap.ts
//
// ATS keyword-gap analysis: given the generated résumé text and the parsed job posting, reports
// which required keywords/phrases the résumé already covers and which are absent. Coverage
// drives the gap list the user sees in the Generate screen — fill it before submitting.

import type { JobPosting } from "../types/job-posting";

const STOP = new Set([
  "the","a","an","and","or","but","for","to","of","in","on","at","by","with","from","as","is",
  "are","be","will","you","your","we","our","they","their","this","that","these","those","it",
  "have","has","had","not","can","may","must","should","who","what","when","where","which","how",
  "experience","experienced","work","working","ability","able","strong","excellent","good","plus",
  "preferred","required","requirements","qualifications","responsibilities","role","position",
  "job","team","teams","company","candidate","candidates","including","etc","years","year","per",
  "about","into","over","across","using","use","help","make","new","more","most","such","other",
]);

/** Significant adjacent-word pairs from the requirements section (likely tech or domain phrases). */
function requirementBigrams(requirements: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const req of requirements) {
    const words = req
      .toLowerCase()
      .replace(/[^a-z0-9+#.\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w));
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      if (!seen.has(bigram)) {
        seen.add(bigram);
        out.push(bigram);
      }
    }
  }
  return out;
}

export interface AtsGapReport {
  /** Deduplicated union of top-20 JD keywords + significant bigrams from requirements. */
  requiredTerms: string[];
  /** Terms found in the résumé text (case-insensitive substring match). */
  coveredTerms: string[];
  /** Terms NOT found — the gap to close before submitting. */
  missingTerms: string[];
  /** 0–100, rounded. */
  coveragePercent: number;
}

export function computeAtsGap(resumeText: string, posting: JobPosting): AtsGapReport {
  const hay = resumeText.toLowerCase();
  const bigrams = requirementBigrams(posting.requirements);
  // Top-20 single keywords + requirement bigrams; deduplicated, order preserved.
  const seen = new Set<string>();
  const requiredTerms: string[] = [];
  for (const t of [...posting.keywords.slice(0, 20), ...bigrams]) {
    if (!seen.has(t)) {
      seen.add(t);
      requiredTerms.push(t);
    }
  }
  const coveredTerms = requiredTerms.filter((t) => hay.includes(t));
  const missingTerms = requiredTerms.filter((t) => !hay.includes(t));
  const coveragePercent =
    requiredTerms.length === 0 ? 100 : Math.round((coveredTerms.length / requiredTerms.length) * 100);
  return { requiredTerms, coveredTerms, missingTerms, coveragePercent };
}
