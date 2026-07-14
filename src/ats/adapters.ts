// src/ats/adapters.ts
//
// Picks the right ATS apply adapter for the current page: try the specific adapters in order,
// then fall back to the generic adapter (which always matches and forces human review).

import type { AtsAdapter, PageContext } from "./adapter";
import { GreenhouseAdapter } from "./greenhouse";
import { LeverAdapter } from "./lever";
import { AshbyAdapter } from "./ashby";
import { SmartRecruitersAdapter } from "./smartrecruiters";
import { WorkdayAdapter } from "./workday";
import { GenericFallbackAdapter } from "./generic-fallback";

export async function pickAdapter(ctx: PageContext): Promise<AtsAdapter> {
  // Host-specific adapters (Lever, Ashby) MUST be tried before Greenhouse. Greenhouse's detect()
  // intentionally includes a generic DOM fallback (e.g. a bare #first_name + #email form), which
  // also matches real Lever/Ashby apply forms. Lever/Ashby detect on an unambiguous host
  // (lever.co / ashbyhq.com), so giving them first crack routes those forms correctly instead of
  // letting Greenhouse's generic signature claim them first. This matters for safety: the ATS
  // label drives auto-submit allowlisting in decideAutoSubmit (a mislabeled "greenhouse" form on a
  // pre-approved employer could be auto-submitted instead of routed as Lever).
  // Host-specific adapters (Lever, Ashby, SmartRecruiters, Workday) MUST precede Greenhouse —
  // Greenhouse's detect() has a generic DOM fallback that would otherwise claim their
  // standard-looking forms. Workday detects on an unambiguous host (*.myworkdayjobs.com) + its
  // data-automation-id DOM and drives a multi-step wizard fill. It is in FORM_FILL_SUPPORTED_ATS as
  // EXPERIMENTAL — pinned human-submit-only (submit-readiness) and pausing on any unmappable field.
  // See src/ats/workday.ts + docs/workday-integration.md.
  const specific: AtsAdapter[] = [
    new LeverAdapter(),
    new AshbyAdapter(),
    new SmartRecruitersAdapter(),
    new WorkdayAdapter(),
    new GreenhouseAdapter(),
  ];
  for (const adapter of specific) {
    if (await adapter.detect(ctx)) return adapter;
  }
  return new GenericFallbackAdapter();
}
