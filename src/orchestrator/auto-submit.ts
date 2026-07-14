// src/orchestrator/auto-submit.ts
//
// The auto-submit decision — the single most consequential gate in the app. It decides whether a
// filled application may be SUBMITTED automatically, or must be queued for the human. It is pure
// and exhaustively gated; the actual click (clickSubmit) only runs when this returns "submit" AND
// the caller passed liveSubmit. Default everywhere is dry-run.

import type { OperatingMode } from "../ats/adapter";
import type { PageContext } from "../ats/adapter";
import { pwPage } from "../ats/page-context";
import type { ReviewGate } from "./review-gate";
import { decideAutoSubmit as decide } from "./submit-readiness";

export type AutoSubmitAction = "submit" | "would_submit" | "queue";

export interface AutoSubmitDecision {
  action: AutoSubmitAction;
  reason: string;
}

export function decideAutoSubmit(
  gate: ReviewGate,
  mode: OperatingMode,
  approved: boolean,
  live: boolean,
  tier?: "A" | "B" | "C"
): AutoSubmitDecision {
  return decide({
    mode,
    employerApproved: approved,
    liveSubmit: live,
    challengeDetected: gate.challengeDetected,
    ...(gate.accountAction ? { accountAction: gate.accountAction } : {}),
    needsConfirmationCount: gate.needsConfirmation.length,
    flaggedCount: gate.flaggedForReview.length,
    hasLedgerCheck: Boolean(gate.ledgerCheck),
    ledgerPassed: gate.ledgerCheck?.passed ?? true,
    submitControlRef: gate.submitControlRef,
    ats: gate.ats,
    ...(tier ? { tier } : {}),
  });
}

/** Click a previously-located submit control. ONLY called after decideAutoSubmit -> "submit". */
export async function clickSubmit(ctx: PageContext, submitRef: string): Promise<void> {
  const page = pwPage(ctx);
  await page.locator(`[data-ap-ref="${submitRef.replace(/["\\]/g, "\\$&")}"]`).click();
}
