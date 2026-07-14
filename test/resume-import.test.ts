import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { LedgerRepo } from "../src/db/ledger-repo";
import { ProfileRepo } from "../src/db/profile-repo";
import { mapResumeDataToAppFields } from "../src/ingestion/resume-mapper";
import { startApiServer } from "../src/server/api";
import { EMPTY_FORM, profileToForm } from "../src/server/profile-form";
import { structuredResumeToFacts, type ParsedResumeData } from "../src/ingestion/structured-resume";
import type { EmploymentFact } from "../src/types/facts-ledger";

const here = dirname(fileURLToPath(import.meta.url));
const RESUME = readFileSync(join(here, "fixtures", "sample-resume.txt"), "utf8");

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("mapResumeDataToAppFields", () => {
  it("fills blank app fields, preserves existing values, and reports conflicts/missing fields", () => {
    const parsed: ParsedResumeData = {
      personal_information: {
        full_name: "Jane Q. Applicant",
        email: "jane.resume@example.com",
        phone: "(415) 555-0137",
        location: "San Francisco, CA",
        linkedin: "linkedin.com/in/jane",
        github: "github.com/jane",
        portfolio: "jane.dev",
        other_links: [],
      },
      professional_summary: "Operations analyst with logistics automation experience.",
      work_experience: [
        {
          job_title: "Senior Operations Analyst",
          company: "Northwind",
          location: "San Francisco, CA",
          start_date: "2021",
          end_date: "",
          is_current: true,
          responsibilities: [],
          achievements: ["Improved fulfillment SLA by 22%"],
          technologies_or_tools: ["SQL"],
        },
      ],
      education: [],
      skills: { technical_skills: ["SQL"], soft_skills: [], tools: [], programming_languages: [], frameworks: [], platforms: [], industry_skills: [] },
      certifications: [],
      projects: [],
      awards: [],
      publications: [],
      languages: [],
      volunteer_experience: [],
      missing_or_uncertain_information: ["Work authorization was not listed."],
    };

    const existing = { ...EMPTY_FORM, email: "saved@example.com", isNegotiable: true };
    const out = mapResumeDataToAppFields(parsed, { existingForm: existing });
    expect(out.mappedData.legalFirstName).toBe("Jane");
    expect(out.mappedData.preferredName).toBe("Q.");
    expect(out.mappedData.email).toBe("saved@example.com");
    expect(out.mappedData.linkedin).toBe("https://linkedin.com/in/jane");
    expect(out.mappedData.targetRoles).toContain("Senior Operations Analyst");
    expect(out.uncertainFields.some((f) => f.field === "email")).toBe(true);
    expect(out.uncertainFields.some((f) => /Work authorization/.test(f.message))).toBe(true);
    expect(out.missingFields.some((f) => f.field === "authorizedToWorkInUS")).toBe(true);
    expect(out.validationErrors).toHaveLength(0);
  });
});

describe("structuredResumeToFacts", () => {
  it("does not duplicate structured work achievements as standalone achievement facts", () => {
    const parsed: ParsedResumeData = {
      personal_information: {
        full_name: "",
        email: "",
        phone: "",
        location: "",
        linkedin: "",
        github: "",
        portfolio: "",
        other_links: [],
      },
      professional_summary: "",
      work_experience: [
        {
          job_title: "Senior Operations Analyst",
          company: "Northwind Logistics",
          location: "",
          start_date: "2021",
          end_date: "",
          is_current: true,
          responsibilities: [],
          achievements: ["Reviewed 120 claims per week, reducing backlog by 35%."],
          technologies_or_tools: [],
        },
      ],
      education: [],
      skills: {
        technical_skills: [],
        soft_skills: [],
        tools: [],
        programming_languages: [],
        frameworks: [],
        platforms: [],
        industry_skills: [],
      },
      certifications: [],
      projects: [],
      awards: [],
      publications: [],
      languages: [],
      volunteer_experience: [],
      missing_or_uncertain_information: [],
    };

    const facts = structuredResumeToFacts(parsed);
    const employment = facts.filter((f): f is EmploymentFact => f.type === "employment");
    const achievements = facts.filter((f) => f.type === "achievement");

    expect(employment).toHaveLength(1);
    expect(employment[0]!.bullets).toEqual([
      "Reviewed 120 claims per week, reducing backlog by 35%.",
    ]);
    expect(achievements).toHaveLength(0);
  });
});

describe("/api/resume/preview + /api/resume/import", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-resume-import-"));
    db = openDatabase(join(dir, "p.sqlite"));
    server = startApiServer(0, { db, envPath: join(dir, ".env"), resumesDir: join(dir, "resumes") });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("previews without saving, then imports reviewed profile data and unapproved facts", async () => {
    const preview = await fetch(`${base}/api/resume/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: RESUME, filename: "resume.txt", preferLlm: false }),
    });
    expect(preview.status).toBe(200);
    const body = await preview.json() as {
      previewId: string;
      form: ReturnType<typeof profileToForm>;
      facts: { id: string; approved: boolean }[];
      summary: { total: number; approved: number };
    };
    expect(body.previewId).toBeTruthy();
    expect(body.form.legalFirstName).toBe("Jane");
    expect(body.form.email).toBe("jane.applicant@example.com");
    expect(body.summary.total).toBeGreaterThan(2);
    expect(body.summary.approved).toBe(0);
    expect(new ProfileRepo(db, undefined).getFirst()).toBeUndefined();

    const selected = body.facts.slice(0, 2).map((f) => f.id);
    const imported = await fetch(`${base}/api/resume/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previewId: body.previewId, mappedData: body.form, includedFactIds: selected }),
    });
    expect(imported.status).toBe(200);
    const importedBody = await imported.json() as { facts: { approved: boolean }[]; summary: { total: number; approved: number } };
    expect(importedBody.summary.total).toBe(2);
    expect(importedBody.summary.approved).toBe(0);
    expect(importedBody.facts.every((f) => f.approved === false)).toBe(true);

    const saved = new ProfileRepo(db, undefined).getFirst();
    expect(saved?.contact.legalFirstName).toBe("Jane");
    expect(saved?.masterResumePath).toBeTruthy();
    const ledger = new LedgerRepo(db, undefined).get(saved!.id);
    expect(ledger?.facts).toHaveLength(2);
  });
});
