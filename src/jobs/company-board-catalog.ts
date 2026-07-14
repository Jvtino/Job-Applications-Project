// src/jobs/company-board-catalog.ts
//
// Loads the hand-maintained curated employer boards (config/targets*.json) into a
// normalized company-name index, and mints the canonical board URL for each vendor.
//
// COMPLIANCE (max): `boardUrlFor` is the ONLY place a company name → employer-ATS board
// URL is produced, and its vendor switch is structurally incapable of yielding a
// LinkedIn/Indeed/Glassdoor host. Those hosts are hard-denied in NetGuard before any
// allowlist (src/finder/net/hosts.ts), so even a mistake here could not reach them — this
// module simply guarantees a name never even resolves to an aggregator URL in the first
// place.

import { readFileSync } from "node:fs";
import type { AtsType } from "./types";
import { normalizeCompany } from "../finder/normalization";

export interface CuratedBoard {
  name: string;
  vendor: AtsType;
  boardId: string;
}

/** Vendors that have a finder connector AND a well-known public board URL shape. */
const VENDOR_BOARD_URL: Partial<Record<AtsType, (id: string) => string>> = {
  greenhouse: (id) => `https://boards.greenhouse.io/${id}`,
  lever: (id) => `https://jobs.lever.co/${id}`,
  ashby: (id) => `https://jobs.ashbyhq.com/${id}`,
  smartrecruiters: (id) => `https://jobs.smartrecruiters.com/${id}`,
  workable: (id) => `https://apply.workable.com/${id}`,
};

/**
 * Canonical board URL for a curated entry, or null for an unsupported vendor / bad shape.
 * Workday's boardId is ALREADY a full myworkdayjobs.com URL (a bare slug can't address a
 * Workday tenant), so it is returned as-is.
 *
 * COMPLIANCE: every branch yields an employer-ATS host (greenhouse/lever/ashby/…); there is
 * no branch that can produce linkedin/indeed/glassdoor.
 */
export function boardUrlFor(vendor: AtsType, boardId: string): string | null {
  const id = boardId.trim();
  if (!id) return null;
  if (vendor === "workday") {
    // Validate the HOST is a Workday tenant (not just that the string contains the domain), so a
    // stray value can't slip through. NetGuard re-checks the host on fetch regardless.
    try {
      const host = new URL(/^https?:\/\//i.test(id) ? id : `https://${id}`).hostname.toLowerCase();
      return /(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/.test(host) ? id.replace(/\/+$/, "") : null;
    } catch {
      return null;
    }
  }
  const build = VENDOR_BOARD_URL[vendor];
  return build ? build(id) : null;
}

/** Curated files consulted, in priority order (user's own targets win over the starter list). */
const DEFAULT_CATALOG_PATHS = ["config/targets.json", "config/targets.aml-starter.json"];

interface TargetEntry {
  name?: string;
  vendor?: string;
  boardId?: string;
}

/** Parse one curated targets file into CuratedBoard[]; unreadable/invalid → []. */
function readTargetsFile(path: string): CuratedBoard[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: { targets?: TargetEntry[] };
  try {
    parsed = JSON.parse(raw) as { targets?: TargetEntry[] };
  } catch {
    return [];
  }
  const out: CuratedBoard[] = [];
  for (const t of parsed.targets ?? []) {
    const vendor = (t.vendor ?? "").toLowerCase().trim() as AtsType;
    const boardId = (t.boardId ?? "").trim();
    const name = (t.name ?? "").trim();
    // A board identifier must be real (never a placeholder) and address a supported vendor.
    if (!name || !boardId || /replace|example|your-/i.test(boardId)) continue;
    if (!boardUrlFor(vendor, boardId)) continue;
    out.push({ name, vendor, boardId });
  }
  return out;
}

/**
 * Load curated boards from the given files (default: config/targets*.json), deduped by
 * normalized company name (earlier files/entries win). Best-effort: a missing file is
 * simply skipped, so resolution degrades to probe-only rather than failing.
 */
export function loadCuratedBoards(paths: string[] = DEFAULT_CATALOG_PATHS): CuratedBoard[] {
  const seen = new Set<string>();
  const out: CuratedBoard[] = [];
  for (const p of paths) {
    for (const b of readTargetsFile(p)) {
      const key = normalizeCompany(b.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(b);
    }
  }
  return out;
}

/** Index curated boards by normalized company name (first entry wins on collision). */
export function buildCompanyBoardIndex(boards: CuratedBoard[]): Map<string, CuratedBoard> {
  const index = new Map<string, CuratedBoard>();
  for (const b of boards) {
    const key = normalizeCompany(b.name);
    if (key && !index.has(key)) index.set(key, b);
  }
  return index;
}
