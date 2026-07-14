// src/db/applications-repo.ts
//
// Tracks applications for HARD DEDUP (never apply to the same job twice) and per-company rate
// limiting (cap applications per company per time window). Module 6/7.

import { randomUUID } from "node:crypto";
import type { DB } from "./database";

export type ApplicationStatus = "needs_review" | "submitted" | "skipped" | "challenge" | "account_required";

export interface ApplicationRecord {
  id: string;
  profileId: string;
  dedupKey: string;
  company?: string;
  title?: string;
  url?: string;
  ats?: string;
  mode?: string;
  status: ApplicationStatus;
  submitted: boolean;
  createdAt: string;
}

/** Normalize an apply URL into a stable dedup key (host + path, no query/hash). */
export function dedupKeyForUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export interface RateLimitConfig {
  perCompanyWindowMs: number; // e.g. 24h
  perCompanyMax: number; // e.g. 3
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  perCompanyWindowMs: 24 * 3600_000,
  perCompanyMax: 3,
};

export class ApplicationsRepo {
  constructor(private readonly db: DB) {}

  /**
   * Hard dedup = never SUBMIT the same job twice. Paused/incomplete attempts (account_required,
   * challenge, needs_review, skipped — all submitted:false) do NOT block a retry, so you can
   * re-run after logging in or resolving a CAPTCHA.
   */
  hasApplied(profileId: string, dedupKey: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM applications WHERE profile_id = ? AND dedup_key = ? AND submitted = 1")
      .get(profileId, dedupKey);
    return Boolean(row);
  }

  countForCompanyWithin(profileId: string, company: string, windowMs: number): number {
    const since = new Date(Date.now() - windowMs).toISOString();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM applications WHERE profile_id = ? AND lower(company) = lower(?) AND submitted = 1 AND created_at >= ?"
      )
      .get(profileId, company, since) as { n: number };
    return row.n;
  }

  /** Throws if applying would violate dedup or the per-company cap. */
  assertCanApply(
    profileId: string,
    dedupKey: string,
    company: string | undefined,
    cfg: RateLimitConfig = DEFAULT_RATE_LIMIT
  ): void {
    if (this.hasApplied(profileId, dedupKey)) {
      throw new DuplicateApplicationError(`Already SUBMITTED this job (dedup key: ${dedupKey}).`);
    }
    if (company) {
      const n = this.countForCompanyWithin(profileId, company, cfg.perCompanyWindowMs);
      if (n >= cfg.perCompanyMax) {
        throw new RateLimitedError(
          `Per-company cap reached for "${company}" (${n}/${cfg.perCompanyMax} in window).`
        );
      }
    }
  }

  /** All applications for a profile, newest first (Module 7 tracker / dashboard). */
  list(profileId: string): ApplicationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM applications WHERE profile_id = ? ORDER BY created_at DESC")
      .all(profileId) as {
      id: string;
      profile_id: string;
      dedup_key: string;
      company: string | null;
      title: string | null;
      url: string | null;
      ats: string | null;
      mode: string | null;
      status: string;
      submitted: number;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      profileId: r.profile_id,
      dedupKey: r.dedup_key,
      ...(r.company ? { company: r.company } : {}),
      ...(r.title ? { title: r.title } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.ats ? { ats: r.ats } : {}),
      ...(r.mode ? { mode: r.mode } : {}),
      status: r.status as ApplicationStatus,
      submitted: r.submitted === 1,
      createdAt: r.created_at,
    }));
  }

  record(rec: Omit<ApplicationRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): ApplicationRecord {
    const full: ApplicationRecord = {
      id: rec.id ?? randomUUID(),
      createdAt: rec.createdAt ?? new Date().toISOString(),
      ...rec,
    };
    this.db
      .prepare(
        `INSERT INTO applications (id, profile_id, dedup_key, company, title, url, ats, mode, status, submitted, created_at)
         VALUES (@id, @profile_id, @dedup_key, @company, @title, @url, @ats, @mode, @status, @submitted, @created_at)
         ON CONFLICT(profile_id, dedup_key) DO UPDATE SET
           status = excluded.status, submitted = excluded.submitted, mode = excluded.mode`
      )
      .run({
        id: full.id,
        profile_id: full.profileId,
        dedup_key: full.dedupKey,
        company: full.company ?? null,
        title: full.title ?? null,
        url: full.url ?? null,
        ats: full.ats ?? null,
        mode: full.mode ?? null,
        status: full.status,
        submitted: full.submitted ? 1 : 0,
        created_at: full.createdAt,
      });
    return full;
  }
}

export class DuplicateApplicationError extends Error {}
export class RateLimitedError extends Error {}
