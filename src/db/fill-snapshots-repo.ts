// src/db/fill-snapshots-repo.ts
//
// Stores the redacted form-fill snapshot per (profile, job) so the Applications tab can show the real
// field-by-field application. Sensitive values are already redacted by buildRedactedSnapshot before
// they reach this repo (see src/server/fill-snapshot.ts). One row per job (dedup_key); latest wins,
// and once a job is submitted the submitted flag stays set.

import { randomUUID } from "node:crypto";
import type { DB } from "./database";
import type { RedactedFillSnapshot } from "../server/fill-snapshot";

export interface FillSnapshotRecord {
  id: string;
  profileId: string;
  dedupKey: string;
  company: string | null;
  title: string | null;
  url: string | null;
  ats: string | null;
  submitted: boolean;
  snapshot: RedactedFillSnapshot;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  profile_id: string;
  dedup_key: string;
  company: string | null;
  title: string | null;
  url: string | null;
  ats: string | null;
  submitted: number;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
}

export class FillSnapshotsRepo {
  constructor(private readonly db: DB) {}

  upsert(input: {
    profileId: string;
    dedupKey: string;
    company?: string | null;
    title?: string | null;
    url?: string | null;
    ats?: string | null;
    submitted: boolean;
    snapshot: RedactedFillSnapshot;
  }): FillSnapshotRecord {
    const now = new Date().toISOString();
    const existing = this.get(input.profileId, input.dedupKey);
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? now;
    this.db
      .prepare(
        `INSERT INTO fill_snapshots
          (id, profile_id, dedup_key, company, title, url, ats, submitted, snapshot_json, created_at, updated_at)
         VALUES (@id, @profile_id, @dedup_key, @company, @title, @url, @ats, @submitted, @snapshot_json, @created_at, @updated_at)
         ON CONFLICT(profile_id, dedup_key) DO UPDATE SET
           company = excluded.company,
           title = excluded.title,
           url = excluded.url,
           ats = excluded.ats,
           submitted = MAX(fill_snapshots.submitted, excluded.submitted),
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`
      )
      .run({
        id,
        profile_id: input.profileId,
        dedup_key: input.dedupKey,
        company: input.company ?? null,
        title: input.title ?? null,
        url: input.url ?? null,
        ats: input.ats ?? null,
        submitted: input.submitted ? 1 : 0,
        snapshot_json: JSON.stringify(input.snapshot),
        created_at: createdAt,
        updated_at: now,
      });
    return this.get(input.profileId, input.dedupKey)!;
  }

  get(profileId: string, dedupKey: string): FillSnapshotRecord | null {
    const row = this.db
      .prepare("SELECT * FROM fill_snapshots WHERE profile_id = ? AND dedup_key = ?")
      .get(profileId, dedupKey) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  list(profileId: string): FillSnapshotRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM fill_snapshots WHERE profile_id = ? ORDER BY updated_at DESC")
      .all(profileId) as Row[];
    return rows.map(toRecord);
  }
}

function toRecord(row: Row): FillSnapshotRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    dedupKey: row.dedup_key,
    company: row.company,
    title: row.title,
    url: row.url,
    ats: row.ats,
    submitted: row.submitted === 1,
    snapshot: parseSnapshot(row.snapshot_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSnapshot(raw: string): RedactedFillSnapshot {
  return JSON.parse(raw) as RedactedFillSnapshot;
}
