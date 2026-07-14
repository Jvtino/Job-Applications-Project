import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { CompaniesRepo } from "../src/db/companies-repo";
import { DiscoveredJobsRepo } from "../src/db/discovered-jobs-repo";
import { runAutopilot } from "../src/orchestrator/autopilot";
import { createBlankProfile } from "../src/profile/factory";

describe("autopilot URL safety", () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-autopilot-safety-"));
    db = openDatabase(join(dir, "d.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips placeholder ATS URLs before opening a browser page", async () => {
    const profile = createBlankProfile("p");
    profile.preferences.targetRoles = ["Product Manager"]; // target set → apply gate open (Part H)
    new CompaniesRepo(db).add("Ramp", "https://jobs.ashbyhq.com/ramp", "ashby");
    new DiscoveredJobsRepo(db).upsert(
      profile.id,
      { title: "Product Lead", company: "Ramp", jobUrl: "https://jobs.ashbyhq.com/ramp/ccc", atsType: "ashby", score: 0.9, rationale: "demo", knockouts: [] },
      "scored"
    );

    const session = {
      open: async () => {
        throw new Error("placeholder URL should not be opened");
      },
    };
    const run = await runAutopilot(session as never, db, profile, { minScore: 0.5 });

    expect(run.skipped).toBe(1);
    expect(run.results[0]).toMatchObject({ action: "skipped", reason: expect.stringMatching(/board or search page/i) });
    expect(new DiscoveredJobsRepo(db).list(profile.id)[0]!.status).toBe("skipped");
  });

  it("skips manual-only sources (no form-fill adapter) but keeps them visible for a manual apply", async () => {
    const profile = createBlankProfile("p2");
    profile.preferences.targetRoles = ["AML Analyst"]; // target set → apply gate open (Part H)
    new CompaniesRepo(db).add("BigCo", "https://www.linkedin.com/jobs/search/", "linkedin");
    new DiscoveredJobsRepo(db).upsert(
      profile.id,
      { title: "AML Analyst", company: "BigCo", jobUrl: "https://www.linkedin.com/jobs/view/424242", atsType: "linkedin", score: 0.92, rationale: "demo", knockouts: [] },
      "scored"
    );

    const session = {
      open: async () => {
        throw new Error("manual-only URLs must never enter the fill pipeline");
      },
    };
    const run = await runAutopilot(session as never, db, profile, { minScore: 0.5 });

    expect(run.skipped).toBe(1);
    expect(run.results[0]).toMatchObject({ action: "skipped", reason: expect.stringMatching(/apply manually|manual/i) });
    // Manual-only jobs stay reviewable — autopilot must NOT bury them under a "skipped" status.
    expect(new DiscoveredJobsRepo(db).list(profile.id)[0]!.status).not.toBe("skipped");
  });

  it("Part H: refuses to auto-apply when the target intent is unconfirmed (no target roles)", async () => {
    const profile = createBlankProfile("p3"); // no targetRoles, no facts → confidence "missing"
    new CompaniesRepo(db).add("Acme", "https://job-boards.greenhouse.io/acme", "greenhouse");
    new DiscoveredJobsRepo(db).upsert(
      profile.id,
      { title: "Analyst", company: "Acme", location: "New York, NY", jobUrl: "https://job-boards.greenhouse.io/acme/jobs/555", atsType: "greenhouse", score: 0.95, rationale: "demo", knockouts: [] },
      "scored"
    );

    const session = {
      open: async () => {
        throw new Error("must not open a page when the target is unconfirmed");
      },
    };
    const run = await runAutopilot(session as never, db, profile, { minScore: 0.5 });

    // A form-fill-capable, US-eligible, high-scoring job is STILL not auto-applied — target unconfirmed.
    expect(run.skipped).toBe(1);
    expect(run.submitted).toBe(0);
    expect(run.results[0]).toMatchObject({ action: "skipped", reason: expect.stringMatching(/confirm your target|target is/i) });
  });
});
