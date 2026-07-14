import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../../src/db/database";
import { CompaniesRepo } from "../../src/db/companies-repo";
import { DiscoveredJobsRepo } from "../../src/db/discovered-jobs-repo";
import { createBlankProfile } from "../../src/profile/factory";
import { classifyApplyCapability } from "../../src/jobs/apply-capability";
import { NetGuard } from "../../src/finder/net";
import { MockAgent } from "../../src/finder/net/testing";
import { runFinderDiscovery } from "../../src/finder/pipeline/run-discovery";

const greenhouseOk = readFileSync(
  join(import.meta.dirname, "fixtures", "connectors", "greenhouse", "ok_full.json"),
  "utf8",
);

describe("runFinderDiscovery (finder pipeline -> discovered_jobs)", () => {
  let db: DB;
  let mockAgent: MockAgent;
  let net: NetGuard;

  beforeEach(() => {
    db = openDatabase(":memory:");
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect(); // proves the pipeline touches nothing but the mocked host
    net = new NetGuard({ dispatcher: mockAgent, minIntervalMs: 0 });
    new CompaniesRepo(db).add("Acme", "https://job-boards.greenhouse.io/acme", "greenhouse");
  });
  afterEach(() => db.close());

  function intercept(body: string, status = 200) {
    mockAgent
      .get("https://boards-api.greenhouse.io")
      .intercept({ path: "/v1/boards/acme/jobs?content=true", method: "GET" })
      .reply(status, body, { headers: { "content-type": "application/json" } })
      .persist();
  }

  function profileFor(id: string, roles: string[]) {
    const p = createBlankProfile(id);
    p.preferences.targetRoles = roles;
    return p;
  }

  it("fetches, scores, and writes apply-capable rows into discovered_jobs", async () => {
    intercept(greenhouseOk);
    const profile = profileFor("u1", ["Compliance Analyst", "KYC Analyst"]);

    const run = await runFinderDiscovery({ db, profile, intent: null, insights: null, net });

    // DiscoveryRun shape the API/handleDiscover reads
    expect(run.perCompany.length).toBeGreaterThan(0);
    expect(run.scored.length).toBe(3);
    expect(run.newlyAdded.length).toBe(3);

    // Rows landed in discovered_jobs via the repo (the dashboard's read model)
    const jobs = new DiscoveredJobsRepo(db).list(profile.id, {});
    expect(jobs.length).toBe(3);
    expect(jobs.map((j) => j.title)).toContain("KYC Analyst");

    // Every greenhouse row is apply-capable, so the kept apply robot can act on it
    for (const j of jobs) {
      expect(j.atsType).toBe("greenhouse");
      expect(classifyApplyCapability(j.jobUrl).capability).toBe("supported_form_fill");
    }
  });

  it("re-running the same scan adds no new rows (idempotent upsert)", async () => {
    intercept(greenhouseOk);
    const profile = profileFor("u2", ["Compliance Analyst"]);
    await runFinderDiscovery({ db, profile, intent: null, insights: null, net });
    const run2 = await runFinderDiscovery({ db, profile, intent: null, insights: null, net });
    expect(run2.newlyAdded.length).toBe(0);
    expect(new DiscoveredJobsRepo(db).list(profile.id, {}).length).toBe(3);
  });

  it("drops confidently non-US postings before writing", async () => {
    intercept(
      JSON.stringify({
        jobs: [
          {
            id: 1,
            title: "US Analyst",
            absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
            location: { name: "Austin, TX" },
            content: "x",
          },
          {
            id: 2,
            title: "London Analyst",
            absolute_url: "https://boards.greenhouse.io/acme/jobs/2",
            location: { name: "London, United Kingdom" },
            content: "x",
          },
        ],
      }),
    );
    const profile = profileFor("u3", ["Analyst"]);
    await runFinderDiscovery({ db, profile, intent: null, insights: null, net });
    const titles = new DiscoveredJobsRepo(db).list(profile.id, {}).map((j) => j.title);
    expect(titles).toContain("US Analyst");
    expect(titles).not.toContain("London Analyst");
  });

  it("folds exported LinkedIn/Indeed job-alert emails into discovery (recorded, manual-apply only)", async () => {
    const profile = profileFor("u-email", ["AML Analyst"]);
    const alertMailDir = join(import.meta.dirname, "..", "email", "fixtures");
    // The greenhouse fetch is not intercepted here, so the alert emails are the only jobs that land.
    await runFinderDiscovery({ db, profile, intent: null, insights: null, net, alertMailDir });

    const jobs = new DiscoveredJobsRepo(db).list(profile.id, {});
    const fromEmail = jobs.filter((j) => j.atsType === "linkedin" || j.atsType === "indeed");
    expect(fromEmail.length).toBeGreaterThan(0);
    // Discovery records the link, but the app never auto-applies to a LinkedIn/Indeed page.
    for (const j of fromEmail) {
      expect(classifyApplyCapability(j.jobUrl).capability).not.toBe("supported_form_fill");
    }
  });

  it("resolves an alerted employer to its OWN ATS board and surfaces the off-platform posting", async () => {
    // linkedin-alert.eml names "Northwind Bank" (Senior AML Analyst, New York). The fixture catalog
    // maps Northwind Bank -> greenhouse 'northwind'. The resolver adds that board to the scan set, so
    // the real company-site posting is discovered — NO LinkedIn/Indeed host is ever fetched.
    mockAgent
      .get("https://boards-api.greenhouse.io")
      .intercept({ path: "/v1/boards/northwind/jobs?content=true", method: "GET" })
      .reply(
        200,
        JSON.stringify({
          jobs: [
            {
              id: 77,
              title: "Senior AML Analyst",
              absolute_url: "https://boards.greenhouse.io/northwind/jobs/77",
              location: { name: "New York, NY" },
              content: "AML KYC sanctions transaction monitoring compliance",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      )
      .persist();

    const profile = profileFor("u-resolve", ["AML Analyst"]);
    const alertMailDir = join(import.meta.dirname, "..", "email", "fixtures");
    const curatedBoardPaths = [join(import.meta.dirname, "fixtures", "catalog-northwind.json")];

    const run = await runFinderDiscovery({
      db,
      profile,
      intent: null,
      insights: null,
      net,
      alertMailDir,
      curatedBoardPaths,
    });

    // The alerted employer was resolved to its board and reported as added this pass.
    expect(run.targetsAdded).toContain("Northwind Bank");

    // The real off-platform (employer-site) posting surfaced, sourced from greenhouse — not LinkedIn —
    // and is apply-capable (the whole point: off LinkedIn, onto the company's own ATS).
    const jobs = new DiscoveredJobsRepo(db).list(profile.id, {});
    const gh = jobs.find((j) => j.title === "Senior AML Analyst" && j.atsType === "greenhouse");
    expect(gh).toBeTruthy();
    expect(gh!.jobUrl).toContain("greenhouse.io");
    expect(classifyApplyCapability(gh!.jobUrl).capability).toBe("supported_form_fill");
  });
});
