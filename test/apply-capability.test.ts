// The discovery→apply contract (src/discovery/apply-capability.ts): discovery is broad, form
// filling is narrow, and the app must be honest about the difference. These tests pin down the
// classification for every source class the product knows about, plus the enforcement points that
// keep unsupported jobs out of the automated fill pipeline.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyApplyCapability, isFormFillSupported, FORM_FILL_SUPPORTED_ATS } from "../src/jobs/apply-capability";
import { ApplySession, resolveApplyDisplay } from "../src/orchestrator/apply-session";
import { openDatabase, type DB } from "../src/db/database";
import { createBlankProfile } from "../src/profile/factory";

describe("classifyApplyCapability — the discovery→apply contract", () => {
  it("supports exactly the ATSes with a real apply adapter (workday enabled, experimental)", () => {
    expect([...FORM_FILL_SUPPORTED_ATS].sort()).toEqual(["ashby", "greenhouse", "lever", "smartrecruiters", "workday"]);
  });

  it("classifies supported ATS postings as supported_form_fill", () => {
    for (const url of [
      "https://job-boards.greenhouse.io/acme/jobs/1234567",
      "https://boards.greenhouse.io/acme/jobs/4000123?gh_jid=4000123",
      "https://jobs.lever.co/acme/9a2f1b3c-4d5e",
      "https://jobs.ashbyhq.com/acme/f00dbabe-cafe",
      "https://jobs.smartrecruiters.com/Acme/743999912345678-aml-analyst",
      "https://acme.wd1.myworkdayjobs.com/en-US/External/job/New-York/Analyst_R12345",
    ]) {
      const check = classifyApplyCapability(url);
      expect(check.capability, url).toBe("supported_form_fill");
      expect(isFormFillSupported(url), url).toBe(true);
    }
  });

  it("marks a Workday posting as experimental in its capability reason", () => {
    const check = classifyApplyCapability("https://acme.wd1.myworkdayjobs.com/en-US/External/job/New-York/Analyst_R12345");
    expect(check.reason).toMatch(/experimental/i);
  });

  it("classifies known sources WITHOUT an apply adapter as manual_open_only (never generic-fallback fodder)", () => {
    for (const url of [
      "https://www.linkedin.com/jobs/view/3941234567",
      "https://www.indeed.com/viewjob?jk=abc123def456",
      "https://www.glassdoor.com/job-listing/analyst-acme-JV_IC1147401.htm",
      "https://www.ziprecruiter.com/jobs/acme-inc/aml-analyst",
      "https://www.monster.com/job-openings/aml-analyst-ny--1234",
      "https://www.dice.com/job-detail/1a2b3c4d",
      "https://wellfound.com/jobs/2871234-analyst",
      "https://jobs.jobvite.com/acme/job/oaBWofwn",
      "https://careers.icims.com/jobs/12345/analyst/job",
    ]) {
      const check = classifyApplyCapability(url);
      expect(check.capability, url).toBe("manual_open_only");
      expect(check.reason, url).toBeTruthy();
      expect(isFormFillSupported(url), url).toBe(false);
    }
  });

  it("classifies unknown company pages as manual_open_only — the user can still open and apply by hand", () => {
    const check = classifyApplyCapability("https://careers.example-company.com/openings/aml-analyst-123");
    expect(check.capability).toBe("manual_open_only");
    expect(check.reason).toMatch(/yourself|manually/i);
  });

  it("classifies board roots / search pages as unsupported — there is no application form there", () => {
    for (const url of [
      "https://www.linkedin.com/jobs/search/?keywords=analyst",
      "https://www.indeed.com/jobs?q=analyst&l=NYC",
      "https://jobs.lever.co/acme", // board root, not a posting
    ]) {
      expect(classifyApplyCapability(url).capability, url).toBe("unsupported");
    }
  });

  it("classifies missing/placeholder/invalid URLs as unsupported", () => {
    for (const url of [undefined, null, "", "about:blank", "null", "not a url", "ftp://x/y"]) {
      expect(classifyApplyCapability(url as string | null | undefined).capability).toBe("unsupported");
    }
  });

  it("treats loopback fixture pages as supported (the developer's own local forms)", () => {
    expect(classifyApplyCapability("http://127.0.0.1:4173/greenhouse-form.html").capability).toBe("supported_form_fill");
    expect(classifyApplyCapability("http://localhost:8080/fixture").capability).toBe("supported_form_fill");
  });
});

describe("resolveApplyDisplay — never a hidden browser", () => {
  it("uses the embedded panel only when requested AND the desktop shell provides a CDP endpoint", () => {
    expect(resolveApplyDisplay("embedded", "http://127.0.0.1:5180")).toBe("embedded");
    expect(resolveApplyDisplay("embedded", undefined)).toBe("window");
    expect(resolveApplyDisplay("window", "http://127.0.0.1:5180")).toBe("window");
    expect(resolveApplyDisplay(undefined, undefined)).toBe("window");
  });
});

describe("ApplySession.start — enforcement at the session layer", () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-capability-"));
    db = openDatabase(join(dir, "d.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses manual-only and unsupported URLs before any browser exists", async () => {
    const profile = createBlankProfile("cap");
    const makeSession = () => {
      throw new Error("no browser session may be created for an unsupported job");
    };
    await expect(
      ApplySession.start(db, profile, { url: "https://www.linkedin.com/jobs/view/123456" }, { makeSession })
    ).rejects.toThrow(/isn't supported for automated form filling/i);
    await expect(
      ApplySession.start(db, profile, { url: "https://www.indeed.com/jobs?q=x" }, { makeSession })
    ).rejects.toThrow(/isn't supported for automated form filling/i);
  });
});
