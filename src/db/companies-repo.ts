// src/db/companies-repo.ts
//
// The user's seeded list of target companies/sources to monitor.

import { randomUUID } from "node:crypto";
import type { DB } from "./database";
import type { AtsType, TargetCompany } from "../jobs/types";

interface CompanyRow {
  id: string;
  name: string;
  board_url: string;
  ats_type: string;
  enabled: number;
  auto_submit_approved: number;
  created_at: string;
}

function toCompany(r: CompanyRow): TargetCompany {
  return {
    id: r.id,
    name: r.name,
    boardUrl: r.board_url,
    atsType: r.ats_type as AtsType,
    enabled: r.enabled === 1,
    autoSubmitApproved: r.auto_submit_approved === 1,
    createdAt: r.created_at,
  };
}

export class CompaniesRepo {
  constructor(private readonly db: DB) {}

  add(name: string, boardUrl: string, atsType: AtsType): TargetCompany {
    const row: CompanyRow = {
      id: randomUUID(),
      name,
      board_url: boardUrl.replace(/\/+$/, ""),
      ats_type: atsType,
      enabled: 1,
      auto_submit_approved: 0,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO companies (id, name, board_url, ats_type, enabled, auto_submit_approved, created_at)
         VALUES (@id, @name, @board_url, @ats_type, @enabled, @auto_submit_approved, @created_at)
         ON CONFLICT(board_url) DO UPDATE SET name = excluded.name, ats_type = excluded.ats_type, enabled = 1`
      )
      .run(row);
    return this.getByBoardUrl(row.board_url)!;
  }

  getByBoardUrl(boardUrl: string): TargetCompany | undefined {
    const r = this.db
      .prepare("SELECT * FROM companies WHERE board_url = ?")
      .get(boardUrl.replace(/\/+$/, "")) as CompanyRow | undefined;
    return r ? toCompany(r) : undefined;
  }

  list(opts: { enabledOnly?: boolean } = {}): TargetCompany[] {
    const sql = opts.enabledOnly
      ? "SELECT * FROM companies WHERE enabled = 1 ORDER BY name"
      : "SELECT * FROM companies ORDER BY name";
    return (this.db.prepare(sql).all() as CompanyRow[]).map(toCompany);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM companies WHERE id = ?").run(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE companies SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  /** Per-employer pre-approval for 24/7 auto-submit (used in 4b). */
  setAutoSubmitApproved(id: string, approved: boolean): void {
    this.db.prepare("UPDATE companies SET auto_submit_approved = ? WHERE id = ?").run(approved ? 1 : 0, id);
  }
}
