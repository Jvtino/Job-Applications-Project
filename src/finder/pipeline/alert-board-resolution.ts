// src/finder/pipeline/alert-board-resolution.ts
//
// Turn the companies named in exported LinkedIn/Indeed job-alert leads into employer-ATS boards
// to scan THIS pass — the compliant "take me off LinkedIn to the company's own site" step.
// Resolution is catalog-first with a bounded, allowlisted-only ATS probe (resolve-company-board.ts).
// It never fetches or emits a LinkedIn/Indeed URL; scanning the resolved board lets the existing
// dedupe collapse the alert lead into the real off-platform posting (a direct ATS beats an email
// lead in sourcePriority, so the ATS representation wins).

import type { AlertJob } from "../../email/alert-parser";
import type { NetGuard } from "../net";
import { normalizeCompany } from "../normalization";
import { resolveCompanyToBoard, type ResolvedBoard } from "../../jobs/resolve-company-board";
import type { CuratedBoard } from "../../jobs/company-board-catalog";

/** Unique alerted company display-names (deduped by normalized name; blanks dropped). */
export function collectAlertedCompanies(alerts: AlertJob[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of alerts) {
    const name = a.raw.company?.trim();
    if (!name) continue;
    const key = normalizeCompany(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface ResolveAlertBoardsOptions {
  index: Map<string, CuratedBoard>;
  /** When omitted, resolution is catalog-only (no ATS probing). */
  net?: NetGuard;
  signal?: AbortSignal;
  /** Normalized company names already scanned directly (DB targets) — skipped to avoid double-scan. */
  known?: ReadonlySet<string>;
  /** Cap on catalog-miss probes per pass (each ≤ 3 allowlisted API calls). Default 15. */
  maxProbe?: number;
}

/** Resolve alerted companies to employer boards to add to this pass's scan set. */
export async function resolveAlertBoards(
  companies: string[],
  opts: ResolveAlertBoardsOptions,
): Promise<ResolvedBoard[]> {
  const known = opts.known ?? new Set<string>();
  const maxProbe = opts.maxProbe ?? 15;
  const out: ResolvedBoard[] = [];
  const claimed = new Set<string>(); // guard against two names resolving to the same board
  let probes = 0;

  for (const name of companies) {
    if (opts.signal?.aborted) break;
    const key = normalizeCompany(name);
    if (known.has(key)) continue; // already scanned as a direct target

    // Bound best-effort probing: a catalog miss costs network, a hit does not.
    const inCatalog = opts.index.has(key);
    if (!inCatalog) {
      if (!opts.net || probes >= maxProbe) continue;
      probes++;
    }

    const resolved = await resolveCompanyToBoard(name, {
      index: opts.index,
      ...(opts.net ? { net: opts.net } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (resolved && !claimed.has(resolved.boardUrl)) {
      claimed.add(resolved.boardUrl);
      out.push(resolved);
    }
  }
  return out;
}
