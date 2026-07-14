import { describe, it, expect } from "vitest";
import { computeAtsGap } from "../src/generation/ats-gap";
import { parsePosting } from "../src/generation/posting";

const posting = parsePosting(
  `Senior AML Compliance Analyst
Compliance Corp - New York, NY

About the role
We are looking for an AML analyst to help with compliance and risk management.

Requirements
- 5+ years of AML compliance experience
- CAMS certification preferred
- Experience with transaction monitoring systems
- Knowledge of BSA/AML regulations
- Proficiency in SQL for data analysis`,
  { title: "Senior AML Compliance Analyst", company: "Compliance Corp" }
);

describe("computeAtsGap", () => {
  it("returns high coverage when résumé contains required terms", () => {
    const text =
      "AML compliance analyst with CAMS certification. Experienced in transaction monitoring " +
      "and BSA/AML regulations. Proficient in SQL and data analysis for risk management.";
    const result = computeAtsGap(text, posting);
    expect(result.coveragePercent).toBeGreaterThanOrEqual(60);
    expect(result.coveredTerms.length).toBeGreaterThan(0);
  });

  it("returns low coverage when résumé is off-topic", () => {
    const text = "Front-end developer skilled in React and TypeScript building user interfaces.";
    const result = computeAtsGap(text, posting);
    expect(result.coveragePercent).toBeLessThan(40);
    expect(result.missingTerms.length).toBeGreaterThan(0);
  });

  it("covered + missing = required terms total", () => {
    const text = "AML analyst reviewing transaction reports.";
    const result = computeAtsGap(text, posting);
    expect(result.coveredTerms.length + result.missingTerms.length).toBe(result.requiredTerms.length);
  });

  it("coveragePercent is derived from coveredTerms / requiredTerms", () => {
    const text = "AML analyst reviewing transaction reports.";
    const result = computeAtsGap(text, posting);
    const expected =
      result.requiredTerms.length === 0
        ? 100
        : Math.round((result.coveredTerms.length / result.requiredTerms.length) * 100);
    expect(result.coveragePercent).toBe(expected);
  });

  it("returns 100% coverage for an empty posting (no required terms)", () => {
    const emptyPosting = parsePosting("", { title: "Job", company: "Corp" });
    const result = computeAtsGap("any résumé text", emptyPosting);
    expect(result.coveragePercent).toBe(100);
    expect(result.requiredTerms).toHaveLength(0);
  });
});
