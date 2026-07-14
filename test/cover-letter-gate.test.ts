import { describe, it, expect } from "vitest";
import { decideCoverLetterGate } from "../src/generation/cover-letter-gate";

describe("decideCoverLetterGate", () => {
  it("skips for Tier C with a descriptive reason", () => {
    const g = decideCoverLetterGate({ tier: "C" });
    expect(g.skip).toBe(true);
    expect(g.reason).toMatch(/Tier C/i);
  });

  it("does not skip for Tier A", () => {
    expect(decideCoverLetterGate({ tier: "A" }).skip).toBe(false);
  });

  it("does not skip for Tier B", () => {
    expect(decideCoverLetterGate({ tier: "B" }).skip).toBe(false);
  });

  it("skips for a Lever URL", () => {
    const g = decideCoverLetterGate({ postingUrl: "https://jobs.lever.co/acmecorp/abc-123" });
    expect(g.skip).toBe(true);
    expect(g.reason).toMatch(/portal/i);
  });

  it("skips for a Greenhouse URL", () => {
    const g = decideCoverLetterGate({ postingUrl: "https://boards.greenhouse.io/acme/jobs/456" });
    expect(g.skip).toBe(true);
  });

  it("skips for a Workday URL", () => {
    const g = decideCoverLetterGate({ postingUrl: "https://acme.myworkdayjobs.com/en-US/AcmeCareers/job/123" });
    expect(g.skip).toBe(true);
  });

  it("does not skip for a custom company career page", () => {
    const g = decideCoverLetterGate({ postingUrl: "https://careers.acmecorp.com/job/senior-analyst" });
    expect(g.skip).toBe(false);
  });

  it("does not skip when neither tier nor URL is given", () => {
    expect(decideCoverLetterGate({}).skip).toBe(false);
  });

  it("Tier C reason takes precedence when both Tier C and a portal URL are given", () => {
    const g = decideCoverLetterGate({ tier: "C", postingUrl: "https://jobs.lever.co/acme/123" });
    expect(g.skip).toBe(true);
    expect(g.reason).toMatch(/Tier C/i);
  });

  it("handles a malformed URL gracefully (no skip)", () => {
    const g = decideCoverLetterGate({ postingUrl: "not-a-url" });
    expect(g.skip).toBe(false);
  });
});
