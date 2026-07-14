// src/ats/workday-dom.ts
//
// PURE navigation logic for the Workday multi-step wizard — the safety-critical decision of which
// button ADVANCES a step ("Save and Continue" / "Next") vs. which SUBMITS the whole application
// ("Submit"), and whether the current page is the final (Review) step. Kept out of the in-page
// scraper so it is unit-testable without a browser: WorkdayAdapter scrapes the visible buttons into
// {ref, text} pairs in-page, then these pure functions pick the right control.
//
// Getting this wrong is a mis-submission, so the rules are conservative: a control is only an
// "advance" if it clearly says continue/next (and is NOT a submit/back), and a page is only "final"
// when a Submit is present AND there is no advance control to move forward with.

export interface WorkdayButton {
  ref: string;
  text: string;
}

const ADVANCE_RE = /\b(save (and|&) continue|continue|next|proceed)\b/;
const SUBMIT_RE = /\bsubmit\b/;
const BACK_RE = /\b(back|previous|cancel)\b/;

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A "Save and Continue" / "Next" control that moves to the next step — never a submit or a back. */
export function isAdvanceButton(text: string): boolean {
  const t = norm(text);
  return ADVANCE_RE.test(t) && !SUBMIT_RE.test(t) && !BACK_RE.test(t);
}

/** The final "Submit" control that sends the whole application. */
export function isSubmitButton(text: string): boolean {
  const t = norm(text);
  return SUBMIT_RE.test(t) && !BACK_RE.test(t);
}

export function selectAdvanceControl(buttons: WorkdayButton[]): { ref: string } | null {
  const hit = buttons.find((b) => isAdvanceButton(b.text));
  return hit ? { ref: hit.ref } : null;
}

export function selectSubmitControl(buttons: WorkdayButton[]): { ref: string } | null {
  const hit = buttons.find((b) => isSubmitButton(b.text));
  return hit ? { ref: hit.ref } : null;
}

/**
 * Final step = a Submit control is present AND there is no advance control. Requiring the absence of
 * an advance control avoids treating an intermediate page as final if it happens to carry both.
 */
export function isFinalStepFromButtons(buttons: WorkdayButton[]): boolean {
  return Boolean(selectSubmitControl(buttons)) && !selectAdvanceControl(buttons);
}
