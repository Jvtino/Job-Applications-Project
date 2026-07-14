// Shared builder for the discovered-jobs display payload — the exact rows the dashboard's Matches
// view renders. Extracted from the GET /api/discovered-jobs handler so callers surface the SAME job
// list without duplicating the selection/mapping logic. Read-only: an apply is NEVER triggered from
// this list; each row still carries its score and the conservative apply-recommended flag so quality
// stays visible.

import type { DB } from "../db/database";
import { DiscoveredJobsRepo } from "../db/discovered-jobs-repo";
import { ApplicationsRepo } from "../db/applications-repo";
import {
  isActionableDiscoveredJob,
  isDisplayableDiscoveredJob,
  isBrowsableDiscoveredJob,
} from "../jobs/actionable-jobs";
import { classifyApplyCapability } from "../jobs/apply-capability";
import { isEmployerOwnedUrl } from "../jobs/pass-funnel";

/** Apply-capability fields for a job URL (whether the app can form-fill it, and why). */
export function applyCapabilityFields(jobUrl: string | undefined | null): Record<string, unknown> {
  const check = classifyApplyCapability(jobUrl);
  return {
    applyCapability: check.capability,
    applyCapabilityReason: check.reason,
    formFillSupported: check.capability === "supported_form_fill",
  };
}

export interface DiscoveredJobsViewOptions {
  /** Strict display floor. When set (and valid), the list is filtered and NOT backfilled. */
  minScore?: number;
  /** Return the full stored set (score-desc), bypassing the display gate + backfill. */
  includeAll?: boolean;
  /**
   * Employer-ATS-only: keep ONLY postings that live on an employer's own ATS board (Tier 1), hiding
   * aggregator-URL leads such as LinkedIn/Indeed alert links. Uses isEmployerOwnedUrl (the same
   * predicate the apply funnel uses), so a linkedin.com/indeed.com posting URL — valid but an
   * aggregator (kind !== "ats_board") — is dropped even though checkEmployerJobUrl alone would pass it.
   */
  employerOnly?: boolean;
}

/**
 * Build the discovered-jobs rows for a profile. Mirrors GET /api/discovered-jobs exactly: apply the
 * display floor, backfill with the best browsable matches when the default view is thin, and map each
 * row to the UI payload. Returns `[]` for an unknown profile-less caller (handled upstream).
 */
export function buildDiscoveredJobsPayload(
  db: DB,
  profileId: string,
  opts: DiscoveredJobsViewOptions = {}
): Record<string, unknown>[] {
  const minScore = opts.minScore;
  const hasMinScore = minScore !== undefined && !Number.isNaN(minScore);
  const includeAll = opts.includeAll === true;
  const appliedDedup = new Set(new ApplicationsRepo(db).list(profileId).map((a) => a.dedupKey));
  const allJobs = new DiscoveredJobsRepo(db).list(profileId);
  const displayOpts = {
    ...(hasMinScore ? { minScore } : {}),
    appliedDedup,
    requireEmployerJobUrl: true,
  };
  const displayable = allJobs.filter((j) => isDisplayableDiscoveredJob(j, displayOpts));
  // Thin default views get topped up with the next-best browsable matches (never below-floor rows
  // when an explicit minScore was requested). Each row still carries its score + apply-recommended flag.
  const MIN_SHOWN = 12;
  const backfilled = () => {
    const have = new Set(displayable.map((j) => j.id));
    const extra = allJobs.filter(
      (j) => !have.has(j.id) && isBrowsableDiscoveredJob(j, { appliedDedup, requireEmployerJobUrl: true })
    );
    return displayable.concat(extra.slice(0, MIN_SHOWN - displayable.length));
  };
  const selected = includeAll
    ? allJobs
    : hasMinScore || displayable.length >= MIN_SHOWN
      ? displayable
      : backfilled();
  // Employer-ATS-only view: drop aggregator-URL leads (LinkedIn/Indeed), keeping only postings on an
  // employer's own board. The resolver already surfaces the real off-platform posting for many of these.
  const jobs = opts.employerOnly ? selected.filter((j) => isEmployerOwnedUrl(j.jobUrl)) : selected;
  return jobs.map((j) => ({
    id: j.id,
    company: j.company,
    title: j.title,
    ...(j.location ? { location: j.location } : {}),
    jobUrl: j.jobUrl,
    atsType: j.atsType,
    score: j.score,
    fitPct: Math.round(j.score * 100),
    rationale: j.rationale,
    knockouts: j.knockouts,
    // Badge means "apply-recommended" — always the conservative apply floor, independent of the
    // looser display minScore used to surface the row.
    actionable: isActionableDiscoveredJob(j, {
      appliedDedup,
      requireEmployerJobUrl: true,
    }),
    ...applyCapabilityFields(j.jobUrl),
    ...(j.salaryMin !== undefined ? { salaryMin: j.salaryMin } : {}),
    ...(j.salaryMax !== undefined ? { salaryMax: j.salaryMax } : {}),
    ...(j.description ? { description: j.description } : {}),
    ...(j.fitFactors ? { fitFactors: j.fitFactors } : {}),
    ...(j.fit ? { fit: j.fit } : {}),
    tags: j.tags ?? [],
    ...(j.tier ? { tier: j.tier } : {}),
    // Non-persisted hint. Prefer the structured engine's category (strong/good/stretch/...),
    // falling back to score bands when no rich fit is present.
    suggestedTier: j.fit
      ? j.fit.matchCategory === "strong"
        ? "A"
        : j.fit.matchCategory === "good"
          ? "B"
          : "C"
      : j.score >= 0.7
        ? "A"
        : j.score >= 0.5
          ? "B"
          : "C",
    status: j.status,
    discoveredAt: j.discoveredAt,
    applied: appliedDedup.has(j.dedupKey),
  }));
}
