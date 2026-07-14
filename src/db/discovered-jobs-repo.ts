// src/db/discovered-jobs-repo.ts
//
// Dashboard/read-model rows for postings found by discovery. The provenance tables in
// discovery-audit-repo preserve raw observations, duplicate links, filters, and scorecards; this
// table remains the compatibility surface for the dashboard/autopilot flows.

import { randomUUID } from "node:crypto";
import type { DB } from "./database";
import { dedupKeyForUrl } from "./applications-repo";
import type { AtsType, DiscoveredPosting, ScoredPosting } from "../jobs/types";
import type { JobFitScore } from "../types/job-fit";

type FitFactors = NonNullable<ScoredPosting["fitFactors"]>;

export type DiscoveredStatus =
  | "discovered"
  | "observed"
  | "parse_failed"
  | "normalized"
  | "duplicate_linked"
  | "needs_description"
  | "candidate_pool"
  | "filtered_out"
  | "scored"
  | "low_match"
  | "recommended"
  | "generated"
  | "applied"
  | "needs_review"
  // Parked: an apply attempt hit a login/account wall or a CAPTCHA and needs the user before it can
  // proceed. Distinct from generic needs_review so the "Needs you" queue can tell it apart.
  | "blocked"
  | "skipped";

/** Strategy tier the user assigns to a match (framework A/B/C targeting). Absent = unassigned. */
export type JobTier = "A" | "B" | "C";

function asTier(v: unknown): JobTier | undefined {
  return v === "A" || v === "B" || v === "C" ? v : undefined;
}

export interface DiscoveredJob {
  id: string;
  profileId: string;
  company: string;
  title: string;
  location?: string;
  jobUrl: string;
  atsType: AtsType;
  score: number;
  rationale: string;
  knockouts: string[];
  salaryMin?: number;
  salaryMax?: number;
  description?: string;
  fitFactors?: FitFactors;
  tags?: string[];
  fit?: JobFitScore;
  tier?: JobTier;
  status: DiscoveredStatus;
  dedupKey: string;
  discoveredAt: string;
}

interface JobRow {
  id: string;
  profile_id: string;
  company: string;
  title: string;
  location: string | null;
  job_url: string;
  ats_type: string;
  score: number | null;
  rationale: string | null;
  knockouts: string | null;
  salary_min: number | null;
  salary_max: number | null;
  description: string | null;
  fit_factors: string | null;
  tags: string | null;
  fit: string | null;
  tier: string | null;
  status: string;
  dedup_key: string;
  discovered_at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toJob(r: JobRow): DiscoveredJob {
  return {
    id: r.id,
    profileId: r.profile_id,
    company: r.company,
    title: r.title,
    ...(r.location ? { location: r.location } : {}),
    jobUrl: r.job_url,
    atsType: r.ats_type as AtsType,
    score: r.score ?? 0,
    rationale: r.rationale ?? "",
    knockouts: parseJson<string[]>(r.knockouts, []),
    ...(r.salary_min !== null ? { salaryMin: r.salary_min } : {}),
    ...(r.salary_max !== null ? { salaryMax: r.salary_max } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.fit_factors ? { fitFactors: parseJson<FitFactors | undefined>(r.fit_factors, undefined) } : {}),
    tags: parseJson<string[]>(r.tags, []),
    ...(r.fit ? { fit: parseJson<JobFitScore | undefined>(r.fit, undefined) } : {}),
    ...(asTier(r.tier) ? { tier: asTier(r.tier)! } : {}),
    status: r.status as DiscoveredStatus,
    dedupKey: r.dedup_key,
    discoveredAt: r.discovered_at,
  };
}

export class DiscoveredJobsRepo {
  constructor(private readonly db: DB) {}

  exists(profileId: string, jobUrl: string): boolean {
    return this.findByUrl(profileId, jobUrl) !== null;
  }

