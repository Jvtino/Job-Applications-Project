import { describe, expect, it } from "vitest";
import {
  isActionableDiscoveredJob,
  isDisplayableDiscoveredJob,
  isBrowsableDiscoveredJob,
  DISPLAY_MIN_SCORE,
} from "../src/jobs/actionable-jobs";
import type { DiscoveredJob } from "../src/db/discovered-jobs-repo";
import type { JobFitScore } from "../src/types/job-fit";

function fit(overrides: Partial<JobFitScore>): JobFitScore {
  return {
    overallScore: 80,
    matchCategory: "good",
    interviewProbability: "medium",
    categoryScores: {
      titleAlignment: 80,
      hardSkillMatch: 80,
      experienceMatch: 80,
      industryMatch: 80,
      seniorityMatch: 80,
      locationWorkArrangement: 80,
      educationCertificationMatch: 80,
      resumeStrengthForRole: 80,
      interviewProbability: 80,
    },
    categoryReasoning: {},
    reasoningSummary: "Good match.",
    topMatchReasons: [],
    mainConcerns: [],
    missingRequirements: [],
    recommendedAction: "apply_with_custom_resume",
    resumeKeywordsToEmphasize: [],
    coverLetterAngle: "",
    hardBlockers: [],
    confidence: "medium",
    method: "deterministic",
    ...overrides,
  };
}

function job(overrides: Partial<DiscoveredJob>): DiscoveredJob {
  return {
    id: "job-1",
    profileId: "profile-1",
    company: "Acme",
    title: "Operations Analyst",
    jobUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
    atsType: "greenhouse",
    score: 0.8,
    rationale: "Good match.",
    knockouts: [],
    status: "scored",
    dedupKey: "job-boards.greenhouse.io/acme/jobs/1",
    discoveredAt: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("isActionableDiscoveredJob", () => {
  it("does not promote weak fit rows even when they clear an old 50% floor", () => {
    const weak = job({
      title: "Software Engineer II",
      score: 0.51,
      rationale: "Weak match: missing required software engineering skills.",
      fit: fit({
        overallScore: 51,
        matchCategory: "weak",
        recommendedAction: "skip",
        reasoningSummary: "Weak match.",
        mainConcerns: ["missing software engineering experience"],
        missingRequirements: ["software engineering"],
      }),
    });

    expect(isActionableDiscoveredJob(weak, { minScore: 0.5 })).toBe(false);
  });

  it("promotes apply-recommended good or strong rows", () => {
    expect(isActionableDiscoveredJob(job({ score: 0.8, fit: fit({ overallScore: 80 }) }), { minScore: 0.7 })).toBe(true);
  });

  it("keeps legacy score-only rows below the apply recommendation floor out of the queue", () => {
    expect(isActionableDiscoveredJob(job({ score: 0.74 }), { minScore: 0.5 })).toBe(false);
  });
});

describe("isDisplayableDiscoveredJob", () => {
  it("surfaces score-only rows above the display floor that the apply gate would reject", () => {
    const row = job({ score: 0.45, fit: undefined });
    // Not apply-recommended (below 0.75), but worth showing the user for review.
    expect(isActionableDiscoveredJob(row, { requireEmployerJobUrl: true })).toBe(false);
    expect(isDisplayableDiscoveredJob(row, { requireEmployerJobUrl: true })).toBe(true);
  });

  it("excludes rows below the display floor", () => {
    expect(isDisplayableDiscoveredJob(job({ score: DISPLAY_MIN_SCORE - 0.01, fit: undefined }))).toBe(false);
    expect(isDisplayableDiscoveredJob(job({ score: DISPLAY_MIN_SCORE, fit: undefined }))).toBe(true);
  });

  it("excludes knockouts, already-applied, and dead statuses even above the floor", () => {
    expect(isDisplayableDiscoveredJob(job({ score: 0.9, knockouts: ["non-US location"] }))).toBe(false);
    expect(isDisplayableDiscoveredJob(job({ score: 0.9, status: "applied" }))).toBe(false);
    expect(
      isDisplayableDiscoveredJob(job({ score: 0.9, dedupKey: "k" }), { appliedDedup: new Set(["k"]) })
    ).toBe(false);
  });

  it("hides explicitly weak/reject rich-fit rows even when the score clears the floor", () => {
    const weak = job({ score: 0.5, fit: fit({ overallScore: 50, matchCategory: "weak" }) });
    expect(isDisplayableDiscoveredJob(weak)).toBe(false);
    const blocked = job({ score: 0.9, fit: fit({ hardBlockers: ["non-US only"] }) });
    expect(isDisplayableDiscoveredJob(blocked)).toBe(false);
    const good = job({ score: 0.5, fit: fit({ overallScore: 78, matchCategory: "good" }) });
    expect(isDisplayableDiscoveredJob(good)).toBe(true);
  });
});

describe("isBrowsableDiscoveredJob", () => {
  it("ignores score (backfill) but still excludes knockouts, applied, and dead statuses", () => {
    expect(isBrowsableDiscoveredJob(job({ score: 0.01, fit: undefined }))).toBe(true);
    expect(isBrowsableDiscoveredJob(job({ score: 0.99, knockouts: ["clearance"] }))).toBe(false);
    expect(isBrowsableDiscoveredJob(job({ score: 0.99, status: "skipped" }))).toBe(false);
  });
});
