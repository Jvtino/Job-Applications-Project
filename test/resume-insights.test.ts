import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { computeResumeInsights } from "../src/ingestion/resume-insights";
import { ResumeInsightsRepo } from "../src/db/resume-insights-repo";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { createBlankProfile } from "../src/profile/factory";
import { buildLedger } from "../src/ingestion/ledger-ops";

const facts = buildLedger("ri", [
  {
    id: "e1",
    type: "employment",
    approved: true,
    title: "Senior Data Engineer",
    employer: "Acme",
    startDate: "2017",
    endDate: "present",
    bullets: ["Built Spark ETL pipelines on AWS", "Owned the analytics warehouse"],
  },
  {
    id: "e2",
    type: "employment",
    approved: true,
    title: "Data Analyst",
    employer: "Globex",
    startDate: "2014",
    endDate: "2017",
    bullets: ["SQL reporting"],
  },
  { id: "s1", type: "skill", approved: true, statement: "Python" },
  { id: "s2", type: "skill", approved: true, statement: "SQL" },
  { id: "s3", type: "skill", approved: true, statement: "Spark" },
]).facts;

describe("computeResumeInsights", () => {
  const insights = computeResumeInsights(facts);

  it("computes total years of experience from merged employment intervals", () => {
    // 2014 -> current year (contiguous roles)
    expect(insights.totalYearsExperience).toBeGreaterThanOrEqual(9);
  });

  it("does not double-count overlapping employment spans", () => {
    const gapFacts = buildLedger("gap", [
      { id: "e1", type: "employment", approved: true, title: "Engineer", employer: "A", startDate: "2014", endDate: "2017", bullets: [] },
      { id: "e2", type: "employment", approved: true, title: "Engineer", employer: "B", startDate: "2020", endDate: "present", bullets: [] },
    ]).facts;
    const gapInsights = computeResumeInsights(gapFacts);
    const nowYear = new Date().getFullYear();
    expect(gapInsights.totalYearsExperience).toBeLessThanOrEqual(nowYear - 2014);
    expect(gapInsights.totalYearsExperience).toBeGreaterThanOrEqual((2017 - 2014) + (nowYear - 2020) - 1);
  });

  it("derives seniority from the highest title", () => {
    expect(insights.seniorityLevel).toBeGreaterThanOrEqual(3); // senior
    expect(insights.seniorityLabel).toMatch(/senior|staff/i);
  });

  it("infers the data domain and ranks skills", () => {
    expect(insights.domains).toContain("data");
    const names = insights.skills.map((s) => s.name);
    expect(names).toContain("sql");
    expect(names).toContain("python");
    // Explicit skill facts outweigh incidental bullet tokens.
    expect(insights.skills[0]!.mentions).toBeGreaterThanOrEqual(3);
  });

  it("lists distinct titles, most recent first", () => {
    expect(insights.topTitles[0]).toBe("Senior Data Engineer");
    expect(insights.method).toBe("deterministic");
  });
});

describe("ResumeInsightsRepo", () => {
  let dir: string;
  let db: DB;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-ri-"));
    db = openDatabase(join(dir, "ri.sqlite"));
    new ProfileRepo(db, undefined).save(createBlankProfile("ri"));
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and reloads insights as JSON", () => {
    const repo = new ResumeInsightsRepo(db);
    expect(repo.get("ri")).toBeNull();
    repo.set("ri", computeResumeInsights(facts));
    const got = repo.get("ri")!;
    expect(got.domains).toContain("data");
    expect(got.totalYearsExperience).toBeGreaterThanOrEqual(9);
  });
});
