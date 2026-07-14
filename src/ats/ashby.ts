// src/ats/ashby.ts
//
// Ashby apply forms (jobs.ashbyhq.com/<company>/<uuid>/application). Ashby renders client-side, so
// we wait for hydration before enumerating. Reuses the generic field engine from GreenhouseAdapter.

import { GreenhouseAdapter } from "./greenhouse";
import { pwPage } from "./page-context";
import type { FormField, PageContext } from "./adapter";

export class AshbyAdapter extends GreenhouseAdapter {
  readonly name = "ashby";

  async detect(ctx: PageContext): Promise<boolean> {
    const page = pwPage(ctx);
    try {
      if (/(?:^|\.)ashbyhq\.com$/i.test(new URL(page.url()).host)) return true;
    } catch {
      /* file:// etc. */
    }
    return page.evaluate(() =>
      Boolean(document.querySelector('[data-ats="ashby"], [class*="ashby"], [class*="Ashby"], [id*="ashby"]'))
    );
  }

  override async getFields(ctx: PageContext): Promise<FormField[]> {
    // Let the client-rendered form hydrate before reading it.
    await pwPage(ctx).waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return super.getFields(ctx);
  }
}
