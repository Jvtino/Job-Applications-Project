// src/jobs/funnel-report.ts
//
// The automation funnel report (brief F2 + J3). Every pass must be able to explain where jobs were
// LOST — weak queries, dead sources, fetch failures, over-strict filters, or scoring — so a
// zero-recommendation pass is an honest diagnosis, not silent failure or trash backfill.
//
// Pure + domain-general: it tallies whatever classified postings it's given and never fabricates a
// recommendation to look active.

import type { FitCategory } from "./fit-breakdown";
import type { UsEligibilityStatus } from "./us-eligibility";
import type { IntentConfidence } from "../types/job-search-intent";

export interface SourceHealth {
  sourceId: string;
  searched: boolean;
  queriesRun: number;
  rawJobsFound: number;
  employerUrlsResolved: number;
  fullJdsFetched: number;
  recommendedJobs: number;
  failures: Array<{ type: string; count: number }>;
}

/** One deduped, classified posting as the funnel sees it. */
export interface FunnelPosting {
  sourceId: string;
  employerUrlConfirmed: boolean;
  usEligibility: UsEligibilityStatus;
  fullJdFetched: boolean;
  hardFilterPassed: boolean;
  /** "lead" = kept as a lead only (no full JD / no employer URL); otherwise a fit category. */
  category: FitCategory | "lead";
  applyReady: boolean;
  manualRecommended: boolean;
  /** Required whenever the posting was rejected or held as a lead — the honest reason. */
  rejectionReason?: string;
}

export interface FunnelInput {
  passId: string;
  intentConfidence: IntentConfidence;
  roleFamilies: string[];
  targetTitles: string[];
  queriesGenerated: number;
  sourcesSearched: number;
  rawFound: number;
  deduped: number;
  postings: FunnelPosting[];
  /** Optional per-source raw stats (from the search layer) to enrich SourceHealth. */
  sources?: SourceHealth[];
}

export interface AutomationFunnelReport {
  passId: string;
  intentConfidence: IntentConfidence;
  roleFamilies: string[];
  targetTitles: string[];
  queriesGenerated: number;
  sourcesSearched: number;
  rawFound: number;
  deduped: number;
  employerUrlConfirmed: number;
  usEligible: number;
  fullJdFetched: number;
  hardFilterPassed: number;
  strong: number;
  good: number;
  possible: number;
  weak: number;
  rejected: number;
  leads: number;
  manualRecommended: number;
  applyReady: number;
  rejectedReasons: Record<string, number>;
  sourceHealth: SourceHealth[];
  /** Human-readable bottleneck when there are no strong/good matches (else ""). */
  bottleneck: string;
  /** Internal-consistency warnings — empty when the counts all reconcile. */
  warnings: string[];
}

function reasonKey(reason: string): string {
  const r = reason.toLowerCase();
  if (/non-us|non us/.test(r)) return "nonUs";
  if (/ambiguous|us eligibility|manual review/.test(r)) return "usAmbiguous";
  if (/wrong role family|wrong family/.test(r)) return "wrongRoleFamily";
  if (/senior/.test(r)) return "seniorityMismatch";
  if (/credential|license|degree/.test(r)) return "missingRequiredCredential";
  if (/employer (apply )?url|no confirmed employer/.test(r)) return "noEmployerUrl";
  if (/skill/.test(r)) return "weakSkillMatch";
  if (/aggregator/.test(r)) return "aggregatorOnly";
  if (/unsupported ats|form-fill adapter/.test(r)) return "unsupportedAts";
  if (/job description|full jd/.test(r)) return "noFullJd";
  if (/sponsorship/.test(r)) return "sponsorship";
  return "other";
}

function deriveSourceHealth(input: FunnelInput): SourceHealth[] {
  if (input.sources?.length) {
    // Enrich provided per-source stats with the recommendedJobs count from classified postings.
    const recBySource = new Map<string, number>();
    for (const p of input.postings) {
      if (p.category === "strong" || p.category === "good") {
        recBySource.set(p.sourceId, (recBySource.get(p.sourceId) ?? 0) + 1);
      }
    }
    return input.sources.map((s) => ({ ...s, recommendedJobs: s.recommendedJobs || (recBySource.get(s.sourceId) ?? 0) }));
  }
  // Derive a coarse per-source health from the classified postings alone.
  const bySource = new Map<string, SourceHealth>();
  for (const p of input.postings) {
    let h = bySource.get(p.sourceId);
    if (!h) {
      h = { sourceId: p.sourceId, searched: true, queriesRun: 0, rawJobsFound: 0, employerUrlsResolved: 0, fullJdsFetched: 0, recommendedJobs: 0, failures: [] };
      bySource.set(p.sourceId, h);
    }
    h.rawJobsFound += 1;
    if (p.employerUrlConfirmed) h.employerUrlsResolved += 1;
    if (p.fullJdFetched) h.fullJdsFetched += 1;
    if (p.category === "strong" || p.category === "good") h.recommendedJobs += 1;
  }
  return [...bySource.values()];
}

