// src/jobs/resolve-company-board.ts
//
// Resolve a company NAME (e.g. from a LinkedIn/Indeed job-alert lead) to its OWN employer-ATS
// board, so discovery can scan that board directly and surface the real off-platform posting.
// Catalog-first (zero network); on a miss, a best-effort probe of ONLY the allowlisted ATS
// public APIs.
//
// COMPLIANCE (max): this module can only ever emit or fetch employer-ATS hosts. The catalog
// path mints URLs via boardUrlFor() (a fixed vendor switch); the probe path uses a hardcoded
// 3-entry ATS table on the NetGuard allowlist. There is NO code path from a company name to a
// linkedin/indeed/glassdoor URL, and every probe fetch still routes through NetGuard, which
// hard-denies those hosts BEFORE the allowlist (src/finder/net/netGuard.ts).

import type { AtsType } from "./types";
import type { NetGuard } from "../finder/net";
import { normalizeCompany } from "../finder/normalization";
import { boardUrlFor, type CuratedBoard } from "./company-board-catalog";

export interface ResolvedBoard {
  name: string;
  atsType: AtsType;
  boardUrl: string;
  via: "catalog" | "probe";
}

/** Slugify a company name into a candidate board token: normalized, alnum-only, no spaces. */
export function companySlug(name: string): string {
  return normalizeCompany(name)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * The ONLY hosts the probe may contact — all employer-ATS public search APIs already on the
 * NetGuard allowlist (src/finder/net/hosts.ts). Adding an aggregator here is impossible without
 * also editing the allowlist, and the denylist would still refuse it first.
 */
const ATS_PROBE: ReadonlyArray<{
  ats: AtsType;
  api: (slug: string) => string;
  board: (slug: string) => string;
  hasPostings: (body: unknown) => boolean;
}> = [
  {
    ats: "greenhouse",
    api: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    board: (s) => `https://boards.greenhouse.io/${s}`,
    hasPostings: (b) => arrayLen((b as { jobs?: unknown }).jobs) > 0,
  },
  {
    ats: "lever",
    api: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    board: (s) => `https://jobs.lever.co/${s}`,
    hasPostings: (b) => arrayLen(b) > 0,
  },
  {
    ats: "ashby",
    api: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    board: (s) => `https://jobs.ashbyhq.com/${s}`,
    hasPostings: (b) => arrayLen((b as { jobs?: unknown }).jobs) > 0,
  },
];

function arrayLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

export interface ResolveOptions {
  index: Map<string, CuratedBoard>;
  /** When supplied, catalog misses are probed against the allowlisted ATS APIs. Omit → catalog-only. */
  net?: NetGuard;
  signal?: AbortSignal;
}

/**
 * Resolve one company name to its employer board, or null if unknown. Catalog hits are instant
 * and network-free; a miss triggers the bounded, allowlisted-only probe (only when a NetGuard is
 * supplied — omit it for catalog-only resolution).
 */
export async function resolveCompanyToBoard(
  companyName: string,
  opts: ResolveOptions,
): Promise<ResolvedBoard | null> {
  const key = normalizeCompany(companyName);
  if (!key) return null;

  // (a) Catalog hit — instant, no network.
  const hit = opts.index.get(key);
  if (hit) {
    const boardUrl = boardUrlFor(hit.vendor, hit.boardId);
    if (boardUrl) return { name: hit.name, atsType: hit.vendor, boardUrl, via: "catalog" };
  }

  // (b) Best-effort probe (only when a NetGuard is supplied). A slug shorter than 4 chars is too
  // generic to be a safe board token, so we never probe on it.
  if (!opts.net) return null;
  const slug = companySlug(companyName);
  if (slug.length < 4) return null;

  for (const probe of ATS_PROBE) {
    if (opts.signal?.aborted) return null;
    try {
      const res = await opts.net.getJson(probe.api(slug), opts.signal ? { signal: opts.signal } : {});
      if (res.statusCode === 200 && probe.hasPostings(res.body)) {
        return { name: companyName, atsType: probe.ats, boardUrl: probe.board(slug), via: "probe" };
      }
    } catch {
      // Denied host, network error, or non-existent board — skip this ATS and try the next.
    }
  }
  return null;
}
