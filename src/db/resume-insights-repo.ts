// src/db/resume-insights-repo.ts
//
// Storage for DERIVED résumé insights (matching-only inference). Separate from the ledger and the
// profile. Stored as JSON text in the local SQLite DB.

import type { DB } from "./database";
import type { ResumeInsights } from "../types/resume-insights";

export class ResumeInsightsRepo {
  constructor(private readonly db: DB) {}

  get(profileId: string): ResumeInsights | null {
    const row = this.db
      .prepare("SELECT data FROM resume_insights WHERE profile_id = ?")
      .get(profileId) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as ResumeInsights;
    } catch {
      return null;
    }
  }

  set(profileId: string, insights: ResumeInsights): void {
    this.db
      .prepare(
        `INSERT INTO resume_insights (profile_id, data, updated_at)
         VALUES (@profile_id, @data, @updated_at)
         ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run({
        profile_id: profileId,
        data: JSON.stringify(insights),
        updated_at: new Date().toISOString(),
      });
  }
}