export function buildFunnelReport(input: FunnelInput): AutomationFunnelReport {
  const count = (pred: (p: FunnelPosting) => boolean) => input.postings.filter(pred).length;

  const employerUrlConfirmed = count((p) => p.employerUrlConfirmed);
  const usEligible = count((p) => p.usEligibility === "eligible_us");
  const fullJdFetched = count((p) => p.fullJdFetched);
  const hardFilterPassed = count((p) => p.hardFilterPassed);
  const strong = count((p) => p.category === "strong");
  const good = count((p) => p.category === "good");
  const possible = count((p) => p.category === "possible");
  const weak = count((p) => p.category === "weak");
  const rejected = count((p) => p.category === "reject");
  const leads = count((p) => p.category === "lead");
  const manualRecommended = count((p) => p.manualRecommended);
  const applyReady = count((p) => p.applyReady);

  const rejectedReasons: Record<string, number> = {};
  const warnings: string[] = [];
  for (const p of input.postings) {
    if (p.category === "reject" || p.category === "lead") {
      if (!p.rejectionReason) {
        warnings.push(`a ${p.category} posting from ${p.sourceId} has no rejection reason`);
        continue;
      }
      const k = reasonKey(p.rejectionReason);
      rejectedReasons[k] = (rejectedReasons[k] ?? 0) + 1;
    }
  }

  // Internal consistency.
  const categorized = strong + good + possible + weak + rejected + leads;
  if (categorized !== input.postings.length) {
    warnings.push(`category counts (${categorized}) do not sum to the number of classified postings (${input.postings.length})`);
  }
  if (input.deduped !== input.postings.length) {
    warnings.push(`deduped count (${input.deduped}) does not match the number of classified postings (${input.postings.length})`);
  }
  if (input.deduped > input.rawFound) warnings.push(`deduped (${input.deduped}) exceeds rawFound (${input.rawFound})`);
  if (usEligible > input.postings.length) warnings.push("usEligible exceeds posting count");
  if (applyReady > strong + good) warnings.push("applyReady exceeds strong+good");

  // Zero-match diagnosis: where did the funnel collapse?
  let bottleneck = "";
  if (strong + good === 0) {
    if (input.rawFound === 0) bottleneck = "No postings found — too few sources searched or the queries were too narrow.";
    else if (employerUrlConfirmed === 0) bottleneck = "No confirmed employer apply URL on any posting — sources resolved only to aggregators/leads.";
    else if (usEligible === 0) bottleneck = "Every posting was ambiguous or non-US — nothing cleared the US-eligibility gate.";
    else if (fullJdFetched === 0) bottleneck = "Full job descriptions could not be fetched — nothing is Recommended without a parsed JD.";
    else if (hardFilterPassed === 0) bottleneck = "Every posting was rejected by hard filters (credential/seniority/location).";
    else {
      const top = Object.entries(rejectedReasons).sort((a, b) => b[1] - a[1])[0];
      bottleneck = top
        ? `No strong/good matches — the dominant loss was "${top[0]}" (${top[1]}). Consider broadening titles or confirming your target.`
        : "No strong/good matches — most postings scored below the Recommended threshold (weak skill/experience fit).";
    }
  }

  return {
    passId: input.passId,
    intentConfidence: input.intentConfidence,
    roleFamilies: input.roleFamilies,
    targetTitles: input.targetTitles,
    queriesGenerated: input.queriesGenerated,
    sourcesSearched: input.sourcesSearched,
    rawFound: input.rawFound,
    deduped: input.deduped,
    employerUrlConfirmed,
    usEligible,
    fullJdFetched,
    hardFilterPassed,
    strong,
    good,
    possible,
    weak,
    rejected,
    leads,
    manualRecommended,
    applyReady,
    rejectedReasons,
    sourceHealth: deriveSourceHealth(input),
    bottleneck,
    warnings,
  };
}
