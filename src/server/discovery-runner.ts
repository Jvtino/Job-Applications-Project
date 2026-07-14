// src/server/discovery-runner.ts
//
// The GUI's two discovery entry points:
//   - resolveCompanyViaBrowser: browse a company homepage/careers page to find a
//     supported source (still browser-based; the browser stays for apply).
//   - runDiscoveryPass: one discovery pass across the enabled sources, now powered
//     by the finder pipeline (reads-only connectors, no browser) writing scored
//     postings into discovered_jobs.
// Injectable so the API can be tested without launching Chromium or the network.

import { join } from "node:path";
import type { DB } from "../db/database";
import { ResumeInsightsRepo } from "../db/resume-insights-repo";
import { resolveCompanyBoard, type ResolvedCompany } from "../jobs/board-detect";
import { resolveJobSearchIntent } from "../jobs/job-search-intent";
import { runFinderDiscovery } from "../finder/pipeline/run-discovery";
import { finderSecretLookup } from "./config-store";
import type { DiscoveryRun } from "../finder/pipeline/discovery-run-types";
import type { ApplicantProfile } from "../types/applicant-profile";
import type { Fact } from "../types/facts-ledger";

export type CompanyResolution = ResolvedCompany | null;

/**
 * Resolve a pasted board URL to a target company. String-based (no browser):
 * the user pastes a recognized board URL. Name/signature kept for the API dep.
 */
export async function resolveCompanyViaBrowser(
  url: string,
  name?: string,
  _opts: { headed?: boolean } = {},
): Promise<CompanyResolution> {
  return resolveCompanyBoard(url, name);
}

/**
 * One discovery pass across all enabled sources via the finder pipeline. The
 * finder is DB-free and browser-free — it fetches through NetGuard (reads-only,
 * host-allowlisted), scores against the résumé profile, and upserts into
 * discovered_jobs. `approvedFacts`/`opts.ledgerFacts` feed intent resolution.
 */
export async function runDiscoveryPass(
  db: DB,
  profile: ApplicantProfile,
  approvedFacts: Fact[],
  opts: {
    headed?: boolean;
    onProgress?: (msg: string) => void;
    ledgerFacts?: Fact[];
    /** Override the .env path (defaults to APPLYPILOT_ENV_PATH or ./.env). */
    envPath?: string;
    /** Override the finder secret lookup (tests inject one; defaults to .env). */
    getSecret?: (key: string) => string | null;
  } = {},
): Promise<DiscoveryRun> {
  opts.onProgress?.("Searching your target companies for roles that fit your résumé…");
  const facts = opts.ledgerFacts ?? approvedFacts;
  const intent = resolveJobSearchIntent({ profile, facts });
  const insights = new ResumeInsightsRepo(db).get(profile.id);

  // Unlock the (opt-in) USAJOBS federal search when a key is configured. Reads the
  // same .env the settings UI writes; a no-op secret lookup when nothing is set.
  const envPath =
    opts.envPath ?? (process.env.APPLYPILOT_ENV_PATH?.trim() || join(process.cwd(), ".env"));
  const getSecret = opts.getSecret ?? finderSecretLookup(envPath);

  return runFinderDiscovery({
    db,
    profile,
    intent,
    insights,
    getSecret,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
}
