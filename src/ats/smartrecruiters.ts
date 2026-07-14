// src/ats/smartrecruiters.ts
//
// SmartRecruiters apply forms (jobs.smartrecruiters.com/<company>/<id> and careers-page embeds).
// SmartRecruiters renders the application form client-side with standard HTML inputs, so — like
// Ashby — we wait for hydration and then reuse the proven generic field engine from GreenhouseAdapter.
//
// HONEST-BY-CONSTRUCTION: the engine prefills only the fields it can confidently map (identity,
// work-auth Yes/No, screening) and PAUSES everything it can't (custom widgets, unmapped questions),
// exactly like the other real adapters. The human always reviews and clicks submit — so promoting
// SmartRecruiters to `supported_form_fill` means "ApplyPilot can prefill this for your review",
// which is true; it never claims to complete or submit a form unattended.

import { GreenhouseAdapter } from "./greenhouse";
import { pwPage } from "./page-context";
import type { FormField, PageContext } from "./adapter";

export class SmartRecruitersAdapter extends GreenhouseAdapter {
  readonly name = "smartrecruiters";

  async detect(ctx: PageContext): Promise<boolean> {
    const page = pwPage(ctx);
    try {
      if (/(?:^|\.)smartrecruiters\.com$/i.test(new URL(page.url()).host)) return true;
    } catch {
      /* file:// etc. */
    }
    // Embedded on an employer career page: SmartRecruiters tags its widget/DOM distinctively.
    return page.evaluate(() =>
      Boolean(
        document.querySelector(
          '[data-ats="smartrecruiters"], [class*="smartrecruiters" i], [id*="smartrecruiters" i], [class*="sr-application" i], [data-test-id*="application" i][class*="sr" i]'
        )
      )
    );
  }

  override async getFields(ctx: PageContext): Promise<FormField[]> {
    // Let the client-rendered form hydrate before reading it.
    await pwPage(ctx).waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return super.getFields(ctx);
  }
}
