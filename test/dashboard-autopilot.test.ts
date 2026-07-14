// Dashboard "Run autopilot" control + surfaced state.
//
// Three layers:
//   1. The POST /api/autopilot endpoint, driven with an INJECTED fake pass (no real browser): it
//      returns the run summary, is the only state-changing route, and rejects an overlapping run.
//   2. buildDashboardState surfaces accounts (logged-in vs needs-login) + the last autopilot run.
//   3. runSemiAutopilotPass against the local Greenhouse fixture: a real (headless) browser proves
//      the wrapper fills + queues and submits NOTHING — the dashboard's semi/no-live lock.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import { openDatabase, recordAudit, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { AccountsRepo } from "../src/db/accounts-repo";
import { CompaniesRepo } from "../src/db/companies-repo";
import { DiscoveredJobsRepo } from "../src/db/discovered-jobs-repo";
import { LedgerRepo } from "../src/db/ledger-repo";
import { ingestResumeBuffer } from "../src/server/ingest-runner";
import { approveAll } from "../src/ingestion/ledger-ops";
import { createBlankProfile } from "../src/profile/factory";
import { buildDashboardState } from "../src/server/dashboard-state";
import { startApiServer } from "../src/server/api";
import { runSemiAutopilotPass, type SemiPassOptions } from "../src/server/autopilot-runner";
import type { AutopilotRun } from "../src/orchestrator/autopilot";
import type { ApplicantProfile } from "../src/types/applicant-profile";
import type { JobFitScore } from "../src/types/job-fit";

const here = dirname(fileURLToPath(import.meta.url));

function cleanProfile(id: string): ApplicantProfile {
  const p = createBlankProfile(id);
  p.contact.legalFirstName = "Ahmet";
  p.contact.legalLastName = "Kaya";
  p.contact.email = "ahmet.kaya@example.com";
  p.contact.phone = "(415) 555-0188";
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  p.screening.isAtLeast18 = { value: true, source: "user", updatedAt: "" };
  p.preferences.targetRoles = ["Operations Analyst"]; // target set → intent-confidence apply gate open (Part H)
  return p;
}

