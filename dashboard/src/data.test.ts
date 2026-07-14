// The matches-list apply-readiness gate (commercial M10). Already exported, previously untested. It
// decides which discovered jobs surface as ready-to-prepare, so its knockout/fit/legacy-score branches
// are worth pinning: a regression here either hides good matches or offers unactionable ones.
import { describe, it, expect } from "vitest";
import { isApplyReadyDiscoveredJob, type DiscoveredJobRow, type DiscoveredJobFit } from "./data";

const baseRow: DiscoveredJobRow = {
  id: "j1",
  company: "Acme",
  title: "Analyst",
  jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
  atsType: "greenhouse",
  score: 0.8,
  fitPct: 80,
  rationale: "good match",
  knockouts: [],
  tags: [],
  status: "new",
  discoveredAt: "2026-07-01T00:00:00.000Z",
  applied: false,
};

const fit = (over: Partial<DiscoveredJobFit>): DiscoveredJobFit => ({
  overallScore: 0.8,
  matchCategory: "strong",
  interviewProbability: "high",
  reasoningSummary: "",
  topMatchReasons: [],
  mainConcerns: [],
  missingRequirements: [],
  recommendedAction: "apply",
  resumeKeywordsToEmphasize: [],
  coverLetterAngle: "",
  hardBlockers: [],
  confidence: "high",
  method: "llm",
  ...over,
});

describe("isApplyReadyDiscoveredJob", () => {
  it("a strong, apply-recommended job above the fit floor is ready", () => {
    expect(isApplyReadyDiscoveredJob({ ...baseRow, fit: fit({}) }, 70)).toBe(true);
  });

  it("is not ready when the backend marked it non-actionable", () => {
    expect(isApplyReadyDiscoveredJob({ ...baseRow, actionable: false, fit: fit({}) }, 70)).toBe(false);
  });

  it("excludes already-applied, skipped, or knocked-out jobs", () => {
    expect(isApplyReadyDiscoveredJob({ ...baseRow, applied: true }, 70)).toBe(false);
    expect(isApplyReadyDiscoveredJob({ ...baseRow, status: "skipped" }, 70)).toBe(false);
    expect(isApplyReadyDiscoveredJob({ ...baseRow, knockouts: ["not US-eligible"] }, 70)).toBe(false);
  });

  it("excludes jobs scoring below the requested fit percentage", () => {
    expect(isApplyReadyDiscoveredJob({ ...baseRow, score: 0.8, fit: fit({}) }, 90)).toBe(false);
  });

  it("with a fit assessment: hard blockers or a non-apply category/action are not ready", () => {
    expect(isApplyReadyDiscoveredJob({ ...baseRow, fit: fit({ hardBlockers: ["clearance required"] }) }, 70)).toBe(false);
    expect(isApplyReadyDiscoveredJob({ ...baseRow, fit: fit({ matchCategory: "weak" }) }, 70)).toBe(false);
    expect(isApplyReadyDiscoveredJob({ ...baseRow, fit: fit({ recommendedAction: "save_for_later" }) }, 70)).toBe(false);
  });

  it("without a fit assessment, falls back to the legacy 0.75 score floor", () => {
    // 0.72 clears the 70% request but not the 0.75 legacy floor → not ready.
    expect(isApplyReadyDiscoveredJob({ ...baseRow, score: 0.72 }, 70)).toBe(false);
    // 0.8 clears both → ready.
    expect(isApplyReadyDiscoveredJob({ ...baseRow, score: 0.8 }, 70)).toBe(true);
  });
});
