// src/orchestrator/submit-readiness.ts
//
// Shared rules for whether an application may proceed to submit (auto or human one-click).
// Keeps decideAutoSubmit and buildReviewGate aligned.

import type { OperatingMode } from "../ats/adapter";

export interface GateBlockerInput {
  challengeDetected: boolean;
  accountAction?: unknown;
  needsConfirmation: unknown[];
  ledgerCheck?: { passed: boolean };
  submitControlRef?: string;
}

export interface SubmitReadinessInput {
  challengeDetected: boolean;
  accountAction?: unknown;
  needsConfirmationCount: number;
  flaggedCount: number;
  ledgerPassed: boolean;
  hasLedgerCheck: boolean;
  submitControlRef?: string;
  ats: string;
  mode: OperatingMode;
  employerApproved: boolean;
  liveSubmit: boolean;
  /** The user's strategy tier for this match. Tier A ("dream") is NEVER auto-submitted. */
  tier?: "A" | "B" | "C";
}

/** Reasons that block submit for both semi (human) and auto paths. */
export function coreSubmitBlockers(gate: GateBlockerInput): string | null {
  if (gate.challengeDetected) return "human verification still present";
  if (gate.accountAction) return "account/login required";
  if (gate.needsConfirmation.length > 0) return `${gate.needsConfirmation.length} field(s) need confirmation`;
  if (gate.ledgerCheck && !gate.ledgerCheck.passed) return "document failed ledger check";
  if (!gate.submitControlRef) return "submit control not found";
  return null;
}

/** Semi mode: human may click submit when core blockers are clear (flagged fields are OK). */
export function readyForHumanSubmit(gate: GateBlockerInput): boolean {
  return coreSubmitBlockers(gate) === null;
}

export function decideAutoSubmit(input: SubmitReadinessInput): { action: "submit" | "would_submit" | "queue"; reason: string } {
  if (input.mode !== "auto") return { action: "queue", reason: "not in auto mode (fills + queues for your click)" };
  if (!input.employerApproved) return { action: "queue", reason: "employer is not pre-approved for auto-submit" };
  // Strategy guardrail: dream-tier roles always get a deliberate human review, even at a
  // pre-approved employer with every other gate green. (Defense-in-depth — the live product
  // path is already human-submit-only; this protects the dormant auto-submit path too.)
  if (input.tier === "A") return { action: "queue", reason: "Tier A target — held for your manual review (dream roles are never auto-submitted)" };
  // Workday is a multi-step wizard with a mandatory per-tenant account and frequent mid-flow
  // login/timeout walls — it is ALWAYS human-submit-only. As a NAMED adapter it would otherwise
  // slip past the generic-only guard below, so pin it out of the (dormant) auto-submit path here.
  if (input.ats === "workday") return { action: "queue", reason: "Workday multi-step application — always held for your manual review" };
  if (input.ats === "generic") return { action: "queue", reason: "unknown form adapter requires manual review" };

  const blocked = coreSubmitBlockers({
    challengeDetected: input.challengeDetected,
    ...(input.accountAction ? { accountAction: input.accountAction } : {}),
    needsConfirmation: Array(input.needsConfirmationCount).fill(null),
    ...(input.hasLedgerCheck ? { ledgerCheck: { passed: input.ledgerPassed } } : {}),
    ...(input.submitControlRef ? { submitControlRef: input.submitControlRef } : {}),
  });
  if (blocked) return { action: "queue", reason: blocked };

  return input.liveSubmit
    ? { action: "submit", reason: "all of your rules passed" }
    : { action: "would_submit", reason: "all rules passed — dry-run (pass --live-submit to actually send)" };
}