function weakFit(overrides: Partial<JobFitScore> = {}): JobFitScore {
  return {
    overallScore: 51,
    matchCategory: "weak",
    interviewProbability: "low",
    categoryScores: {
      titleAlignment: 30,
      hardSkillMatch: 20,
      experienceMatch: 20,
      industryMatch: 30,
      seniorityMatch: 70,
      locationWorkArrangement: 100,
      educationCertificationMatch: 50,
      resumeStrengthForRole: 25,
      interviewProbability: 25,
    },
    categoryReasoning: {},
    reasoningSummary: "Weak match: missing required software engineering skills.",
    topMatchReasons: [],
    mainConcerns: ["missing required software engineering skills"],
    missingRequirements: ["software engineering"],
    recommendedAction: "skip",
    resumeKeywordsToEmphasize: [],
    coverLetterAngle: "",
    hardBlockers: [],
    confidence: "medium",
    method: "deterministic",
    ...overrides,
  };
}

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((res) => (server.listening ? res() : server.once("listening", () => res())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const SIMPLE_RUN: AutopilotRun = { results: [], submitted: 0, wouldSubmit: 0, queued: 2, skipped: 0 };

describe("POST /api/autopilot endpoint", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;
  let currentPass: (d: DB, p: ApplicantProfile, opts?: SemiPassOptions) => Promise<AutopilotRun>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-api-"));
    db = openDatabase(join(dir, "api.sqlite"));
    new ProfileRepo(db, undefined).save(cleanProfile("api"));
    server = startApiServer(0, { db, runAutopilotPass: (d, p, opts) => currentPass(d, p, opts) });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    currentPass = async () => SIMPLE_RUN;
  });

  it("runs a semi pass and returns the summary", async () => {
    let modeSeen = "";
    currentPass = async () => {
      modeSeen = "called";
      return SIMPLE_RUN;
    };
    const r = await fetch(`${base}/api/autopilot`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; mode: string; run: AutopilotRun };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("semi_auto"); // the dashboard pass is always semi
    expect(body.run.queued).toBe(2);
    expect(modeSeen).toBe("called");
  });

  it("creates and updates a persistent automation progress record", async () => {
    currentPass = async (_d, _p, opts) => {
      opts?.onProgressUpdate?.({
        status: "matching",
        currentStepLabel: "Matching roles against your rules",
        totalItems: 1,
        qualifiedCount: 1,
        processedItems: 0,
        event: "Started matching roles",
      });
      opts?.onProgressUpdate?.({
        status: "preparing_packet",
        currentStepLabel: "Preparing review packet for Acme / Operations Analyst",
        event: "Preparing review packet for Acme / Operations Analyst",
      });
      opts?.onProgressUpdate?.({
        status: "needs_review",
        currentStepLabel: "Acme / Operations Analyst queued for review",
        processedItems: 1,
        oneClickCount: 1,
        event: "Application requires manual review",
      });
      return {
        results: [{ company: "Acme", title: "Operations Analyst", jobUrl: "https://jobs.example/1", action: "queued", reason: "manual review" }],
        submitted: 0,
        wouldSubmit: 0,
        queued: 1,
        skipped: 0,
      };
    };

    const r = await fetch(`${base}/api/autopilot`, { method: "POST" });
    expect(r.status).toBe(200);
    const progress = await (await fetch(`${base}/api/automation/progress`)).json() as {
      progress: { status: string; totalItems: number; processedItems: number; qualifiedCount: number; oneClickCount: number; percentComplete: number; recentEvents: string[] };
    };
    expect(progress.progress.status).toBe("needs_review");
    expect(progress.progress.totalItems).toBe(1);
    expect(progress.progress.processedItems).toBe(1);
    expect(progress.progress.qualifiedCount).toBe(1);
    expect(progress.progress.oneClickCount).toBe(1);
    expect(progress.progress.percentComplete).toBe(100);
    expect(progress.progress.recentEvents).toContain("Application requires manual review");

    const state = await (await fetch(`${base}/api/state`)).json() as { automationProgress: typeof progress.progress };
    expect(state.automationProgress.status).toBe("needs_review");
    expect(state.automationProgress.percentComplete).toBe(100);
  });

  it("marks automation progress failed when the pass throws", async () => {
    currentPass = async () => {
      throw new Error("synthetic pass failure");
    };
    const r = await fetch(`${base}/api/autopilot`, { method: "POST" });
    expect(r.status).toBe(500);
    const progress = await (await fetch(`${base}/api/automation/progress`)).json() as {
      progress: { status: string; errorMessage: string | null; recentEvents: string[] };
    };
    expect(progress.progress.status).toBe("failed");
    expect(progress.progress.errorMessage).toContain("synthetic pass failure");
    expect(progress.progress.recentEvents[0]).toContain("Automation failed");
  });

  it("preserves a failed application result instead of overwriting it as completed", async () => {
    currentPass = async (_d, _p, opts) => {
      opts?.onProgressUpdate?.({
        status: "discovering",
        currentStepLabel: "Automation Discovery: searched Acme",
        totalItems: 2,
        processedItems: 1,
        event: "Discovery source searched: Acme (1 new)",
      });
      opts?.onProgressUpdate?.({
        status: "failed",
        currentStepLabel: "Error on Acme: form changed",
        totalItems: 2,
        processedItems: 2,
        failedCount: 1,
        completedAt: "2026-06-24T19:00:00.000Z",
        errorMessage: "form changed",
        event: "Application failed: form changed",
      });
      return {
        results: [{ company: "Acme", title: "Operations Analyst", jobUrl: "https://jobs.example/1", action: "error", reason: "form changed" }],
        submitted: 0,
        wouldSubmit: 0,
        queued: 0,
        skipped: 1,
      };
    };

    const r = await fetch(`${base}/api/autopilot`, { method: "POST" });
    expect(r.status).toBe(200);
    const progress = await (await fetch(`${base}/api/automation/progress`)).json() as {
      progress: { status: string; failedCount: number; errorMessage: string | null; percentComplete: number; recentEvents: string[] };
    };
    expect(progress.progress.status).toBe("failed");
    expect(progress.progress.failedCount).toBe(1);
    expect(progress.progress.errorMessage).toBe("form changed");
    expect(progress.progress.percentComplete).toBe(100);
    expect(progress.progress.recentEvents[0]).toBe("Application failed: form changed");
  });

  it("is the only state-changing route — other POSTs and non-POST autopilot are rejected", async () => {
    const wrongVerb = await fetch(`${base}/api/autopilot`, { method: "GET" });
    expect(wrongVerb.status).toBe(405);
    const wrongPath = await fetch(`${base}/api/state`, { method: "POST" });
    expect(wrongPath.status).toBe(405);
    // GET state stays read-only and now carries accounts + lastRun.
    const state = await fetch(`${base}/api/state`);
    expect(state.status).toBe(200);
    const s = (await state.json()) as { configured: boolean; accounts: unknown; lastRun: unknown };
    expect(s.configured).toBe(true);
    expect(s).toHaveProperty("accounts");
    expect(s).toHaveProperty("lastRun");
  });

  it("rejects a second concurrent pass with 409 (one browser at a time)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    currentPass = async () => {
      calls++;
      await gate;
      return SIMPLE_RUN;
    };
    const p1 = fetch(`${base}/api/autopilot`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 40)); // let the first request enter the running state
    const r2 = await fetch(`${base}/api/autopilot`, { method: "POST" });
    expect(r2.status).toBe(409);
    release();
    const r1 = await p1;
    expect(r1.status).toBe(200);
    expect(calls).toBe(1); // the rejected request never invoked the pass
  });
});

