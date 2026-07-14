// The transparent fit breakdown (E1-E3): hard caps, blockers, and Strong/Good/Possible/Weak/Reject
// buckets — and the guarantee that only a fully-evidenced role becomes a recommendation.

import { describe, it, expect } from "vitest";
import { buildFitBreakdown, type FitBreakdownInput } from "../src/jobs/fit-breakdown";
import type { JobFitScore, CategoryScores } from "../src/types/job-fit";
import type { JobSearchIntent } from "../src/types/job-search-intent";

function scores(over: Partial<CategoryScores> = {}): CategoryScores {
  return {
    titleAlignment: 85, hardSkillMatch: 85, experienceMatch: 85, industryMatch: 80, seniorityMatch: 85,
    locationWorkArrangement: 85, educationCertificationMatch: 80, resumeStrengthForRole: 80, interviewProbability: 80,
    ...over,
  };
}

function fakeFit(overall: number, over: Partial<JobFitScore> = {}): JobFitScore {
  return {
    overallScore: overall,
    matchCategory: "good",
    interviewProbability: "medium",
    categoryScores: scores(over.categoryScores),
    categoryReasoning: {},
    reasoningSummary: "",
    topMatchReasons: ["5y direct experience", "has SQL, Python"],
    mainConcerns: [],
    missingRequirements: [],
    recommendedAction: "apply",
    resumeKeywordsToEmphasize: [],
    coverLetterAngle: "",
    hardBlockers: [],
    confidence: "high",
    method: "deterministic",
    ...over,
  };
}

const intent: JobSearchIntent = {
  confirmed: true, confidence: "confirmed", roleFamilies: ["data"], targetTitles: ["Data Analyst"],
  adjacentTitles: [], excludedTitles: [], currentOrPastTitles: [], seniority: { min: "mid", max: "senior", evidence: [] },
  mustHaveSkills: [], niceToHaveSkills: [], transferableSkills: [], requiredCredentials: [],
  missingCredentialDealbreakers: [], industries: [], companyTypes: [], locations: [], workArrangement: ["remote_us"], dealbreakers: [],
};

const ideal: Omit<FitBreakdownInput, "fit"> = {
  usEligibility: "eligible_us", fullJdFetched: true, employerUrlConfirmed: true,
  applyCapability: "supported_form_fill", sourceTier: 1, intent,
};

describe("buildFitBreakdown — caps, blockers, buckets", () => {
  it("a fully-evidenced high score is Strong and apply-ready", () => {
    const b = buildFitBreakdown({ ...ideal, fit: fakeFit(90) });
    expect(b.category).toBe("strong");
    expect(b.applyReady).toBe(true);
    expect(b.finalScore).toBeGreaterThanOrEqual(85);
    expect(b.evidence.length).toBeGreaterThan(0);
  });

  it("ambiguous US eligibility caps at 59 and blocks apply-ready", () => {
    const b = buildFitBreakdown({ ...ideal, usEligibility: "needs_review", fit: fakeFit(92) });
    expect(b.finalScore).toBeLessThanOrEqual(59);
    expect(b.applyReady).toBe(false);
    expect(b.capsApplied.join(" ")).toMatch(/US eligibility/i);
    expect(["possible", "weak"]).toContain(b.category);
  });

  it("explicit non-US is a reject", () => {
    const b = buildFitBreakdown({ ...ideal, usEligibility: "blocked_non_us", fit: fakeFit(92) });
    expect(b.category).toBe("reject");
    expect(b.blockers.join(" ")).toMatch(/non-US/i);
  });

  it("no full JD fetched caps to a lead (max 49), never Recommended", () => {
    const b = buildFitBreakdown({ ...ideal, fullJdFetched: false, fit: fakeFit(92) });
    expect(b.finalScore).toBeLessThanOrEqual(49);
    expect(["possible", "weak"]).toContain(b.category);
    expect(b.applyReady).toBe(false);
  });

  it("no confirmed employer URL caps to a lead", () => {
    const b = buildFitBreakdown({ ...ideal, employerUrlConfirmed: false, fit: fakeFit(92) });
    expect(b.finalScore).toBeLessThanOrEqual(49);
  });

  it("aggregator-only source is a reject for automation", () => {
    const b = buildFitBreakdown({ ...ideal, sourceTier: 4, fit: fakeFit(92) });
    expect(b.category).toBe("reject");
    expect(b.blockers.join(" ")).toMatch(/aggregator/i);
  });

  it("a hard blocker from the fit (missing credential) forces reject", () => {
    const b = buildFitBreakdown({ ...ideal, fit: fakeFit(88, { hardBlockers: ["missing required credential: CPA"] }) });
    expect(b.category).toBe("reject");
  });

  it("weak required-skill match caps below Recommended", () => {
    const b = buildFitBreakdown({ ...ideal, fit: fakeFit(80, { categoryScores: scores({ hardSkillMatch: 30 }) }) });
    expect(b.finalScore).toBeLessThanOrEqual(59);
    expect(b.applyReady).toBe(false);
  });

  it("a strong match on an unsupported ATS is manual-recommended, not apply-ready", () => {
    const b = buildFitBreakdown({ ...ideal, applyCapability: "manual_open_only", fit: fakeFit(90) });
    expect(b.category).toBe("strong");
    expect(b.applyReady).toBe(false);
    expect(b.manualRecommended).toBe(true);
  });
});
