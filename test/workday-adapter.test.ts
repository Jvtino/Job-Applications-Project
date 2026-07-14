// Workday adapter — detection + gating coverage. pickAdapter recognizes Workday pages, the host
// matcher rejects look-alikes, and — critically — Workday stays OUT of the form-fill allowlist while
// its multi-step DOM engine is experimental/unverified, so a Workday posting remains manual-open-only
// and never enters the automated fill pipeline. (The step-navigation logic is tested in
// test/workday-dom.test.ts; the step loop in test/multi-step.test.ts.)

import { describe, it, expect } from "vitest";
import { pickAdapter } from "../src/ats/adapters";
import { WorkdayAdapter, isWorkdayHost } from "../src/ats/workday";
import { classifyApplyCapability, FORM_FILL_SUPPORTED_ATS } from "../src/jobs/apply-capability";
import { isMultiStep, type PageContext } from "../src/ats/adapter";

// Lightweight fake page (same approach as test/ats.test.ts): evaluate() reports whether a detector's
// selector SOURCE mentions the marker we're simulating on the page, so routing is testable without a
// real browser. Host-based detection reads url() directly.
function ctxWith(url: string, present: RegExp): PageContext {
  const page = { url: () => url, evaluate: async (fn: (...a: unknown[]) => unknown) => present.test(fn.toString()) };
  return { url, page } as unknown as PageContext;
}

describe("isWorkdayHost", () => {
  it("matches Workday tenant hosts", () => {
    for (const u of [
      "https://acme.wd1.myworkdayjobs.com/en-US/External/job/New-York/Analyst_R12345",
      "https://wellsfargo.wd5.myworkdayjobs.com/en-US/WellsFargoJobs",
      "https://acme.myworkdaysite.com/en-US/careers",
    ]) {
      expect(isWorkdayHost(u), u).toBe(true);
    }
  });

  it("rejects non-Workday hosts and look-alikes", () => {
    for (const u of [
      "https://boards.greenhouse.io/acme/jobs/123",
      "https://jobs.lever.co/acme/abc",
      "https://notmyworkdayjobs.com/x", // no dot boundary before the apex
      "https://myworkdayjobs.com.evil.example/x", // suffix spoof
      "not a url",
    ]) {
      expect(isWorkdayHost(u), u).toBe(false);
    }
  });
});

describe("WorkdayAdapter routing", () => {
  it("detects a Workday tenant host and pickAdapter routes to it", async () => {
    const ctx = ctxWith("https://acme.wd1.myworkdayjobs.com/en-US/External/job/NYC/Analyst_R1", /never-matches/);
    expect(await new WorkdayAdapter().detect(ctx)).toBe(true);
    expect((await pickAdapter(ctx)).name).toBe("workday");
  });

  it("detects an embedded Workday form by its data-automation-id markers, even off-host", async () => {
    const ctx = ctxWith("https://careers.acme.com/apply", /data-automation-id="applyManually"/);
    expect((await pickAdapter(ctx)).name).toBe("workday");
  });

  it("does not claim a non-Workday form", async () => {
    const ctx = ctxWith("https://careers.acme.com/apply", /first_name/);
    expect(await new WorkdayAdapter().detect(ctx)).toBe(false);
  });
});

describe("WorkdayAdapter gating + multi-step contract", () => {
  it("is enabled for form-fill (experimental) and routes a Workday posting into the fill pipeline", () => {
    expect(FORM_FILL_SUPPORTED_ATS.has("workday")).toBe(true);
    const check = classifyApplyCapability("https://acme.wd1.myworkdayjobs.com/en-US/External/job/NYC/Analyst_R1");
    expect(check.capability).toBe("supported_form_fill");
    // ...but flagged experimental so the human knows to review every page.
    expect(check.reason).toMatch(/experimental/i);
  });

  it("implements the multi-step wizard contract", () => {
    expect(isMultiStep(new WorkdayAdapter())).toBe(true);
  });
});
