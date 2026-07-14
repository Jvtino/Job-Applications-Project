// src/generation/cover-letter-gate.ts
//
// Decides whether to skip generating a cover letter for a given application, based on two heuristics:
//   1. Tier C targets → skip (mass-apply tier; tailored cover letters have low ROI at this volume).
//   2. Large-portal ATS URLs → skip (Lever, Greenhouse, Workday, etc. rarely surface them).
// Both are advisory — the gate fires before generation, saving LLM tokens and time.

const LARGE_PORTAL_DOMAINS = [
  "lever.co",
  "greenhouse.io",
  "greenhouse.com",
  "myworkdayjobs.com",
  "workday.com",
  "taleo.net",
  "icims.com",
  "jobvite.com",
  "brassring.com",
  "successfactors.com",
  "paylocity.com",
  "ultipro.com",
  "adp.com",
  "paycom.com",
  "bamboohr.com",
  "smartrecruiters.com",
  "recruitee.com",
  "ashbyhq.com",
];

function isLargePortal(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LARGE_PORTAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export interface CoverLetterGate {
  skip: boolean;
  reason?: string;
}

export function decideCoverLetterGate(opts: {
  /** "A" | "B" | "C" or any other string (treated as no-tier). */
  tier?: string | null;
  /** Employer's ATS apply URL — used for portal detection. */
  postingUrl?: string;
}): CoverLetterGate {
  if (opts.tier === "C") {
    return {
      skip: true,
      reason: "Tier C target — cover letter skipped to keep this a high-volume application",
    };
  }
  if (isLargePortal(opts.postingUrl)) {
    return {
      skip: true,
      reason: "Large ATS portal — cover letters are rarely surfaced; skipped",
    };
  }
  return { skip: false };
}
