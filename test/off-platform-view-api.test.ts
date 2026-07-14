// Off-platform surfacing UX (Feature 4): the employer-ATS-only Matches filter (?employerOnly=1) and
// the assisted LinkedIn/Indeed search route (/api/assisted-search). Both are compliant: the filter
// hides aggregator-URL leads, and the route only BUILDS a search URL for the user to open themselves —
// the app never fetches LinkedIn/Indeed.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { DiscoveredJobsRepo } from "../src/db/discovered-jobs-repo";
import { createBlankProfile } from "../src/profile/factory";
import { startApiServer } from "../src/server/api";

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("off-platform surfacing UX (employer-only filter + assisted search)", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-offplatform-"));
    db = openDatabase(join(dir, "off.sqlite"));
    const profile = createBlankProfile("offplatform");
    profile.preferences.targetRoles = ["AML Analyst"];
    new ProfileRepo(db, undefined).save(profile);
    const jobs = new DiscoveredJobsRepo(db);
    // An employer-ATS posting (Tier 1) …
    jobs.upsert(
      profile.id,
      {
        company: "Acme",
        title: "AML Analyst",
        jobUrl: "https://job-boards.greenhouse.io/acme/jobs/1",
        atsType: "greenhouse",
        score: 0.82,
        rationale: "Strong AML match",
        knockouts: [],
      },
      "scored",
    );
    // … and a LinkedIn alert LEAD (aggregator URL) for a similar role.
    jobs.upsert(
      profile.id,
      {
        company: "Northwind Bank",
        title: "Senior AML Analyst",
        jobUrl: "https://www.linkedin.com/jobs/view/3811234567",
        atsType: "linkedin",
        score: 0.8,
        rationale: "AML lead from a LinkedIn alert",
        knockouts: [],
      },
      "scored",
    );
    server = startApiServer(0, { db });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows both employer + aggregator rows by default, but ?employerOnly=1 keeps only employer-ATS ones", async () => {
    const all = (await (await fetch(`${base}/api/discovered-jobs?include=all`)).json()) as {
      jobs: { atsType: string }[];
    };
    expect(all.jobs.some((j) => j.atsType === "greenhouse")).toBe(true);
    expect(all.jobs.some((j) => j.atsType === "linkedin")).toBe(true);

    const employerOnly = (await (
      await fetch(`${base}/api/discovered-jobs?include=all&employerOnly=1`)
    ).json()) as { jobs: { atsType: string }[] };
    expect(employerOnly.jobs.some((j) => j.atsType === "greenhouse")).toBe(true);
    // The LinkedIn lead (aggregator URL) is hidden — only company-site postings remain.
    expect(employerOnly.jobs.some((j) => j.atsType === "linkedin")).toBe(false);
  });

  it("builds pre-filled LinkedIn/Indeed search URLs from the user's intent (never fetches them)", async () => {
    const r = await fetch(`${base}/api/assisted-search`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as { keywords: string; linkedin: string; indeed: string };
    expect(b.keywords).toBe("AML Analyst");
    expect(b.linkedin).toContain("https://www.linkedin.com/jobs/search/");
    expect(b.linkedin).toContain("AML");
    expect(b.indeed).toContain("https://www.indeed.com/jobs");
    expect(b.indeed).toContain("AML");
  });
});
