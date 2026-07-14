import { describe, it, expect } from "vitest";
import { postingTextFor } from "../src/orchestrator/prepare-docs";
import { parsePosting } from "../src/generation/posting";

const REAL_JD =
  "We are seeking an AML Compliance Analyst to monitor transactions, file SARs, and ensure BSA " +
  "compliance. Requirements: 5+ years AML experience, CAMS certification, and strong SQL skills.";

describe("postingTextFor — JD threading", () => {
  it("uses the real job description when one is present", () => {
    const text = postingTextFor({ company: "Acme Bank", title: "AML Analyst", description: REAL_JD });
    expect(text).toContain("CAMS certification");
    expect(text).toContain("file SARs");
    // The generic stub must NOT appear when we have a real description.
    expect(text).not.toContain("Responsibilities include relevant experience from your background");
  });

  it("threads real JD keywords through the posting parser", () => {
    const posting = parsePosting(postingTextFor({ company: "Acme Bank", title: "AML Analyst", description: REAL_JD }), {
      title: "AML Analyst",
      company: "Acme Bank",
    });
    expect(posting.keywords).toContain("aml");
    expect(posting.keywords).toContain("cams");
    expect(posting.keywords).toContain("sql");
  });

  it("falls back to the rationale + stub when no description is given", () => {
    const text = postingTextFor({ company: "Acme Bank", title: "AML Analyst", rationale: "Strong compliance match" });
    expect(text).toContain("Strong compliance match");
    expect(text).toContain("Responsibilities include relevant experience from your background");
  });

  it("ignores a too-short description (under 40 chars) and uses the stub", () => {
    const text = postingTextFor({ company: "Acme Bank", title: "AML Analyst", description: "AML role" });
    expect(text).toContain("Responsibilities include relevant experience from your background");
  });

  it("always includes the title and company header", () => {
    const text = postingTextFor({ company: "Acme Bank", title: "AML Analyst", description: REAL_JD });
    expect(text).toContain("AML Analyst");
    expect(text).toContain("Company: Acme Bank");
  });
});
