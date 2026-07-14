// src/ats/workday.ts
//
// Workday apply adapter — multi-step wizard support (EXPERIMENTAL, gated OFF; see
// docs/workday-integration.md Phase 2).
//
// Workday (*.myworkdayjobs.com / *.myworkdaysite.com) is a 5-8 page wizard (My Information ->
// My Experience -> Application Questions -> Voluntary Disclosures -> Self-Identify -> Review ->
// Submit). This adapter reuses the proven Greenhouse field engine (getFields/setField/readField/
// hasHumanChallenge) for the standard inputs/labels a Workday page uses, and adds the
// Workday-specific, safety-critical part: MULTI-STEP NAVIGATION. The step loop
// (fillMultiStepApplication) fills a page, then — confidence-gated — advances only if the page is
// clean, stopping at the final Review step for the human to submit.
//
// Which button advances vs. submits is decided by the PURE, unit-tested helpers in workday-dom.ts;
// this file only scrapes the visible buttons in-page and delegates the decision. Greenhouse's
// findSubmitControl only matches "submit"/"apply", so an intermediate "Save and Continue" page
// yields NO submit control — the review gate then blocks a premature one-click submit, by design.
//
// GATING: `workday` is DELIBERATELY still absent from FORM_FILL_SUPPORTED_ATS
// (src/discovery/apply-capability.ts), so Workday jobs stay `manual_open_only` and this engine does
// not run in the product apply path. The DOM enumeration/fill cannot be verified in this environment
// (no browser), so it is EXPERIMENTAL: the allowlist flip is gated on a live logged-in run + passing
// multi-page fixture tests. Human-submit-only (submit-readiness) and the confidence-gated advance
// remain in force regardless, so an unverified fill can never submit unattended.

import { GreenhouseAdapter } from "./greenhouse";
import { pwPage } from "./page-context";
import type { FormField, MultiStepAtsAdapter, PageContext } from "./adapter";
import {
  isFinalStepFromButtons,
  selectAdvanceControl,
  selectSubmitControl,
  type WorkdayButton,
} from "./workday-dom";

/**
 * Workday tenants are always served from these two apex domains (mirrors the host check in
 * src/discovery/workday-board.ts). Requires a dot/start boundary + end anchor so look-alikes like
 * `notmyworkdayjobs.com` or `myworkdayjobs.com.evil.example` do NOT match.
 */
export function isWorkdayHost(url: string): boolean {
  try {
    return /(?:^|\.)(myworkdayjobs\.com|myworkdaysite\.com)$/i.test(new URL(url).host);
  } catch {
    return false; // file:// etc. — not a parseable URL.
  }
}

/** In-page: tag every visible button/submit control and return {ref, text}. Self-contained so it can
 * be serialized into page.evaluate. */
function collectWorkdayButtons(): { ref: string; text: string }[] {
  const norm = (s: string | null) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el: Element) => {
    const s = window.getComputedStyle(el as HTMLElement);
    return s.display !== "none" && s.visibility !== "hidden";
  };
  const els = Array.from(
    document.querySelectorAll('button, input[type="submit"], [role="button"]')
  ).filter(visible);
  const out: { ref: string; text: string }[] = [];
  let i = 0;
  for (const el of els) {
    const text = norm(el.textContent) || norm(el.getAttribute("value")) || norm(el.getAttribute("aria-label"));
    if (!text) continue;
    let r = el.getAttribute("data-ap-wd");
    if (!r) {
      r = "wd-btn-" + i++;
      el.setAttribute("data-ap-wd", r);
    }
    out.push({ ref: r, text });
  }
  return out;
}

const wdButtonSelector = (ref: string) => `[data-ap-wd="${ref.replace(/["\\]/g, "\\$&")}"]`;

export class WorkdayAdapter extends GreenhouseAdapter implements MultiStepAtsAdapter {
  readonly name = "workday";

  async detect(ctx: PageContext): Promise<boolean> {
    const page = pwPage(ctx);
    if (isWorkdayHost(page.url())) return true;
    // Embedded on an employer career page: Workday drives its entire UI with data-automation-id
    // attributes. Key off apply-specific ones — unambiguously Workday, no other ATS uses them.
    return page.evaluate(() =>
      Boolean(
        document.querySelector(
          '[data-automation-id="applyManually"], [data-automation-id="autofillWithResume"], ' +
            '[data-automation-id="legalNameSection"], [data-automation-id="jobPostingHeader"]'
        )
      )
    );
  }

  override async getFields(ctx: PageContext): Promise<FormField[]> {
    // Workday renders each step client-side after an XHR; let it hydrate before enumerating.
    await pwPage(ctx).waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return super.getFields(ctx);
  }

  private async buttons(ctx: PageContext): Promise<WorkdayButton[]> {
    return pwPage(ctx).evaluate(collectWorkdayButtons);
  }

  async findNextControl(ctx: PageContext): Promise<{ ref: string } | null> {
    return selectAdvanceControl(await this.buttons(ctx));
  }

  async isFinalStep(ctx: PageContext): Promise<boolean> {
    return isFinalStepFromButtons(await this.buttons(ctx));
  }

  async advanceStep(ctx: PageContext): Promise<void> {
    const next = await this.findNextControl(ctx);
    if (!next) return; // no advance control -> the step loop treats the page as terminal
    const page = pwPage(ctx);
    await page.locator(wdButtonSelector(next.ref)).click().catch(() => {});
    // Wait for the next step to render/hydrate before the loop re-enumerates.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  }

  // Strict Workday submit: only the final "Submit" control (never "Save and Continue" / "Add").
  // On intermediate steps this returns null, so the review gate blocks a premature one-click submit.
  override async findSubmitControl(ctx: PageContext): Promise<{ ref: string } | null> {
    return selectSubmitControl(await this.buttons(ctx));
  }
}
