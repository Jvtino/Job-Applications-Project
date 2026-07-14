// The automation funnel report (F2/J3/K3): every rejection has a reason, counts reconcile, a
// zero-match pass explains its bottleneck, source health is recorded, and weak jobs are never
// backfilled into apply-ready.

import { describe, it, expect } from "vitest";
import { buildFunnelReport, type FunnelPosting, type FunnelInput } from "../src/jobs/funnel-report";

let n = 0;
function post(over: Partial<FunnelPosting>): FunnelPosting {
  return {
    sourceId: `src${n++ % 3}`,
    employerUrlConfirmed: true,
    usEligibility: "eligible_us",
    fullJdFetched: true,
    hardFilterPassed: true,
    category: "possible",
    applyReady: false,
    manualRecommended: false,
    ...over,
  };
}

function base(postings: FunnelPosting[], over: Partial<FunnelInput> = {}): FunnelInput {
  return {
    passId: "p1",
    intentConfidence: "confirmed",
    roleFamilies: ["data"],
    targetTitles: ["Data Analyst"],
    queriesGenerated: 42,
    sourcesSearched: 3,
    rawFound: postings.length + 5,
    deduped: postings.length,
    postings,
    ...over,
  };
}

describe("buildFunnelReport", () => {
  it("tallies buckets and keeps applyReady within strong+good", () => {
    const postings = [
      post({ category: "strong", applyReady: true }),
      post({ category: "good", applyReady: true }),
      post({ category: "good", manualRecommended: true }),
      post({ category: "possible" }),
      post({ category: "weak" }),
      post({ category: "reject", rejectionReason: "non-US location", hardFilterPassed: false, usEligibility: "blocked_non_us" }),
      post({ category: "lead", rejectionReason: "no confirmed employer apply URL", employerUrlConfirmed: false }),
    ];
    const r = buildFunnelReport(base(postings));
    expect(r.strong).toBe(1);
    expect(r.good).toBe(2);
    expect(r.applyReady).toBe(2);
    expect(r.manualRecommended).toBe(1);
    expect(r.applyReady).toBeLessThanOrEqual(r.strong + r.good);
    expect(r.warnings).toEqual([]); // counts reconcile, all rejections have reasons
  });

  it("classifies rejection reasons and records source health", () => {
    const postings = [
      post({ category: "reject", rejectionReason: "non-US location", usEligibility: "blocked_non_us" }),
      post({ category: "reject", rejectionReason: "wrong role family for your target" }),
      post({ category: "reject", rejectionReason: "missing required credential: CPA" }),
      post({ category: "lead", rejectionReason: "aggregator-only apply route" }),
    ];
    const r = buildFunnelReport(base(postings));
    expect(r.rejectedReasons.nonUs).toBe(1);
    expect(r.rejectedReasons.wrongRoleFamily).toBe(1);
    expect(r.rejectedReasons.missingRequiredCredential).toBe(1);
    expect(r.rejectedReasons.aggregatorOnly).toBe(1);
    expect(r.sourceHealth.length).toBeGreaterThan(0);
    expect(r.sourceHealth.reduce((s, h) => s + h.rawJobsFound, 0)).toBe(postings.length);
  });

  it("flags a rejection with no reason (never silent)", () => {
    const r = buildFunnelReport(base([post({ category: "reject" })]));
    expect(r.warnings.join(" ")).toMatch(/no rejection reason/i);
  });

  it("explains the bottleneck on a zero-match pass (all US-ambiguous)", () => {
    const postings = [
      post({ category: "weak", usEligibility: "needs_review", rejectionReason: "US eligibility ambiguous" }),
      post({ category: "weak", usEligibility: "needs_review", rejectionReason: "US eligibility ambiguous" }),
    ];
    const r = buildFunnelReport(base(postings));
    expect(r.strong + r.good).toBe(0);
    expect(r.bottleneck).toMatch(/ambiguous|non-US|US-eligibility/i);
  });

  it("bottleneck says 'no postings' when the pass found nothing", () => {
    const r = buildFunnelReport(base([], { rawFound: 0 }));
    expect(r.bottleneck).toMatch(/no postings/i);
  });

  it("bottleneck points at employer-URL resolution when nothing resolved", () => {
    const postings = [post({ category: "lead", employerUrlConfirmed: false, fullJdFetched: false, rejectionReason: "no confirmed employer apply URL" })];
    const r = buildFunnelReport(base(postings));
    expect(r.bottleneck).toMatch(/employer apply URL/i);
  });

  it("catches an inconsistent count (categories don't sum to deduped)", () => {
    const r = buildFunnelReport(base([post({ category: "strong", applyReady: true })], { deduped: 5 }));
    expect(r.warnings.join(" ")).toMatch(/does not match|do not sum/i);
  });
});