  findByUrl(profileId: string, jobUrl: string): DiscoveredJob | null {
    const key = dedupKeyForUrl(jobUrl);
    const row = this.db
      .prepare("SELECT * FROM discovered_jobs WHERE profile_id = ? AND dedup_key = ?")
      .get(profileId, key) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  /**
   * Store the fact that discovery saw a posting before any hard filters or scoring run. Existing
   * rows keep their status, score, tier, and application state; only fresh source fields are updated.
   */
  observe(profileId: string, p: DiscoveredPosting, status: DiscoveredStatus = "discovered"): { job: DiscoveredJob; isNew: boolean } {
    const dedupKey = dedupKeyForUrl(p.jobUrl);
    const existing = this.db
      .prepare("SELECT * FROM discovered_jobs WHERE profile_id = ? AND dedup_key = ?")
      .get(profileId, dedupKey) as JobRow | undefined;

    const row: JobRow = {
      id: existing?.id ?? randomUUID(),
      profile_id: profileId,
      company: p.company,
      title: p.title,
      location: p.location ?? existing?.location ?? null,
      job_url: p.jobUrl,
      ats_type: p.atsType,
      score: existing?.score ?? 0,
      rationale: existing?.rationale ?? "Observed before filtering/scoring.",
      knockouts: existing?.knockouts ?? "[]",
      salary_min: existing?.salary_min ?? null,
      salary_max: existing?.salary_max ?? null,
      description: existing?.description ?? null,
      fit_factors: existing?.fit_factors ?? null,
      tags: existing?.tags ?? null,
      fit: existing?.fit ?? null,
      tier: existing?.tier ?? null,
      status: existing?.status ?? status,
      dedup_key: dedupKey,
      discovered_at: existing?.discovered_at ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO discovered_jobs (id, profile_id, company, title, location, job_url, ats_type, score, rationale, knockouts, salary_min, salary_max, description, fit_factors, tags, fit, tier, status, dedup_key, discovered_at)
         VALUES (@id, @profile_id, @company, @title, @location, @job_url, @ats_type, @score, @rationale, @knockouts, @salary_min, @salary_max, @description, @fit_factors, @tags, @fit, @tier, @status, @dedup_key, @discovered_at)
         ON CONFLICT(profile_id, dedup_key) DO UPDATE SET
           company = excluded.company, title = excluded.title, location = excluded.location,
           job_url = excluded.job_url, ats_type = excluded.ats_type`
      )
      .run(row);
    return { job: toJob(row), isNew: !existing };
  }

  /** Insert (or refresh score/status of) a scored posting. Returns false if it was a dup-update. */
  upsert(profileId: string, p: ScoredPosting, status: DiscoveredStatus): { job: DiscoveredJob; isNew: boolean } {
    const dedupKey = dedupKeyForUrl(p.jobUrl);
    const existing = this.db
      .prepare("SELECT * FROM discovered_jobs WHERE profile_id = ? AND dedup_key = ?")
      .get(profileId, dedupKey) as JobRow | undefined;

    const row: JobRow = {
      id: existing?.id ?? randomUUID(),
      profile_id: profileId,
      company: p.company,
      title: p.title,
      location: p.location ?? null,
      job_url: p.jobUrl,
      ats_type: p.atsType,
      score: p.score,
      rationale: p.rationale,
      knockouts: JSON.stringify(p.knockouts),
      salary_min: p.salaryMin ?? existing?.salary_min ?? null,
      salary_max: p.salaryMax ?? existing?.salary_max ?? null,
      description: p.description ?? existing?.description ?? null,
      fit_factors: p.fitFactors ? JSON.stringify(p.fitFactors) : existing?.fit_factors ?? null,
      tags: p.tags ? JSON.stringify(p.tags) : existing?.tags ?? null,
      fit: p.fit ? JSON.stringify(p.fit) : existing?.fit ?? null,
      // Tier is a USER assignment, never derived from discovery; preserve it across re-scans.
      tier: existing?.tier ?? null,
      status,
      dedup_key: dedupKey,
      discovered_at: existing?.discovered_at ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO discovered_jobs (id, profile_id, company, title, location, job_url, ats_type, score, rationale, knockouts, salary_min, salary_max, description, fit_factors, tags, fit, tier, status, dedup_key, discovered_at)
         VALUES (@id, @profile_id, @company, @title, @location, @job_url, @ats_type, @score, @rationale, @knockouts, @salary_min, @salary_max, @description, @fit_factors, @tags, @fit, @tier, @status, @dedup_key, @discovered_at)
         ON CONFLICT(profile_id, dedup_key) DO UPDATE SET
           score = excluded.score, rationale = excluded.rationale, knockouts = excluded.knockouts,
           salary_min = excluded.salary_min, salary_max = excluded.salary_max,
           description = excluded.description, fit_factors = excluded.fit_factors, tags = excluded.tags,
           fit = excluded.fit, status = excluded.status, title = excluded.title, location = excluded.location`
      )
      .run(row);
    return { job: toJob(row), isNew: !existing };
  }

  list(profileId: string, opts: { status?: DiscoveredStatus; minScore?: number } = {}): DiscoveredJob[] {
    const where = ["profile_id = ?"];
    const params: unknown[] = [profileId];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.minScore !== undefined) {
      where.push("COALESCE(score, 0) >= ?");
      params.push(opts.minScore);
    }
    const rows = this.db
      .prepare(`SELECT * FROM discovered_jobs WHERE ${where.join(" AND ")} ORDER BY score DESC, discovered_at DESC`)
      .all(...params) as JobRow[];
    return rows.map(toJob);
  }

  setStatus(profileId: string, id: string, status: DiscoveredStatus): boolean {
    const r = this.db.prepare("UPDATE discovered_jobs SET status = ? WHERE profile_id = ? AND id = ?").run(status, profileId, id);
    return r.changes > 0;
  }

  /** Assign or clear the strategy tier (A/B/C, or null to unassign). */
  setTier(profileId: string, id: string, tier: JobTier | null): boolean {
    const r = this.db.prepare("UPDATE discovered_jobs SET tier = ? WHERE profile_id = ? AND id = ?").run(tier, profileId, id);
    return r.changes > 0;
  }

  /** Persist the posting's publish date (freshness), when the board exposes one. */
  setPostedAt(id: string, postedAt: string): void {
    this.db.prepare("UPDATE discovered_jobs SET posted_at = ? WHERE id = ?").run(postedAt, id);
  }

  /** Overwrite score + rationale (e.g. after an LLM rerank pass). */
  updateScore(id: string, score: number, rationale: string): void {
    this.db.prepare("UPDATE discovered_jobs SET score = ?, rationale = ? WHERE id = ?").run(score, rationale, id);
  }

  /** Persist a refined job-fit assessment (score mirrors fit.overallScore/100), e.g. after LLM reasoning. */
  updateFit(id: string, fit: JobFitScore): void {
    this.db
      .prepare("UPDATE discovered_jobs SET fit = ?, score = ?, rationale = ?, knockouts = ? WHERE id = ?")
      .run(JSON.stringify(fit), fit.overallScore / 100, fit.reasoningSummary, JSON.stringify(fit.hardBlockers), id);
  }
}
