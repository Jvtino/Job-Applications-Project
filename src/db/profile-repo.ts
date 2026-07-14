// src/db/profile-repo.ts
//
// Persistence for the Module 1 ApplicantProfile. Validates on the way in AND out with the
// Zod schema (which is compile-time pinned to the canonical type), so a corrupt or stale
// row can never masquerade as a valid profile.

import type { DB } from "./database";
import { recordAudit } from "./database";
import { deserializeFromStorage, serializeForStorage } from "./crypto";
import { applicantProfileSchema } from "../validation/applicant-profile.schema";
import type { ApplicantProfile } from "../types/applicant-profile";
import { createBlankProfile } from "../profile/factory";

interface ProfileRow {
  id: string;
  schema_version: number;
  data: Buffer;
  enc: number;
  created_at: string;
  updated_at: string;
}

export class ProfileRepo {
  constructor(
    private readonly db: DB,
    private readonly encryptionKey: Buffer | undefined
  ) {}

  save(profile: ApplicantProfile): ApplicantProfile {
    const validated = applicantProfileSchema.parse(profile);
    const stamped: ApplicantProfile = {
      ...validated,
      updatedAt: new Date().toISOString(),
    };
    const { data, enc } = serializeForStorage(stamped, this.encryptionKey);
    this.db
      .prepare(
        `INSERT INTO profiles (id, schema_version, data, enc, created_at, updated_at)
         VALUES (@id, @schema_version, @data, @enc, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           schema_version = excluded.schema_version,
           data           = excluded.data,
           enc            = excluded.enc,
           updated_at     = excluded.updated_at`
      )
      .run({
        id: stamped.id,
        schema_version: stamped.schemaVersion,
        data,
        enc,
        created_at: stamped.createdAt,
        updated_at: stamped.updatedAt,
      });
    recordAudit(this.db, stamped.id, "profile.save", { schemaVersion: stamped.schemaVersion });
    return stamped;
  }

  get(id: string): ApplicantProfile | undefined {
    const row = this.db
      .prepare("SELECT * FROM profiles WHERE id = ?")
      .get(id) as ProfileRow | undefined;
    if (!row) return undefined;
    return this.decodeRow(row);
  }

  /** Convenience for the single-user case: the first (and usually only) profile. */
  getFirst(): ApplicantProfile | undefined {
    const row = this.db
      .prepare("SELECT * FROM profiles ORDER BY created_at ASC LIMIT 1")
      .get() as ProfileRow | undefined;
    if (!row) return undefined;
    return this.decodeRow(row);
  }

  list(): ApplicantProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM profiles ORDER BY created_at ASC")
      .all() as ProfileRow[];
    return rows.map((r) => this.decodeRow(r));
  }

  /**
   * Wipe all applicant data for a clean start: profile, ledger, discovered jobs, applications,
   * accounts, embeddings, résumé insights, and audit entries. Returns a fresh blank profile.
   */
  resetAll(): ApplicantProfile {
    const profileIds = this.db
      .prepare("SELECT id FROM profiles")
      .all() as { id: string }[];
    const wipe = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.db.prepare("DELETE FROM applications WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM accounts WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM user_feedback WHERE job_id IN (SELECT job_id FROM normalized_jobs WHERE profile_id = ?)").run(id);
        this.db.prepare("DELETE FROM rerank_decisions WHERE job_id IN (SELECT job_id FROM normalized_jobs WHERE profile_id = ?)").run(id);
        this.db.prepare("DELETE FROM scorecards WHERE job_id IN (SELECT job_id FROM normalized_jobs WHERE profile_id = ?)").run(id);
        this.db.prepare("DELETE FROM filter_decisions WHERE job_id IN (SELECT job_id FROM normalized_jobs WHERE profile_id = ?)").run(id);
        this.db.prepare("DELETE FROM dedupe_groups WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM job_observation_links WHERE trace_id IN (SELECT trace_id FROM discovery_runs WHERE profile_id = ?)").run(id);
        this.db.prepare("DELETE FROM normalized_jobs_fts WHERE job_id IN (SELECT job_id FROM normalized_jobs WHERE profile_id = ?)").run(id);
        this.db.prepare("DELETE FROM normalized_jobs WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM raw_job_observations WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM source_queries WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM discovery_runs WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM automation_progress WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM discovered_jobs WHERE profile_id = ?").run(id);
        this.db.prepare("DELETE FROM audit_log WHERE profile_id = ?").run(id);
      }
      this.db.prepare("DELETE FROM profiles").run();
    });
    wipe(profileIds.map((r) => r.id));
    const blank = createBlankProfile();
    const saved = this.save(blank);
    recordAudit(this.db, saved.id, "profile.reset", { previousProfileCount: profileIds.length });
    return saved;
  }

  private decodeRow(row: ProfileRow): ApplicantProfile {
    const raw = deserializeFromStorage<unknown>(
      row.data,
      row.enc === 1 ? 1 : 0,
      this.encryptionKey
    );
    return applicantProfileSchema.parse(raw);
  }
}
