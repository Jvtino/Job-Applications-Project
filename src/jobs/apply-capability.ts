// src/jobs/apply-capability.ts
//
// THE discovery→apply contract. Discovery is broad (dozens of sources); the form-fill automation is
// narrow (only the ATSes with a real, fixture-tested apply adapter). Every discovered job must be
// classified BEFORE it can reach the fill pipeline, so the app is honest about what it can automate
// instead of routing everything into the generic fallback and failing quietly:
//
//   - "supported_form_fill" — a real apply adapter exists for this ATS; automated prefill is allowed.
//   - "manual_open_only"    — a real posting worth reviewing, but the app only opens it for the user.
//   - "unsupported"         — not an individual application page at all; no automation, no open button.
//
// Only supported_form_fill jobs may enter the automated prefill path (in-app apply session, autopilot,
// automation cycle). Everything else must be surfaced with its reason, never silently degraded.

import type { AtsType } from "./types";
import { checkEmployerJobUrl } from "./job-url";
import { sourceForUrl } from "./source-catalog";

export type ApplyCapability = "supported_form_fill" | "manual_open_only" | "unsupported";

/**
 * ATSes with a first-class, fixture-tested apply adapter (src/ats/greenhouse|lever|ashby). The
 * generic fallback is NOT a capability — it exists so an unexpected form pauses safely, not so
 * every job source can pretend to be automatable. Growing this set requires a real adapter + tests.
 *
 * `workday` is EXPERIMENTAL: its multi-step DOM engine (src/ats/workday.ts) is enabled here for live
 * testing but has NOT been validated against a real page. It is safe to enable because the
 * downstream guardrails still hold regardless of this flag — Workday is pinned human-submit-only
 * (submit-readiness) so it can never auto-submit, and the confidence-gated multi-step loop pauses on
 * any field it can't map. See docs/workday-integration.md.
 */
export const FORM_FILL_SUPPORTED_ATS: ReadonlySet<AtsType> = new Set<AtsType>([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workday",
]);

export interface ApplyCapabilityCheck {
  capability: ApplyCapability;
  /** The matched source id when the URL belongs to a known source. */
  atsType?: AtsType;
  /** Human-readable, plain-language explanation shown in the UI and skip logs. */
  reason: string;
}

/** True when the URL points at the developer's own machine (test fixtures, local demo forms). */
function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Classify a job URL for the apply pipeline. Pure + synchronous so it can run everywhere a job is
 * displayed or selected (API payloads, dashboard rows, autopilot selection, the apply endpoint).
 */
export function classifyApplyCapability(rawUrl: string | undefined | null): ApplyCapabilityCheck {
  const value = (rawUrl ?? "").trim();

  // Local fixture/demo pages (tests, `npm run apply` against a served fixture) are the developer's
  // own forms — fillable by definition and unreachable from real discovery.
  if (value && isLoopbackUrl(value)) {
    return { capability: "supported_form_fill", reason: "Local test page." };
  }

  const check = checkEmployerJobUrl(value);

  if (!check.ok) {
    // Known source, but a board root / search page — there is no application form to open or fill.
    if (check.atsType) {
      return {
        capability: "unsupported",
        atsType: check.atsType,
        reason: `Not an individual job posting — this looks like a ${sourceNameFor(value) ?? check.atsType} board or search page.`,
      };
    }
    // Unknown host with a plausible http(s) URL: the user can still open and apply by hand.
    if (check.reason === "unsupported employer ATS URL") {
      return {
        capability: "manual_open_only",
        reason: "Unrecognized application system — ApplyPilot can open the page, but you fill and submit it yourself.",
      };
    }
    // Missing/blank/invalid URL: nothing to open at all.
    return { capability: "unsupported", reason: `No usable application link (${check.reason ?? "invalid URL"}).` };
  }

  const atsType = check.atsType!;
  if (FORM_FILL_SUPPORTED_ATS.has(atsType)) {
    const experimental = atsType === "workday" ? " (experimental multi-step fill — review every page carefully)" : "";
    return {
      capability: "supported_form_fill",
      atsType,
      reason: `${sourceNameFor(value) ?? atsType} posting — ApplyPilot can prefill this application for your review.${experimental}`,
    };
  }
  return {
    capability: "manual_open_only",
    atsType,
    reason: `${sourceNameFor(value) ?? atsType} doesn't have a form-fill adapter — open it and apply manually.`,
  };
}

/** True only for jobs the automated prefill path may touch. */
export function isFormFillSupported(rawUrl: string | undefined | null): boolean {
  return classifyApplyCapability(rawUrl).capability === "supported_form_fill";
}

function sourceNameFor(raw: string): string | undefined {
  try {
    return sourceForUrl(new URL(raw))?.name;
  } catch {
    return undefined;
  }
}
