import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { LedgerRepo } from "../src/db/ledger-repo";
import { DiscoveredJobsRepo } from "../src/db/discovered-jobs-repo";
import { createBlankProfile } from "../src/profile/factory";
import { startApiServer } from "../src/server/api";
import type { FactsLedger } from "../src/types/facts-ledger";

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/insights", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-insights-api-"));
    db = openDatabase(join(dir, "insights.sqlite"));
    const other = createBlankProfile("other-insights");
    other.updatedAt = "2026-01-01T00:00:00.000Z";
    new ProfileRepo(db, undefined).save(other);
    const profile = createBlankProfile("insights-api");
    profile.updatedAt = "2026-02-01T00:00:00.000Z";
    new ProfileRepo(db, undefined).save(profile);

    const ledger: FactsLedger = {
      profileId: profile.id,
      facts: [{ id: "s1", type: "skill", approved: true, statement: "SQL" }],
    };
    new LedgerRepo(db, undefined).save(ledger);

    const repo = new DiscoveredJobsRepo(db);
    repo.upsert(
      profile.id,
      { company: "Acme", title: "AML Analyst", jobUrl: "https://job-boards.greenhouse.io/acme/jobs/1", atsType: "greenhouse", score: 0.8, rationale: "match", knockouts: [], description: "Needs AML and Tableau and SQL for transaction monitoring duties." },
      "scored"
    );
    repo.upsert(
      profile.id,
      { company: "Beta", title: "Compliance Analyst", jobUrl: "https://job-boards.greenhouse.io/beta/jobs/2", atsType: "greenhouse", score: 0.7, rationale: "match", knockouts: [], description: "AML compliance role; Tableau dashboards and SQL queries required." },
      "scored"
    );
    repo.upsert(
      other.id,
      { company: "Other", title: "Data Scientist", jobUrl: "https://job-boards.greenhouse.io/other/jobs/9", atsType: "greenhouse", score: 0.95, rationale: "wrong profile", knockouts: [], description: "Python machine learning pipelines and Python modeling." },
      "scored"
    );
    // A skipped job must be excluded from the aggregate.
    const skipped = repo.upsert(
      profile.id,
      { company: "Gamma", title: "Quant", jobUrl: "https://job-boards.greenhouse.io/gamma/jobs/3", atsType: "greenhouse", score: 0.6, rationale: "match", knockouts: [], description: "Python and machine learning and Python modeling and Python pipelines." },
      "scored"
    );
    repo.setStatus(profile.id, skipped.job.id, "skipped");

    server = startApiServer(0, { db });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates only the in-play jobs (skipped excluded)", async () => {
    const r = await fetch(`${base}/api/insights`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { jobsAnalyzed: number; topGaps: { term: string }[]; topMatched: { term: string }[] };
    expect(body.jobsAnalyzed).toBe(2);
    // "python" appears only in a skipped job and another profile's job -> must not surface at all.
    const allTerms = [...body.topGaps, ...body.topMatched].map((t) => t.term);
    expect(allTerms).not.toContain("python");
  });

  it("reports an unmet demand (tableau) as a gap and a met one (sql) as matched", async () => {
    const r = await fetch(`${base}/api/insights`);
    const body = (await r.json()) as { topGaps: { term: string; jobCount: number }[]; topMatched: { term: string }[] };
    expect(body.topGaps.map((g) => g.term)).toContain("tableau");
    expect(body.topMatched.map((m) => m.term)).toContain("sql");
  });

  it("rejects non-GET", async () => {
    const r = await fetch(`${base}/api/insights`, { method: "POST" });
    expect(r.status).toBe(405);
  });
});
