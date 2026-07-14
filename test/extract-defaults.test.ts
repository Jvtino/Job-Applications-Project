import { describe, it, expect } from "vitest";
import { extractDefaults } from "../src/ingestion/extract-defaults";
import { buildLedger } from "../src/ingestion/ledger-ops";

describe("extract-defaults", () => {
  it("extracts aspirational roles from summary lines", () => {
    const raw = `Alex Kim
San Francisco, CA
Seeking a Senior Product Manager role in B2B SaaS

SUMMARY
Product leader with 8 years experience.`;

    const facts = buildLedger("p", [
      {
        id: "e1",
        type: "employment",
        approved: false,
        title: "Software Engineer",
        employer: "OldCo",
        startDate: "2018",
        endDate: "present",
        bullets: [],
      },
    ]).facts;

    const d = extractDefaults(facts, raw);
    expect(d.targetRoles.some((r) => /product manager/i.test(r))).toBe(true);
    expect(d.locations.some((l) => /San Francisco/i.test(l))).toBe(true);
  });

  it("detects remote preference from résumé text", () => {
    const d = extractDefaults([], "Open to remote and hybrid roles across the US.");
    expect(d.workModes).toContain("remote");
    expect(d.workModes).toContain("hybrid");
  });

  it("reads target-role language from summary_point facts (was dead code under type 'generic')", () => {
    const facts = buildLedger("p", [
      {
        id: "s1",
        type: "summary_point",
        approved: true,
        statement: "Experienced data engineer building Spark pipelines.",
      },
    ]).facts;
    const d = extractDefaults(facts, "");
    expect(d.targetRoles.some((r) => /data engineer/i.test(r))).toBe(true);
  });
});
