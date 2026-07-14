// Workday multi-step navigation logic (src/ats/workday-dom.ts) — the safety-critical decision of
// which button advances a step vs. submits the application. Pure functions, verified without a
// browser against the button labels a real Workday wizard renders per step (Back / Save and
// Continue on inner steps; Back / Submit on the Review step).

import { describe, it, expect } from "vitest";
import {
  isAdvanceButton,
  isSubmitButton,
  selectAdvanceControl,
  selectSubmitControl,
  isFinalStepFromButtons,
  type WorkdayButton,
} from "../src/ats/workday-dom";

const btns = (...texts: string[]): WorkdayButton[] => texts.map((text, i) => ({ ref: `wd-btn-${i}`, text }));

describe("isAdvanceButton / isSubmitButton", () => {
  it("recognizes advance controls and never confuses them with submit/back", () => {
    for (const t of ["Save and Continue", "Save & Continue", "Continue", "Next", "Proceed"]) {
      expect(isAdvanceButton(t), t).toBe(true);
      expect(isSubmitButton(t), t).toBe(false);
    }
  });

  it("recognizes the submit control and never treats it as advance", () => {
    for (const t of ["Submit", "Submit Application"]) {
      expect(isSubmitButton(t), t).toBe(true);
      expect(isAdvanceButton(t), t).toBe(false);
    }
  });

  it("never selects back / add-another / delete as advance or submit", () => {
    for (const t of ["Back", "Previous", "Cancel", "Add Another", "Add", "Delete", "Remove"]) {
      expect(isAdvanceButton(t), t).toBe(false);
      expect(isSubmitButton(t), t).toBe(false);
    }
  });
});

describe("selectAdvanceControl / selectSubmitControl / isFinalStepFromButtons", () => {
  it("picks the advance control on an inner step (Back + Save and Continue)", () => {
    const b = btns("Back", "Save and Continue");
    expect(selectAdvanceControl(b)?.ref).toBe("wd-btn-1");
    expect(selectSubmitControl(b)).toBeNull();
    expect(isFinalStepFromButtons(b)).toBe(false);
  });

  it("treats the Review step (Back + Submit) as final and finds Submit", () => {
    const b = btns("Back", "Submit");
    expect(selectSubmitControl(b)?.ref).toBe("wd-btn-1");
    expect(selectAdvanceControl(b)).toBeNull();
    expect(isFinalStepFromButtons(b)).toBe(true);
  });

  it("is not final on the first step (Save and Continue only)", () => {
    const b = btns("Save and Continue");
    expect(isFinalStepFromButtons(b)).toBe(false);
  });

  it("does not treat a page with an advance control as final even if a stray Submit exists", () => {
    // Defensive: if both appear, prefer advancing over submitting.
    const b = btns("Back", "Save and Continue", "Submit");
    expect(isFinalStepFromButtons(b)).toBe(false);
  });

  it("returns null / false on a page with no relevant buttons", () => {
    const b = btns("Add Another", "Delete");
    expect(selectAdvanceControl(b)).toBeNull();
    expect(selectSubmitControl(b)).toBeNull();
    expect(isFinalStepFromButtons(b)).toBe(false);
  });
});
