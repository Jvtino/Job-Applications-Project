// src/ats/multi-step.ts
//
// Multi-step (wizard) apply engine. Workday and similar ATSes render an application as a SEQUENCE of
// pages with a "Save and Continue" between each. The shared engine (fillApplication in adapter.ts)
// fills ONE page; this drives it across the whole wizard:
//
//   fill the current page -> re-check challenge/wall -> if the page still needs a human, STOP (do
//   NOT advance) -> if it's the final/review step, STOP for review -> else advance and repeat.
//
// SAFETY INVARIANTS (see docs/workday-integration.md §5):
//   - Confidence-gated advance: a page that produced ANY needsConfirmation (unmapped required field,
//     low-confidence match, or readback mismatch) is NEVER advanced past. The wizard is left on that
//     page for the human to resolve and resume (ApplySession.refresh) — no entered data is lost,
//     since the ATS has saved every completed page.
//   - A human challenge / login wall at any step stops the loop and hands off — never bypassed.
//   - A hard step cap backstops a broken adapter that never reaches a final step or fails to advance.
//   - This NEVER submits. It stops at the final step; the human reviews and clicks submit — the same
//     human-submit-only guarantee as the single-page path.
//
// The return value is a plain FillReport (plus step telemetry), so every downstream consumer — the
// review gate and submit-readiness — is byte-for-byte unchanged from the single-page path.

import {
  fillApplication,
  type FieldMatcher,
  type FillApplicationOptions,
  type FillReport,
  type MatchResult,
  type MultiStepAtsAdapter,
  type OperatingMode,
  type PageContext,
} from "./adapter";
import type { ApplicantProfile } from "../types/applicant-profile";

/** Generous cap on wizard pages — real Workday flows are 5-8; this only backstops a runaway loop. */
export const DEFAULT_MAX_STEPS = 12;

export type MultiStepStopReason =
  | "final_step" // reached the Review/Submit step — stop for the human to review + submit
  | "needs_confirmation" // a page needs a human; do not advance past it
  | "challenge" // a CAPTCHA / login wall appeared mid-wizard; hand off
  | "no_advance_control" // a non-final page with no "next" control; treated as terminal
  | "max_steps"; // hit the step cap without reaching a final step (suspicious — likely a broken flow)

export interface MultiStepFillReport extends FillReport {
  /** How many wizard pages were visited (filled, or found to be a challenge). */
  stepsVisited: number;
  /** Why the loop stopped. */
  stopReason: MultiStepStopReason;
}

export interface MultiStepFillOptions extends FillApplicationOptions {
  /** Backstop against an adapter that never reaches a final step. Defaults to DEFAULT_MAX_STEPS. */
  maxSteps?: number;
  /** Optional per-step callback (telemetry/logging); receives the 0-based step index + its report. */
  onStep?: (step: number, report: FillReport) => void;
}

export async function fillMultiStepApplication(
  adapter: MultiStepAtsAdapter,
  matcher: FieldMatcher,
  ctx: PageContext,
  profile: ApplicantProfile,
  mode: OperatingMode,
  opts: MultiStepFillOptions = {}
): Promise<MultiStepFillReport> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const aggregate: FillReport = {
    filled: [],
    flaggedForReview: [],
    needsConfirmation: [],
    challengeDetected: false,
  };
  let stepsVisited = 0;
  let stopReason: MultiStepStopReason = "max_steps";

  const tagStep = (results: MatchResult[], step: number) => {
    for (const m of results) m.field.step = step;
  };

  for (let step = 0; step < maxSteps; step++) {
    // Fill the current page. fillApplication itself re-checks the challenge at the start of each page
    // and mid-fill, so a mid-wizard login/CAPTCHA (e.g. a session timeout) is caught here, per step.
    const pageReport = await fillApplication(adapter, matcher, ctx, profile, mode, opts);
    stepsVisited++;

    tagStep(pageReport.filled, step);
    tagStep(pageReport.flaggedForReview, step);
    tagStep(pageReport.needsConfirmation, step);
    aggregate.filled.push(...pageReport.filled);
    aggregate.flaggedForReview.push(...pageReport.flaggedForReview);
    aggregate.needsConfirmation.push(...pageReport.needsConfirmation);
    opts.onStep?.(step, pageReport);

    // A challenge / login wall at any step: stop and hand off (never advance past a human gate).
    if (pageReport.challengeDetected) {
      aggregate.challengeDetected = true;
      stopReason = "challenge";
      break;
    }

    // Confidence-gated advance: never advance a page that still needs a human.
    if (pageReport.needsConfirmation.length > 0) {
      stopReason = "needs_confirmation";
      break;
    }

    // Clean page. If it's the final (review/submit) step, stop so the human reviews and submits.
    if (await adapter.isFinalStep(ctx)) {
      stopReason = "final_step";
      break;
    }

    // Otherwise advance to the next step. No advance control on a non-final page -> treat as terminal.
    const next = await adapter.findNextControl(ctx);
    if (!next) {
      stopReason = "no_advance_control";
      break;
    }
    await opts.pace?.(); // human pause before clicking "Save and Continue"
    await adapter.advanceStep(ctx);
  }

  return { ...aggregate, stepsVisited, stopReason };
}
