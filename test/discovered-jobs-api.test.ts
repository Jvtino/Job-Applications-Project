import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { DiscoveredJobsRepo } from "../src/db/discovered-jobs-repo";
import { DiscoveryAuditRepo } from "../src/db/discovery-audit-repo";
import { ApplicationsRepo } from "../src/db/applications-repo";
import { createBlankProfile } from "../src/profile/factory";
import { startApiServer } from "../src/server/api";

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/discovered-jobs", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-jobs-api-"));
    db = openDatabase(join(dir, "jobs.sqlite"));
    const profile = createBlankProfile("jobs-api");
    new ProfileRepo(db, undefined).save(profile);
    new DiscoveredJobsRepo(db).upsert(
      profile.id,
      {
        company: "Acme",
        title: "Product Manager",
        jobUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
        atsType: "greenhouse",
        score: 0.82,
        rationale: "Strong PM match",
        knockouts: [],
      },
      "scored"
    );
    new DiscoveredJobsRepo(db).upsert(
      profile.id,
      {
        company: "Beta",
        title: "Analyst",
        jobUrl: "https://job-boards.greenhouse.io/beta/jobs/2",
        atsType: "greenhouse",
        score: 0.4,
        rationale: "Weak fit",
        knockouts: ["Requires clearance"],
      },
      "scored"
    );
    server = startApiServer(0, { db });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists actionable jobs by default and keeps full history behind include=all", async () => {
    const r = await fetch(`${base}/api/discovered-jobs`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { jobs: { title: string; fitPct: number; rationale: string; actionable: boolean }[] };
    expect(body.jobs.length).toBe(1);
    expect(body.jobs[0]!.fitPct).toBe(82);
    expect(body.jobs[0]!.rationale).toContain("PM");
    expect(body.jobs.find((j) => j.title === "Product Manager")?.actionable).toBe(true);
    expect(body.jobs.find((j) => j.title === "Analyst")).toBeUndefined();

    const all = await fetch(`${base}/api/discovered-jobs?include=all`);
    const allBody = (await all.json()) as { jobs: { title: string; actionable: boolean }[] };
    expect(allBody.jobs).toHaveLength(2);
    expect(allBody.jobs.find((j) => j.title === "Analyst")?.actionable).toBe(false);
  });

  it("filters by minScore query param", async () => {
    const r = await fetch(`${base}/api/discovered-jobs?minScore=0.7`);
    const body = (await r.json()) as { jobs: { title: string }[] };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]!.title).toBe("Product Manager");
  });

  it("treats an explicit minScore as a strict filter — no below-floor backfill", async () => {
    // The default view backfills up to MIN_SHOWN with browsable (any-score) rows so the screen is
    // never empty. But when a caller asks for minScore=0.99, nothing clears it and we must NOT pad
    // the result with the 0.82 PM row — an explicit floor means "only at/above this score".
    const strict = await fetch(`${base}/api/discovered-jobs?minScore=0.99`);
    const strictBody = (await strict.json()) as { jobs: unknown[] };
    expect(strictBody.jobs).toHaveLength(0);

    // The default view (no minScore) still surfaces the browsable PM row, proving backfill is alive
    // and only the explicit-floor path is strict.
    const def = await fetch(`${base}/api/discovered-jobs`);
    const defBody = (await def.json()) as { jobs: { title: string }[] };
    expect(defBody.jobs.some((j) => j.title === "Product Manager")).toBe(true);
  });

  it("explains a discovered job from the local audit trail", async () => {
    const profile = new ProfileRepo(db, undefined).getFirst()!;
    const pm = new DiscoveredJobsRepo(db).list(profile.id).find((j) => j.title === "Product Manager")!;
    const audit = new DiscoveryAuditRepo(db);
    const run = audit.startRun(profile.id, { test: "api explanation" });
    const queryId = audit.recordSourceQuery({
      traceId: run.traceId,
      profileId: profile.id,
      sourceType: "greenhouse",
      sourceLabel: "Acme",
      queryText: "https://job-boards.greenhouse.io/acme",
    });
    const observationId = audit.recordRawObservation({
      traceId: run.traceId,
      profileId: profile.id,
      queryId,
      sourceType: pm.atsType,
      sourceUrl: pm.jobUrl,
      rawPayload: { title: pm.title, company: pm.company },
    });
    audit.recordNormalizedCandidate({
      traceId: run.traceId,
      profileId: profile.id,
      jobId: pm.id,
      observationId,
      posting: pm,
      isNew: false,
    });
    audit.recordFilterDecisions(run.traceId, pm.id, pm);
    audit.recordScorecard(run.traceId, pm.id, pm);

    const r = await fetch(`${base}/api/discovered-jobs/explain?id=${pm.id}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      job: { id: string };
      explanation: { normalizedJob: { canonical_title: string } | null; observations: unknown[]; filterDecisions: unknown[]; scorecards: unknown[] };
    };
    expect(body.job.id).toBe(pm.id);
    expect(body.explanation.normalizedJob?.canonical_title).toBe("Product Manager");
    expect(body.explanation.observations).toHaveLength(1);
    expect(body.explanation.filterDecisions).toHaveLength(1);
    expect(body.explanation.scorecards).toHaveLength(1);
  });

  it("marks applied jobs", async () => {
    const profile = new ProfileRepo(db, undefined).getFirst()!;
    new ApplicationsRepo(db).record({
      profileId: profile.id,
      dedupKey: "job-boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      title: "Product Manager",
      url: "https://job-boards.greenhouse.io/acme/jobs/1",
      ats: "greenhouse",
      mode: "semi_auto",
      status: "needs_review",
      submitted: false,
    });
    const r = await fetch(`${base}/api/discovered-jobs?include=all`);
    const body = (await r.json()) as { jobs: { jobUrl: string; applied: boolean }[] };
    const acme = body.jobs.find((j) => j.jobUrl.includes("/acme/"));
    expect(acme?.applied).toBe(true);
  });

  it("suggests a tier from the fit score (A>=0.7, B>=0.5, else C)", async () => {
    const r = await fetch(`${base}/api/discovered-jobs?include=all`);
    const body = (await r.json()) as { jobs: { title: string; suggestedTier: string; tier?: string }[] };
    const pm = body.jobs.find((j) => j.title === "Product Manager")!; // score 0.82
    const analyst = body.jobs.find((j) => j.title === "Analyst")!; // score 0.4
    expect(pm.suggestedTier).toBe("A");
    expect(analyst.suggestedTier).toBe("C");
    expect(pm.tier).toBeUndefined(); // nothing assigned yet
  });

  it("set-tier persists the user's manual tier and survives re-discovery", async () => {
    const profile = new ProfileRepo(db, undefined).getFirst()!;
    const list = await (await fetch(`${base}/api/discovered-jobs?include=all`)).json();
    const pm = (list.jobs as { id: string; title: string }[]).find((j) => j.title === "Product Manager")!;

    const set = await fetch(`${base}/api/discovered-jobs/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: pm.id, action: "set-tier", tier: "A" }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()).tier).toBe("A");

    // Re-discovering the SAME posting (upsert) must NOT clobber the user's tier.
    new DiscoveredJobsRepo(db).upsert(
      profile.id,
      {
        company: "Acme",
        title: "Product Manager",
        jobUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
        atsType: "greenhouse",
        score: 0.9,
        rationale: "Strong PM match (re-scored)",
        knockouts: [],
      },
      "scored"
    );
    const after = await (await fetch(`${base}/api/discovered-jobs?include=all`)).json();
    const pmAfter = (after.jobs as { id: string; tier?: string }[]).find((j) => j.id === pm.id)!;
    expect(pmAfter.tier).toBe("A");
  });

  it("rejects an unknown discovered-jobs action", async () => {
    const r = await fetch(`${base}/api/discovered-jobs/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "whatever", action: "bogus" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/set-tier/);
  });

  it("discards a discovered job by marking it skipped", async () => {
    const before = await fetch(`${base}/api/discovered-jobs?include=all`);
    const beforeBody = (await before.json()) as { jobs: { id: string; title: string; status: string }[] };
    const beta = beforeBody.jobs.find((j) => j.title === "Analyst")!;

    const r = await fetch(`${base}/api/discovered-jobs/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: beta.id, action: "discard" }),
    });
    expect(r.status).toBe(200);

    const after = await fetch(`${base}/api/discovered-jobs?include=all`);
    const afterBody = (await after.json()) as { jobs: { id: string; title: string; status: string }[] };
    expect(afterBody.jobs.find((j) => j.id === beta.id)?.status).toBe("skipped");
  });
});

