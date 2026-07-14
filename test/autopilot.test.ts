import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { BrowserSession } from "../src/ats/browser";
import { runAutopilot } from "../src/orchestrator/autopilot";
import { CompaniesRepo } from "../src/db/companies-repo";
import { DiscoveredJobsRepo } from "../src/db/discovered-jobs-repo";
import { LedgerRepo } from "../src/db/ledger-repo";
import { ingestResumeBuffer } from "../src/server/ingest-runner";
import { approveAll } from "../src/ingestion/ledger-ops";
import { createBlankProfile } from "../src/profile/factory";
import type { ApplicantProfile } from "../src/types/applicant-profile";

const here = dirname(fileURLToPath(import.meta.url));
const RESUME = readFileSync(join(here, "fixtures", "sample-resume.txt"));

let server: http.Server;
let url: string;
let session: BrowserSession;
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
  dir = mkdtempSync(join(tmpdir(), "applypilot-ap-"));
  genDir = join(dir, "generated");
  resumePath = join(dir, "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4\n% test resume\n");
  session = new BrowserSession({ headed: false, userDataDir: join(dir, "p"), minActionDelayMs: 1, maxActionDelayMs: 2 });
  await session.start();
}, 90000);

afterAll(async () => {
  await session?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function cleanProfile(id: string): ApplicantProfile {
  const p = createBlankProfile(id);
  p.contact.legalFirstName = "Ahmet";
  p.contact.legalLastName = "Kaya";
  p.contact.email = "ahmet.kaya@example.com";
  p.contact.phone = "(415) 555-0188";
  p.masterResumePath = resumePath;
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  p.screening.isAtLeast18 = { value: true, source: "user", updatedAt: "" };
  p.preferences.targetRoles = ["Operations Analyst"]; // confirmed-ish target → apply gate open (Part H)
  return p;
}

async function seed(db: DB, profile: ApplicantProfile, autoSubmitApproved: boolean) {
  const companies = new CompaniesRepo(db);
  const c = companies.add("Acme", "https://job-boards.greenhouse.io/acme", "greenhouse");
  if (autoSubmitApproved) companies.setAutoSubmitApproved(c.id, true);
  // Approved ledger facts so document prep produces VERIFIED tailored docs (the master-résumé bypass
  // is refused on the automated apply path — A3).
  const ingested = await ingestResumeBuffer(db, undefined, profile, join(dir, "resumes", profile.id), {
    filename: "resume.txt",
    buffer: RESUME,
  });
  new LedgerRepo(db, undefined).save(approveAll(ingested.ledger));
  new DiscoveredJobsRepo(db).upsert(
    profile.id,
    { title: "Operations Analyst", company: "Acme", location: "New York, NY", jobUrl: url, atsType: "greenhouse", score: 0.9, rationale: "strong match", knockouts: [] },
    "scored"
  );
}

describe("autopilot loop", () => {
  it("auto mode (legacy): fills and queues — no unattended submit", async () => {
    const db = openDatabase(join(dir, "auto.sqlite"));
    const profile = cleanProfile("a");
    await seed(db, profile, true);
    const run = await runAutopilot(session, db, profile, {
      mode: "auto",
      liveSubmit: false,
      minScore: 0.5,
      generatedDir: genDir,
    });
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.action).toBe("queued");
    expect(run.wouldSubmit).toBe(0);
    expect(run.submitted).toBe(0);
    expect(new DiscoveredJobsRepo(db).list(profile.id)[0]!.status).toBe("needs_review");
    db.close();
  }, 90000);

  it("semi mode: fills and queues everything for the human", async () => {
    const db = openDatabase(join(dir, "semi.sqlite"));
    const profile = cleanProfile("b");
    await seed(db, profile, true);
    const run = await runAutopilot(session, db, profile, {
      mode: "semi_auto",
      minScore: 0.5,
      generatedDir: genDir,
    });
    expect(run.results[0]!.action).toBe("queued");
    expect(run.submitted).toBe(0);
    db.close();
  }, 90000);

  it("ignores discovered jobs that belong to another profile", async () => {
    const db = openDatabase(join(dir, "scoped.sqlite"));
    const profile = cleanProfile("active");
    await seed(db, profile, true);
    new DiscoveredJobsRepo(db).upsert(
      "other-profile",
      { title: "Other Profile Role", company: "Acme", jobUrl: `${url}/other-profile`, atsType: "greenhouse", score: 0.99, rationale: "wrong profile", knockouts: [] },
      "scored"
    );

    const run = await runAutopilot(session, db, profile, {
      mode: "semi_auto",
      minScore: 0.5,
      generatedDir: genDir,
    });
    expect(run.results.map((r) => r.title)).toEqual(["Operations Analyst"]);
    db.close();
  }, 90000);
});
