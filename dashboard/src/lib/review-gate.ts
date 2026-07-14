// The human-review workspace's pure display logic (extracted from ApplyReviewWorkspace, commercial
// M10). Safety-relevant framing: ApplyPilot never clicks Submit — the final click is the user's on the
// employer's real page. These helpers only decide what the rail SAYS. Whether one-click submit is
// actually ready (`readyForOneClickSubmit`) is computed server-side (serializeGate in src/server/api.ts);
// the client just reflects it, so there is intentionally no client-side "submit allowed" gate here.
import type { ApplyGate } from "../data";

/** The gate needs a human browser step first when the site shows a challenge or an account wall. */
export function needsBrowserStep(
  gate: Pick<ApplyGate, "challengeDetected" | "accountAction">
): boolean {
  return gate.challengeDetected || Boolean(gate.accountAction);
}

/** The footer's plain-language "what to do next" note. `pageWord` is "panel" or "browser window". */
export function reviewReadyNote(
  gate: Pick<ApplyGate, "readyForOneClickSubmit" | "challengeDetected" | "accountAction">,
  pageWord: string
): string {
  if (gate.readyForOneClickSubmit) {
    return `Everything checks out — click Submit on the employer page (in the ${pageWord}), then record it here.`;
  }
  if (needsBrowserStep(gate)) {
    return `Finish the step in the ${pageWord}, then check again.`;
  }
  return "Resolve the items above (here or directly on the page) before you submit.";
}

/** Render a filled/flagged field value: em-dash for empty, comma-joined for multi-select. */
export function fmtApplyValue(v: string | string[] | null): string {
  if (v == null || v === "") return "—";
  return Array.isArray(v) ? v.join(", ") : v;
}