describe("GET /api/discovered-jobs profile isolation", () => {
  it("excludes another profile's jobs and rejects cross-profile actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-jobs-api-scope-"));
    const db = openDatabase(join(dir, "jobs.sqlite"));
    const profileRepo = new ProfileRepo(db, undefined);
    const other = createBlankProfile("other-profile");
    other.createdAt = "2026-01-01T00:00:00.000Z";
    other.updatedAt = "2026-01-01T00:00:00.000Z";
    profileRepo.save(other);
    await new Promise((r) => setTimeout(r, 5));
    const active = createBlankProfile("active-profile");
    active.createdAt = "2026-02-01T00:00:00.000Z";
    active.updatedAt = "2026-02-01T00:00:00.000Z";
    profileRepo.save(active);

    const jobsRepo = new DiscoveredJobsRepo(db);
    const otherJob = jobsRepo.upsert(
      other.id,
      {
        company: "Demo Co",
        title: "Other Profile Role",
        jobUrl: "https://job-boards.greenhouse.io/demo/jobs/other",
        atsType: "greenhouse",
        score: 0.99,
        rationale: "wrong profile",
        knockouts: [],
      },
      "scored"
    );
    jobsRepo.upsert(
      active.id,
      {
        company: "Live Co",
        title: "Active Profile Role",
        jobUrl: "https://job-boards.greenhouse.io/live/jobs/123456",
        atsType: "greenhouse",
        score: 0.75,
        rationale: "right profile",
        knockouts: [],
      },
      "scored"
    );

    const server = startApiServer(0, { db });
    const base = await listening(server);
    try {
      const list = await (await fetch(`${base}/api/discovered-jobs`)).json() as { jobs: { title: string }[] };
      expect(list.jobs.map((j) => j.title)).toEqual(["Active Profile Role"]);

      const setTier = await fetch(`${base}/api/discovered-jobs/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: otherJob.job.id, action: "set-tier", tier: "A" }),
      });
      expect(setTier.status).toBe(404);

      const discard = await fetch(`${base}/api/discovered-jobs/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: otherJob.job.id, action: "discard" }),
      });
      expect(discard.status).toBe(404);
      const unchanged = jobsRepo.list(other.id)[0]!;
      expect(unchanged.status).toBe("scored");
      expect(unchanged.tier).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
