// The live-discovery → funnel bridge: classify real DiscoveredJob rows the way the apply path does
// (US gate, employer-URL contract, full-JD requirement, apply capability) and roll them into an
// honest AutomationFunnelReport.

import { describe, it, expect } from "vitest";
import type { DiscoveredJob } from "../src/db/discovered-jobs-repo";
import type { JobSearchIntent } from "../src/types/job-search-intent";
import { buildPassFunnel, discoveredJobToFunnelPosting } from "../src/jobs/pass-funnel";

const JD = "Compliance analyst role. Requirements: AML, KYC, sanctions screening, transaction monitoring. US-based.";

let n = 0;
function job(over: Partial<DiscoveredJob>): DiscoveredJob {
  return {
    id: `j${n++}`, profileId: "p", company: "Acme", title: "AML Analyst",
    jobUrl: "https://boards.greenhouse.io/acme/jobs/1", atsType: "greenhouse",
    score: 0.8, rationale: "", knockouts: [], status: "scored", dedupKey: `k${n}`,
    discoveredAt: "2026-01-01", location: "New York, NY", description: JD,
    ...over,
  };
}

const intent: JobSearchIntent = {
  confirmed: true, confidence: "confirmed", roleFamilies: ["compliance"], targetTitles: ["AML Analyst"],
  adjacentTitles: [], excludedTitles: [], currentOrPastTitles: [], seniority: { min: "mid", max: "senior", evidence: [] },
  mustHaveSkills: [], niceToHaveSkills: [], transferableSkills: [], requiredCredentials: [],
  missingCredentialDealbreakers: [], industries: [], companyTypes: [], locations: [], workArrangement: ["remote_us"], dealbreakers: [],
};

describe("discoveredJobToFunnelPosting", () => {
  it("classifies a US greenhouse posting with a full JD as apply-ready when strong", () => {
    const p = discoveredJobToFunnelPosting(job({ score: 0.9 }));
    expect(p.category).toBe("strong");
    expect(p.applyReady).toBe(true);
    expect(p.employerUrlConfirmed).toBe(true);
    expect(p.usEligibility).toBe("eligible_us");
  });

  it("marks a non-US knockout as reject", () => {
    const p = discoveredJobToFunnelPosting(job({ location: "London, UK", knockouts: ["non-US location"], score: 0.1 }));
    expect(p.category).toBe("reject");
    expect(p.rejectionReason).toMatch(/non-US/i);
  });

  it("keeps an aggregator posting (no employer URL) as a lead", () => {
    const p = discoveredJobToFunnelPosting(job({ jobUrl: "https://www.linkedin.com/jobs/view/123", atsType: "linkedin" }));
    expect(p.category).toBe("lead");
    expect(p.employerUrlConfirmed).toBe(false);
    expect(p.rejectionReason).toMatch(/employer apply URL/i);
  });

  it("holds an ambiguous-remote posting for manual review (possible, not apply-ready)", () => {
    const p = discoveredJobToFunnelPosting(job({ location: "Remote", score: 0.9 }));
    expect(p.category).toBe("possible");
    expect(p.applyReady).toBe(false);
    expect(p.usEligibility).toBe("needs_review");
  });

  it("treats a title-only posting (no full JD) as a lead", () => {
    const p = discoveredJobToFunnelPosting(job({ description: undefined, score: 0.9 }));
    expect(p.category).toBe("lead");
    expect(p.fullJdFetched).toBe(false);
  });
});

describe("buildPassFunnel", () => {
  it("rolls classified jobs into a consistent report with reasons", () => {
    const jobs = [
      job({ score: 0.9 }), // strong, apply-ready
      job({ location: "London, UK", knockouts: ["non-US location"], score: 0.1 }),
      job({ jobUrl: "https://www.linkedin.com/jobs/view/9", atsType: "linkedin" }),
      job({ location: "Remote", score: 0.9 }),
    ];
    const r = buildPassFunnel({ passId: "pass-1", intent, jobs, rawFound: 10, queriesGenerated: 30, sourcesSearched: 2 });
    expect(r.strong).toBe(1);
    expect(r.applyReady).toBe(1);
    expect(r.leads).toBe(1);
    expect(r.rejected).toBe(1);
    expect(r.rejectedReasons.nonUs).toBe(1);
    expect(r.rejectedReasons.noEmployerUrl).toBe(1);
    expect(r.warnings).toEqual([]);
    expect(r.bottleneck).toBe(""); // there IS a strong match
  });

  it("diagnoses the bottleneck when nothing is Recommended", () => {
    const jobs = [job({ location: "Remote", score: 0.9 }), job({ location: "Worldwide", score: 0.8 })];
    const r = buildPassFunnel({ passId: "pass-2", intent, jobs });
    expect(r.strong + r.good).toBe(0);
    expect(r.bottleneck).toMatch(/ambiguous|US-eligibility|non-US/i);
  });
});
