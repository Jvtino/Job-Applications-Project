// src/ats/challenge.ts
//
// Shared challenge handling: detect a human-verification challenge and decide whether to pause.
// ApplyPilot NEVER solves or bypasses CAPTCHAs or bot checks — a detected challenge always pauses
// the run and hands the live browser to the human. That good-faith posture is a hard product rule.

import type { AtsAdapter } from "./adapter";
import type { PageContext } from "./adapter";

export type ChallengeOutcome = "clear" | "blocked";

/** If a human challenge is present, block: pause and surface the browser to the human. */
export async function resolveHumanChallenge(
  adapter: AtsAdapter,
  ctx: PageContext
): Promise<ChallengeOutcome> {
  return (await adapter.hasHumanChallenge(ctx)) ? "blocked" : "clear";
}
