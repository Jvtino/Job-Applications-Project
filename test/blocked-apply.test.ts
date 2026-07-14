// "Park blocked applications and keep going" — backend coverage.
//
// Two layers, both browser-free:
//   1. Loop routing: when runApplication returns an outcome carrying `needsYou` (a login/account wall
//      or a CAPTCHA), runAutopilot parks the discovered job at status "blocked" (NOT generic
//      needs_review), records action "blocked", and keeps going. runApplication + prepareApplicationDocs
//      are mocked so no real browser/LLM is needed.
//   2. dashboard-state: a "challenge" / "account_required" application row surfaces in state.blocked
//      with the right reason, and the parked job is kept out of the normal one-click queue.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { CompaniesRepo } from "../src/db/companies-repo";
import { DiscoveredJobsRepo } from "../src/db/discovered-jobs-repo";
import { ApplicationsRepo, dedupKeyForUrl } from "../src/db/applications-repo";
import { createBlankProfile } from "../src/profile/factory";
import { buildDashboardState } from "../src/server/dashboard-state";
import type { ApplicantProfile } from "../src/types/applicant-profile";
import type { BrowserSession } from "../src/ats/browser";
import type { ApplyOutcome } from "../src/orchestrator/apply";

// Hoisted mocks so the vi.mock factories can reference them (avoids the const TDZ trap).
const mocks = vi.hoisted(() => ({
  runApplication: vi.fn(),
  prepareApplicationDocs: vi.fn(),
}));

vi.mock("../src/orchestrator/prepare-docs", () => ({
  prepareApplicationDocs: mocks.prepareApplicationDocs,
}));

// Preserve everything real EXCEPT runApplication (which would open a browser).
vi.mock("../src/orchestrator/apply", async (importActual) => {
  const actual = await importActual<typeof import("../src/orchestrator/apply")>();
  return { ...actual, runApplication: mocks.runApplication };
});

// Imported AFTER the mocks are registered.
import { runAutopilot } from "../src/orchestrator/autopilot";

function cleanProfile(id: string): ApplicantProfile {
  const p = createBlankProfile(id);
  p.contact.legalFirstName = "Ahmet";
  p.contact.legalLastName = "Kaya";
  p.contact.email = "ahmet.kaya@example.com";
  p.contact.phone = "(415) 555-0188";
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  p.screening.isAtLeast18 = { value: true, source: "user", updatedAt: "" };
  p.preferences.targetRoles = ["Operations Analyst"]; // target set → Part H apply gate open
  return p;
}

function seedActionableJob(db: DB, profile: ApplicantProfile, jobUrl: string, title = "Operations Analyst") {
  return new DiscoveredJobsRepo(db).upsert(
    profile.id,
    {
      title,
      company: "Acme",
      location: "New York, NY", // affirmatively US-eligible
      jobUrl,
      atsType: "greenhouse", // supported_form_fill capability
      score: 0.9, // clears the apply-recommended floor
      rationale: "strong match",
      knockouts: [],
    },
    "scored"
  ).job;
}

const noopSession = {} as unknown as BrowserSession; // never touched — runApplication is mocked

describe("runAutopilot routing: needsYou → discovered-status 'blocked'", () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-blocked-route-"));
    db = openDatabase(join(dir, "route.sqlite"));
    mocks.prepareApplicationDocs.mockReset();
    mocks.prepareApplicationDocs.mockResolvedValue({ resumePath: join(dir, "resume.pdf") });
    mocks.runApplication.mockReset();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { reason: "login" as const, label: "Log in / create an account to finish" },
    { reason: "captcha" as const, label: "Human verification (CAPTCHA) — open it to finish" },
  ])("parks a $reason-blocked job at status 'blocked' and keeps going", async ({ reason, label }) => {
    const profile = cleanProfile("route");
    new ProfileRepo(db, undefined).save(profile);
    new CompaniesRepo(db).add("Acme", "https://job-boards.greenhouse.io/acme", "greenhouse");
    const job = seedActionableJob(db, profile, "https://job-boards.greenhouse.io/acme/jobs/1");

    mocks.runApplication.mockResolvedValue({
      gate: {},
      applicationId: "app-1",
      submitted: false,
      needsYou: { reason, label },
    } as unknown as ApplyOutcome);

    const run = await runAutopilot(noopSession, db, profile, {
      mode: "semi_auto",
      minScore: 0.5,
      generatedDir: join(dir, "generated"),
    });

    expect(mocks.runApplication).toHaveBeenCalledTimes(1);
    expect(run.blocked).toBe(1);
    expect(run.queued).toBe(0);
    expect(run.submitted).toBe(0);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ action: "blocked", reason: label });

    // The discovered job is parked as "blocked" — NOT generic needs_review.
    expect(new DiscoveredJobsRepo(db).list(profile.id).find((j) => j.id === job.id)?.status).toBe("blocked");
  });
});

describe("buildDashboardState — state.blocked ('Needs you' queue)", () => {
  it("surfaces challenge/account_required apps with the right reason and keeps them out of the queue", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-blocked-state-"));
    const db = openDatabase(join(dir, "state.sqlite"));
    const profile = cleanProfile("state");
    new ProfileRepo(db, undefined).save(profile);
    new CompaniesRepo(db).add("Acme", "https://job-boards.greenhouse.io/acme", "greenhouse");

    const jobs = new DiscoveredJobsRepo(db);
    const loginUrl = "https://job-boards.greenhouse.io/acme/jobs/login-wall";
    const captchaUrl = "https://job-boards.greenhouse.io/acme/jobs/captcha";
    const normalUrl = "https://job-boards.greenhouse.io/acme/jobs/normal";

    const loginJob = seedActionableJob(db, profile, loginUrl, "Login Role");
    const captchaJob = seedActionableJob(db, profile, captchaUrl, "Captcha Role");
    seedActionableJob(db, profile, normalUrl, "Normal Role"); // stays a normal one-click match

    // The loop parks blocked jobs at the discovered level…
    jobs.setStatus(profile.id, loginJob.id, "blocked");
    jobs.setStatus(profile.id, captchaJob.id, "blocked");

    // …and the applications row carries the precise reason.
    const apps = new ApplicationsRepo(db);
    apps.record({ profileId: profile.id, dedupKey: dedupKeyForUrl(loginUrl), company: "Acme", title: "Login Role", url: loginUrl, ats: "greenhouse", mode: "semi_auto", status: "account_required", submitted: false });
    apps.record({ profileId: profile.id, dedupKey: dedupKeyForUrl(captchaUrl), company: "Acme", title: "Captcha Role", url: captchaUrl, ats: "greenhouse", mode: "semi_auto", status: "challenge", submitted: false });

    const s = buildDashboardState(db, undefined);

    expect(s.blocked).toHaveLength(2);
    expect(s.blocked.find((b) => b.title === "Login Role")).toMatchObject({
      id: loginJob.id, company: "Acme", url: loginUrl, reason: "login", reasonLabel: "Log in / account needed",
    });
    expect(s.blocked.find((b) => b.title === "Captcha Role")).toMatchObject({
      id: captchaJob.id, company: "Acme", url: captchaUrl, reason: "captcha", reasonLabel: "CAPTCHA / human check",
    });

    // Parked jobs never double-show as normal one-click matches; the untouched one still does.
    const oneClickRoles = s.oneClick.map((o) => o.role);
    expect(oneClickRoles).toContain("Normal Role");
    expect(oneClickRoles).not.toContain("Login Role");
    expect(oneClickRoles).not.toContain("Captcha Role");
    expect(s.rail.readyToClick).toBe(1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
