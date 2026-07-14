import type { DiscoveredJob } from "../db/discovered-jobs-repo";
import { checkEmployerJobUrl } from "./job-url";

const APPLY_CATEGORIES = new Set(["strong", "good"]);
const APPLY_ACTIONS = new Set(["apply", "apply_with_custom_resume"]);
// "blocked" jobs are parked for the "Needs you" queue (login wall / CAPTCHA); they must not re-enter
// the normal display, apply, or backfill lists as if they were ordinary matches.
const NON_ACTIONABLE_STATUSES = new Set(["parse_failed", "filtered_out", "low_match", "applied", "blocked", "skipped"]);
/** Rich-fit categories we hide even from the (looser) display list — the engine judged them poor. */
const DISPLAY_EXCLUDED_CATEGORIES = new Set(["weak", "reject"]);

/** Rich fit says only strong/good roles are apply recommendations; legacy score-only rows need the same floor. */
export const APPLY_RECOMMENDED_MIN_SCORE = 0.75;

/**
 * Surfacing floor — well below the apply-recommended floor. A job at/above this is worth SHOWING
 * the user for review; it does NOT mean the app should apply automatically. Decoupling "show me
 * matches" from "auto-apply-recommended" keeps the apply gate conservative while still letting the
 * user see and act on their best options (the discovery list was previously gated by the 0.75 apply
 * floor, so nothing ever appeared when scores sat below it).
 */
export const DISPLAY_MIN_SCORE = 0.35;

export function isApplyRecommendedFit(job: DiscoveredJob): boolean {
  if (!job.fit) return job.score >= APPLY_RECOMMENDED_MIN_SCORE;
  if (job.fit.hardBlockers.length > 0) return false;
  return APPLY_CATEGORIES.has(job.fit.matchCategory) && APPLY_ACTIONS.has(job.fit.recommendedAction);
}

/**
 * Should this job be SHOWN to the user as a match worth reviewing? Intentionally looser than
 * isActionableDiscoveredJob (the apply-recommended gate): it drops the apply-recommended fit check
 * and uses the lower DISPLAY_MIN_SCORE floor by default. Knockouts, already-applied, and dead
 * statuses are still excluded. The user reviews everything; a low score never triggers an apply.
 */
export function isDisplayableDiscoveredJob(
  job: DiscoveredJob,
  opts: {
    minScore?: number;
    appliedDedup?: ReadonlySet<string>;
    requireEmployerJobUrl?: boolean;
  } = {}
): boolean {
  const scoreFloor = opts.minScore ?? DISPLAY_MIN_SCORE;
  if (NON_ACTIONABLE_STATUSES.has(job.status)) return false;
  if (job.knockouts.length > 0) return false;
  if (opts.appliedDedup?.has(job.dedupKey)) return false;
  if (job.score < scoreFloor) return false;
  // When the engine produced a rich fit, trust its judgment: hide hard-blocked and explicitly
  // weak/reject matches. Score-only rows (no rich fit) fall back to the score floor above.
  if (job.fit) {
    if (job.fit.hardBlockers.length > 0) return false;
    if (DISPLAY_EXCLUDED_CATEGORIES.has(job.fit.matchCategory)) return false;
  }

  if (opts.requireEmployerJobUrl) {
    const urlCheck = checkEmployerJobUrl(job.jobUrl);
    if (!urlCheck.ok && urlCheck.reason !== "unsupported employer ATS URL") return false;
  }

  return true;
}

/**
 * Can this job be BROWSED at all (regardless of score)? Used as a last-resort backfill so the user
 * always sees their best available matches even when none clear the display floor. Excludes only
 * knockouts, already-applied, dead statuses, and non-employer URLs.
 */
export function isBrowsableDiscoveredJob(
  job: DiscoveredJob,
  opts: { appliedDedup?: ReadonlySet<string>; requireEmployerJobUrl?: boolean } = {}
): boolean {
  if (NON_ACTIONABLE_STATUSES.has(job.status)) return false;
  if (job.knockouts.length > 0) return false;
  if (opts.appliedDedup?.has(job.dedupKey)) return false;
  if (opts.requireEmployerJobUrl) {
    const urlCheck = checkEmployerJobUrl(job.jobUrl);
    if (!urlCheck.ok && urlCheck.reason !== "unsupported employer ATS URL") return false;
  }
  return true;
}

export function isActionableDiscoveredJob(
  job: DiscoveredJob,
  opts: {
    minScore?: number;
    appliedDedup?: ReadonlySet<string>;
    requireEmployerJobUrl?: boolean;
  } = {}
): boolean {
  const scoreFloor = opts.minScore ?? APPLY_RECOMMENDED_MIN_SCORE;
  if (NON_ACTIONABLE_STATUSES.has(job.status)) return false;
  if (job.knockouts.length > 0) return false;
  if (opts.appliedDedup?.has(job.dedupKey)) return false;
  if (job.score < scoreFloor) return false;
  if (!isApplyRecommendedFit(job)) return false;

  if (opts.requireEmployerJobUrl) {
    const urlCheck = checkEmployerJobUrl(job.jobUrl);
    if (!urlCheck.ok && urlCheck.reason !== "unsupported employer ATS URL") return false;
  }

  return true;
}
