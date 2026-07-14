// src/cli/seed-demo.ts
//
// `npm run seed:demo` — populates the LOCAL datastore with representative engine data (profile,
// ledger, target companies, discovered jobs, a few applications, audit entries) so the dashboard
// has real content to render. Safe + local; submits nothing. Real usage comes from
// setup/ingest/companies/discover instead.

import { loadConfig } from "../config";
import { getDatabase, closeDatabase, recordAudit } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { CompaniesRepo } from "../db/companies-repo";
import { DiscoveredJobsRepo } from "../db/discovered-jobs-repo";
import { ApplicationsRepo, dedupKeyForUrl } from "../db/applications-repo";
import { createBlankProfile } from "../profile/factory";
import { buildLedger } from "../ingestion/ledger-ops";
import { normalizeBoard } from "../jobs/board-detect";
import type { ScoredPosting } from "../jobs/types";

const PROFILE_ID = "demo";

function main(): void {
  const force = process.argv.slice(2).includes("--force");
  const cfg = loadConfig();
  if (!cfg.demoMode && !force) {
    process.stderr.write(
      "Refusing to seed demo data into a live datastore.\n" +
        "Set APPLYPILOT_DEMO_MODE=on or rerun with `npm run seed:demo -- --force`.\n"
    );
    process.exitCode = 1;
    return;
  }
  const db = getDatabase(cfg.dbPath);

  // --- Profile ---
  const p = createBlankProfile(PROFILE_ID);
  p.contact.legalFirstName = "Ahmet";
  p.contact.legalLastName = "Kaya";
  p.contact.email = "ahmet.kaya@example.com";
  p.contact.phone = "(415) 555-0188";
  p.contact.address.city = "New York";
  p.contact.address.state = "NY";
  p.contact.links.linkedin = "https://linkedin.com/in/ahmetkaya";
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: new Date().toISOString() };
  p.workAuthorization.requiresSponsorshipNowOrFuture = { value: false, source: "user", updatedAt: new Date().toISOString() };
  p.preferences.willingToRelocate = { value: false, source: "user", updatedAt: new Date().toISOString() };
  p.preferences.desiredLocations = ["Remote US", "New York, NY"];
  p.preferences.compensation.desiredBaseMin = 160000;
  p.masterResumePath = "/Users/ahmet/resume.pdf";
  new ProfileRepo(db, cfg.encryptionKey).save(p);

  // --- Ledger (approved facts) ---
  new LedgerRepo(db, cfg.encryptionKey).save(
    buildLedger(PROFILE_ID, [
      { id: "e1", type: "employment", approved: true, title: "Senior Product Manager", employer: "Northwind", startDate: "2021", endDate: "present", bullets: ["Led AI-assisted workflow launches that improved qualified activation by 28%."] },
      { id: "e2", type: "employment", approved: true, title: "Product Manager", employer: "Contoso", startDate: "2018", endDate: "2021", bullets: ["Shipped automation features across marketplace teams."] },
      { id: "s1", type: "skill", approved: true, statement: "Product strategy" },
      { id: "s2", type: "skill", approved: true, statement: "AI workflow" },
      { id: "s3", type: "skill", approved: true, statement: "SQL" },
    ])
  );

  // --- Target companies (employer ATS boards only) ---
  const companiesRepo = new CompaniesRepo(db);
  const boards: { url: string; name: string; approve?: boolean }[] = [
    { url: "https://jobs.ashbyhq.com/1password", name: "1Password", approve: true },
    { url: "https://jobs.ashbyhq.com/ramp", name: "Ramp" },
    { url: "https://jobs.lever.co/gohighlevel", name: "HighLevel" },
    { url: "https://job-boards.greenhouse.io/nationalpublicradioinc", name: "NPR" },
    { url: "https://job-boards.greenhouse.io/acmestaffing", name: "Acme Staffing" },
  ];
  for (const b of boards) {
    const n = normalizeBoard(b.url)!;
    const c = companiesRepo.add(b.name, n.boardUrl, n.atsType);
    if (b.approve) companiesRepo.setAutoSubmitApproved(c.id, true);
    if (b.name === "Acme Staffing") companiesRepo.setEnabled(c.id, false); // shows as a "blocked" source
  }

  // --- Discovered jobs ---
  const jobsRepo = new DiscoveredJobsRepo(db);
  const jobs: { p: ScoredPosting; status: "scored" | "applied" }[] = [
    { p: { title: "Staff Product Manager, AI", company: "1Password", location: "Remote US", jobUrl: "https://jobs.ashbyhq.com/1password/aaa", atsType: "ashby", score: 0.94, rationale: "title matches a target role | matches skills: product, ai", knockouts: [], salaryMin: 185000, salaryMax: 220000, description: "Lead product strategy for AI-assisted security workflows across a remote-first product organization.", fitFactors: { skills: 96, salary: 100, location: 100, seniority: 92, culture: 88 }, tags: ["Product", "AI", "Remote"] }, status: "applied" },
    { p: { title: "Senior PM, Automation", company: "1Password", location: "New York, NY", jobUrl: "https://jobs.ashbyhq.com/1password/bbb", atsType: "ashby", score: 0.9, rationale: "matches skills: automation, product", knockouts: [], salaryMin: 170000, salaryMax: 205000, description: "Own automation roadmap and coordinate launches across product, design, and go-to-market partners.", fitFactors: { skills: 92, salary: 96, location: 94, seniority: 90, culture: 86 }, tags: ["Automation", "Product", "NYC"] }, status: "scored" },
    { p: { title: "Product Lead, Payments", company: "Ramp", location: "New York, NY", jobUrl: "https://jobs.ashbyhq.com/ramp/ccc", atsType: "ashby", score: 0.88, rationale: "title matches a target role", knockouts: [], salaryMin: 165000, salaryMax: 200000, description: "Lead a payments product surface for high-growth finance teams, balancing discovery, analytics, and delivery.", fitFactors: { skills: 88, salary: 92, location: 94, seniority: 89, culture: 84 }, tags: ["Product", "Fintech", "NYC"] }, status: "scored" },
    { p: { title: "Growth PM", company: "Ramp", location: "Ontario, Canada", jobUrl: "https://jobs.ashbyhq.com/ramp/ddd", atsType: "ashby", score: 0.12, rationale: "KNOCKOUT: non-US location", knockouts: ["non-US location"], description: "Growth PM role based in Ontario.", fitFactors: { skills: 70, salary: 76, location: 20, seniority: 74, culture: 62 }, tags: ["Growth"] }, status: "scored" },
    { p: { title: "Product Manager, AI Tools", company: "HighLevel", location: "Remote US", jobUrl: "https://jobs.lever.co/gohighlevel/eee", atsType: "lever", score: 0.85, rationale: "matches skills: ai, product", knockouts: [], salaryMin: 162000, salaryMax: 190000, description: "Build AI productivity tools for operators and customer-facing teams in a remote-first environment.", fitFactors: { skills: 89, salary: 88, location: 100, seniority: 84, culture: 86 }, tags: ["AI Tools", "SaaS", "Remote"] }, status: "applied" },
    { p: { title: "Product Operations Lead", company: "NPR", location: "Washington, DC", jobUrl: "https://job-boards.greenhouse.io/nationalpublicradioinc/123", atsType: "greenhouse", score: 0.73, rationale: "matches skills: product", knockouts: [], salaryMin: 140000, salaryMax: 168000, description: "Coordinate product operations across editorial, audience, and platform teams.", fitFactors: { skills: 78, salary: 72, location: 82, seniority: 80, culture: 79 }, tags: ["Operations", "Media", "Product"] }, status: "scored" },
  ];
  for (const j of jobs) jobsRepo.upsert(PROFILE_ID, j.p, j.status);

  // --- Applications (a couple submitted, one paused at the review gate) ---
  const appsRepo = new ApplicationsRepo(db);
  const apps = [
    { url: "https://jobs.ashbyhq.com/1password/aaa", company: "1Password", title: "Staff Product Manager, AI", ats: "ashby", status: "submitted" as const, submitted: true },
    { url: "https://jobs.lever.co/gohighlevel/eee", company: "HighLevel", title: "Product Manager, AI Tools", ats: "lever", status: "submitted" as const, submitted: true },
    { url: "https://jobs.ashbyhq.com/ramp/ccc", company: "Ramp", title: "Product Lead, Payments", ats: "ashby", status: "needs_review" as const, submitted: false },
  ];
  for (const a of apps) {
    appsRepo.record({ profileId: PROFILE_ID, dedupKey: dedupKeyForUrl(a.url), company: a.company, title: a.title, url: a.url, ats: a.ats, mode: "semi_auto", status: a.status, submitted: a.submitted });
  }

  // --- Audit log ---
  recordAudit(db, PROFILE_ID, "resume.ingest", { approved: 5 });
  recordAudit(db, PROFILE_ID, "discovery.run", { companies: 4, found: 6, added: 6 });
  recordAudit(db, PROFILE_ID, "documents.generate", { company: "1Password", title: "Staff Product Manager, AI" });
  recordAudit(db, PROFILE_ID, "application.fill", { company: "Ramp", ats: "ashby" });
  recordAudit(db, PROFILE_ID, "application.challenge", { ats: "greenhouse" });

  closeDatabase();
  process.stdout.write(`Seeded demo data into ${cfg.dbPath}\n`);
}

main();
