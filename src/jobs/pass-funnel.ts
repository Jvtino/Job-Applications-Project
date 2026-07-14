// src/jobs/pass-funnel.ts
//
// Bridges the LIVE discovery output (DiscoveredJob rows) to the domain-general AutomationFunnelReport
// (funnel-report.ts), so every automation pass can answer "where were jobs lost?" honestly — using
// the SAME US-eligibility gate, apply-capability contract, and rich-fit categories the rest of the
// engine uses. Pure + side-effect-free; the caller records/returns the report.

import type { DB } from "../db/database";
import { recordAudit } from "../db/database";
import { DiscoveredJobsRepo, type DiscoveredJob } from "../db/discovered-jobs-repo";
import type { JobSearchIntent } from "../types/job-search-intent";
import { classifyUsEligibility } from "./us-eligibility";
import { classifyApplyCapability } from "./apply-capability";
import { checkEmployerJobUrl } from "./job-url";
import { sourceForUrl } from "./source-catalog";
import type { FitCategory } from "./fit-breakdown";
import { buildFunnelReport, type AutomationFunnelReport, type FunnelPosting } from "./funnel-report";

/**
 * Is this an EMPLOYER-OWNED apply route (Tier 1), not an aggregator/API lead? A recognized posting
 * whose source is an ATS board (or a bespoke employer ATS not in the aggregator catalog) counts;
 * a LinkedIn/Indeed/API URL does not, even though it's a valid link — those must resolve to an
 * employer page before automation (brief F1/F4).
 */
export function isEmployerOwnedUrl(url: string): boolean {
  if (!checkEmployerJobUrl(url).ok) return false;
  try {
    const src = sourceForUrl(new URL(url));
    return src ? src.kind === "ats_board" : true; // not in the aggregator catalog → bespoke employer ATS
  } catch {
    return false;
  }
}

function mapFitCategory(c: string): FitCategory {
  switch (c) {
    case "strong": return "strong";
    case "good": return "good";
    case "stretch": return "possible";
    case "reject": return "reject";
    default: return "weak";
  }
}

function scoreCategory(score: number): FitCategory {
  if (score >= 0.85) return "strong";
  if (score >= 0.75) return "good";
  if (score >= 0.6) return "possible";
  return "weak";
}

/** Classify one discovered job the way the funnel sees it (same gates as the live apply path). */
export function discoveredJobToFunnelPosting(job: DiscoveredJob): FunnelPosting {
  const employerUrlConfirmed = isEmployerOwnedUrl(job.jobUrl);
  const usEligibility = classifyUsEligibility(job.location, job.description).status;
  const fullJdFetched = Boolean(job.description && job.description.trim().length >= 40);
  const capability = classifyApplyCapability(job.jobUrl).capability;
  const hardBlocked = job.knockouts.length > 0 || (job.fit ? job.fit.hardBlockers.length > 0 : false);
  const hardFilterPassed = !hardBlocked;

  let category: FitCategory | "lead";
  let rejectionReason: string | undefined;

  if (hardBlocked) {
    category = "reject";
    rejectionReason = job.knockouts[0] ?? job.fit?.hardBlockers[0] ?? "hard filter";
  } else if (usEligibility === "blocked_non_us") {
    category = "reject";
    rejectionReason = "non-US location";
  } else if (!employerUrlConfirmed) {
    category = "lead";
    rejectionReason = "no confirmed employer apply URL";
  } else if (!fullJdFetched) {
    category = "lead";
    rejectionReason = "full job description unavailable";
  } else if (usEligibility === "needs_review") {
    // Ambiguous US: visible for manual review, capped below Recommended.
    category = "possible";
    rejectionReason = "US eligibility ambiguous — manual review";
  } else {
    category = job.fit ? mapFitCategory(job.fit.matchCategory) : scoreCategory(job.score);
    if (category === "weak") rejectionReason = "weak skill/experience fit";
    else if (category === "reject") rejectionReason = "hard filter";
  }

  const isRecommended = category === "strong" || category === "good";
  const applyReady = isRecommended && capability === "supported_form_fill" && usEligibility === "eligible_us";
  const manualRecommended = isRecommended && !applyReady;

  return {
    sourceId: job.atsType ?? "unknown",
    employerUrlConfirmed,
    usEligibility,
    fullJdFetched,
    hardFilterPassed,
    category,
    applyReady,
    manualRecommended,
    ...(rejectionReason ? { rejectionReason } : {}),
  };
}

export interface BuildPassFunnelInput {
  passId: string;
  intent: JobSearchIntent;
  jobs: DiscoveredJob[];
  /** Raw postings observed this pass (before dedup), if known; defaults to jobs.length. */
  rawFound?: number;
  queriesGenerated?: number;
  sourcesSearched?: number;
}

/** Build the automation funnel report for a pass from its classified discovered jobs. */
export function buildPassFunnel(input: BuildPassFunnelInput): AutomationFunnelReport {
  const postings = input.jobs.map(discoveredJobToFunnelPosting);
  const sourcesSearched = input.sourcesSearched ?? new Set(postings.map((p) => p.sourceId)).size;
  return buildFunnelReport({
    passId: input.passId,
    intentConfidence: input.intent.confidence,
    roleFamilies: input.intent.roleFamilies,
    targetTitles: input.intent.targetTitles,
    queriesGenerated: input.queriesGenerated ?? 0,
    sourcesSearched,
    rawFound: input.rawFound ?? input.jobs.length,
    deduped: input.jobs.length,
    postings,
  });
}

/** The subset of the funnel report the dashboard Search-health card reads, as an audit payload. This
 *  is the single owner of the `automation.funnel` wire format so the manual + apply paths can't drift. */
export function funnelAuditDetail(trigger: string, f: AutomationFunnelReport) {
  return {
    trigger,
    intentConfidence: f.intentConfidence,
    roleFamilies: f.roleFamilies,
    targetTitles: f.targetTitles.slice(0, 6),
    deduped: f.deduped,
    employerUrlConfirmed: f.employerUrlConfirmed,
    usEligible: f.usEligible,
    fullJdFetched: f.fullJdFetched,
    strong: f.strong,
    good: f.good,
    possible: f.possible,
    applyReady: f.applyReady,
    manualRecommended: f.manualRecommended,
    rejectedReasons: f.rejectedReasons,
    bottleneck: f.bottleneck,
    sourceHealth: f.sourceHealth,
  };
}

/**
 * Classify the profile's current pipeline and record the `automation.funnel` audit event — the ONE
 * place both the manual "Find jobs" path and the automation cycle emit funnel telemetry. Best-effort:
 * telemetry never breaks a pass. Reads up to 500 pipeline rows itself so callers don't duplicate it.
 */
export function emitPassFunnel(
  db: DB,
  profileId: string,
  trigger: string,
  opts: { passId: string; intent: JobSearchIntent; rawFound?: number }
): void {
  try {
    const jobs = new DiscoveredJobsRepo(db).list(profileId, { minScore: 0 }).slice(0, 500);
    const report = buildPassFunnel({
      passId: opts.passId,
      intent: opts.intent,
      jobs,
      ...(opts.rawFound !== undefined ? { rawFound: opts.rawFound } : {}),
    });
    recordAudit(db, profileId, "automation.funnel", funnelAuditDetail(trigger, report));
  } catch {
    /* funnel telemetry is best-effort; never break the pass */
  }
}
