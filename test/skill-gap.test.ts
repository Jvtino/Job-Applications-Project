import { describe, it, expect } from "vitest";
import { computeSkillGap, type SkillGapJob } from "../src/insights/skill-gap";
import type { FactsLedger } from "../src/types/facts-ledger";

function ledger(): FactsLedger {
  return {
    profileId: "sg",
    facts: [
      { id: "e1", type: "employment", approved: true, title: "Compliance Analyst", employer: "BankCo", startDate: "2020", endDate: "present", bullets: ["Filed SARs and ran transaction monitoring reviews"] },
      { id: "s1", type: "skill", approved: true, statement: "SQL" },
      { id: "s2", type: "skill", approved: true, statement: "Compliance" },
      // An UNAPPROVED fact must never count as coverage.
      { id: "s3", type: "skill", approved: false, statement: "Tableau" },
    ],
  };
}

const jobs: SkillGapJob[] = [
  { title: "AML Analyst", description: "Needs AML, SQL, and Tableau for transaction monitoring." },
  { title: "Compliance Analyst", description: "AML compliance role using SQL and Tableau dashboards." },
  { title: "Risk Analyst", description: "AML and risk modeling; Tableau reporting preferred." },
];

describe("computeSkillGap", () => {
  it("counts how many jobs surface each term", () => {
    const r = computeSkillGap(jobs, ledger());
    expect(r.jobsAnalyzed).toBe(3);
    const aml = [...r.topGaps, ...r.topMatched].find((t) => t.term === "aml");
    expect(aml?.jobCount).toBe(3);
  });

  it("flags a demanded term absent from the approved ledger as a gap", () => {
    const r = computeSkillGap(jobs, ledger());
    const terms = r.topGaps.map((g) => g.term);
    // Tableau appears in all 3 jobs and is only an UNAPPROVED fact → it's a gap.
    expect(terms).toContain("tableau");
  });

  it("does not flag a term the approved ledger covers", () => {
    const r = computeSkillGap(jobs, ledger());
    const gapTerms = r.topGaps.map((g) => g.term);
    expect(gapTerms).not.toContain("sql");
    // SQL should surface as a matched strength instead.
    expect(r.topMatched.map((m) => m.term)).toContain("sql");
  });

  it("ranks gaps by job demand (descending)", () => {
    const r = computeSkillGap(jobs, ledger());
    for (let i = 1; i < r.topGaps.length; i++) {
      expect(r.topGaps[i - 1]!.jobCount).toBeGreaterThanOrEqual(r.topGaps[i]!.jobCount);
    }
  });

  it("handles an empty job list", () => {
    const r = computeSkillGap([], ledger());
    expect(r).toEqual({ jobsAnalyzed: 0, topGaps: [], topMatched: [] });
  });

  it("caps gaps at 12 and matched at 8", () => {
    const many: SkillGapJob[] = Array.from({ length: 5 }, (_, i) => ({
      title: `Role ${i}`,
      description:
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec",
    }));
    const r = computeSkillGap(many, { profileId: "empty", facts: [] });
    expect(r.topGaps.length).toBeLessThanOrEqual(12);
    expect(r.topMatched.length).toBeLessThanOrEqual(8);
  });
});
