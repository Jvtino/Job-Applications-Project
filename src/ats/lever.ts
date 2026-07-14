// src/ats/lever.ts
//
// Lever apply forms (jobs.lever.co/<company>/<id>/apply). Reuses the generic labeled-field engine
// from GreenhouseAdapter; only detection differs.

import { GreenhouseAdapter } from "./greenhouse";
import { pwPage } from "./page-context";
import type { PageContext } from "./adapter";

export class LeverAdapter extends GreenhouseAdapter {
  readonly name = "lever";

  async detect(ctx: PageContext): Promise<boolean> {
    const page = pwPage(ctx);
    try {
      if (/(?:^|\.)lever\.co$/i.test(new URL(page.url()).host)) return true;
    } catch {
      /* file:// etc. */
    }
    // Lever-SPECIFIC markers only. The generic ".application-form" / "[data-qa=application-form]" /
    // "[class*=lever]" (matches "clever", "deliver"…) selectors were dropped: now that pickAdapter
    // tries Lever before Greenhouse, those generics would let Lever claim a plain or Greenhouse-
    // embedded form and mislabel it "lever" — and a mislabel to an auto-submit-allowlisted ATS can
    // defeat the generic-fallback queue-only safety. Real Lever forms live on a lever.co host (caught
    // above) or carry one of these markers; anything else falls through to the generic fallback.
    return page.evaluate(() =>
      Boolean(document.querySelector('[data-ats="lever"], form[action*="lever.co"]'))
    );
  }
}