describe("buildDashboardState — accounts + last run", () => {
  it("surfaces logged-in vs needs-login accounts and the most recent pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-ds-"));
    const db = openDatabase(join(dir, "ds.sqlite"));
    const profile = cleanProfile("ds");
    new ProfileRepo(db, undefined).save(profile);

    const accounts = new AccountsRepo(db);
    accounts.upsert({ profileId: profile.id, domain: "jobs.ashbyhq.com", username: "ahmet.kaya@example.com", accountExists: true });
    accounts.markLoggedIn(profile.id, "jobs.ashbyhq.com");
    accounts.upsert({ profileId: profile.id, domain: "jobs.lever.co" }); // never logged in

    recordAudit(db, profile.id, "autopilot.run", { mode: "semi_auto", considered: 4, submitted: 0, wouldSubmit: 0, queued: 3, skipped: 1 });

    const s = buildDashboardState(db, undefined);
    expect(s.accounts.total).toBe(2);
    expect(s.accounts.loggedIn).toBe(1);
    expect(s.accounts.needsLogin).toBe(1);
    expect(s.accounts.rows.find((r) => r.domain === "jobs.ashbyhq.com")?.loggedIn).toBe(true);
    expect(s.lastRun?.mode).toBe("semi_auto");
    expect(s.lastRun?.queued).toBe(3);
    expect(s.lastRun?.skipped).toBe(1);
    expect(s.lastRun?.submitted).toBe(0);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("scopes ready queue metrics and company found counts to the active profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-ds-scope-"));
    const db = openDatabase(join(dir, "ds.sqlite"));
    const other = cleanProfile("other");
    other.createdAt = "2026-01-01T00:00:00.000Z";
    other.updatedAt = "2026-01-01T00:00:00.000Z";
    new ProfileRepo(db, undefined).save(other);
    const active = cleanProfile("active");
    active.createdAt = "2026-02-01T00:00:00.000Z";
    active.updatedAt = "2026-02-01T00:00:00.000Z";
    new ProfileRepo(db, undefined).save(active);
    new CompaniesRepo(db).add("Acme", "https://job-boards.greenhouse.io/acme", "greenhouse");

    const jobs = new DiscoveredJobsRepo(db);
    jobs.upsert(
      other.id,
      { title: "Other Role", company: "Acme", jobUrl: "https://job-boards.greenhouse.io/acme/jobs/other", atsType: "greenhouse", score: 0.99, rationale: "wrong profile", knockouts: [] },
      "scored"
    );
    jobs.upsert(
      active.id,
      { title: "Active Role", company: "Acme", jobUrl: "https://job-boards.greenhouse.io/acme/jobs/active", atsType: "greenhouse", score: 0.8, rationale: "right profile", knockouts: [] },
      "scored"
    );
    jobs.upsert(
      active.id,
      {
        title: "Software Engineer II, Backend",
        company: "Acme",
        jobUrl: "https://job-boards.greenhouse.io/acme/jobs/weak",
        atsType: "greenhouse",
        score: 0.51,
        rationale: "Weak match: missing required software engineering skills.",
        knockouts: [],
        fit: weakFit(),
      },
      "scored"
    );

    const s = buildDashboardState(db, undefined);
    expect(s.rail.readyToClick).toBe(1);
    expect(s.hero.metrics.qualified).toBe(1);
    expect(s.oneClick.map((j) => j.role)).toEqual(["Active Role"]);
    expect(s.coverage.sources.find((source) => source.name === "Acme")?.found).toBe(2);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runSemiAutopilotPass (real browser, fixture)", () => {
  let server: http.Server;
  let url: string;
  let dir: string;
  let genDir: string;
  let resumePath: string;

  beforeAll(async () => {
    const html = readFileSync(join(here, "fixtures", "greenhouse-clean.html"), "utf8");
    server = http.createServer((_q, res) => {
      res.setHeader("content-type", "text/html");
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acme/jobs/clean/apply`;
    dir = mkdtempSync(join(tmpdir(), "applypilot-semi-"));
    genDir = join(dir, "generated");
    resumePath = join(dir, "resume.pdf");
    writeFileSync(resumePath, "%PDF-1.4\n% test resume\n");
  }, 90000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills and queues every match and submits nothing", async () => {
    const db = openDatabase(join(dir, "semi.sqlite"));
    const profile = cleanProfile("semi");
    profile.masterResumePath = resumePath;
    new ProfileRepo(db, undefined).save(profile);
    // Approved ledger facts → verified tailored docs (the master-résumé bypass is refused on the
    // automated apply path — A3).
    const ingested = await ingestResumeBuffer(db, undefined, profile, join(dir, "resumes"), {
      filename: "resume.txt",
      buffer: readFileSync(join(here, "fixtures", "sample-resume.txt")),
    });
    new LedgerRepo(db, undefined).save(approveAll(ingested.ledger));
    const companies = new CompaniesRepo(db);
    companies.add("Acme", "https://job-boards.greenhouse.io/acme", "greenhouse");
    new DiscoveredJobsRepo(db).upsert(
      profile.id,
      { title: "Operations Analyst", company: "Acme", location: "New York, NY", jobUrl: url, atsType: "greenhouse", score: 0.9, rationale: "strong match", knockouts: [] },
      "scored"
    );

    const run = await runSemiAutopilotPass(db, profile, {
      headed: false,
      userDataDir: join(dir, "p"),
      minActionDelayMs: 1,
      maxActionDelayMs: 2,
      minScore: 0.5,
      generatedDir: genDir,
      maxSourceSearches: 0, // board-scan only; live aggregator search isn't what this test exercises
    });

    expect(run.submitted).toBe(0); // semi never submits
    expect(run.results[0]?.action).toBe("queued");
    db.close();
  }, 90000);
});
