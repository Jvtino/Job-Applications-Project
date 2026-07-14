// Human-review workspace display logic (commercial M10). Safety-adjacent: these only decide the rail's
// wording — ApplyPilot never submits — but the "what to do next" note must track the gate honestly.
import { describe, it, expect } from "vitest";
import { needsBrowserStep, reviewReadyNote, fmtApplyValue } from "./review-gate";

describe("needsBrowserStep", () => {
  it("true when a human-verification challenge is present", () => {
    expect(needsBrowserStep({ challengeDetected: true })).toBe(true);
  });
  it("true when the site needs an account action", () => {
    expect(needsBrowserStep({ challengeDetected: false, accountAction: { kind: "sign_in", domain: "acme.com" } })).toBe(true);
  });
  it("false when neither a challenge nor an account wall is present", () => {
    expect(needsBrowserStep({ challengeDetected: false })).toBe(false);
  });
});

describe("reviewReadyNote", () => {
  it("ready-for-one-click wins and names the page word", () => {
    const note = reviewReadyNote({ readyForOneClickSubmit: true, challengeDetected: false }, "panel");
    expect(note).toContain("Everything checks out");
    expect(note).toContain("in the panel");
  });

  it("a required browser step is called out before readiness", () => {
    const note = reviewReadyNote(
      { readyForOneClickSubmit: false, challengeDetected: true },
      "browser window"
    );
    expect(note).toBe("Finish the step in the browser window, then check again.");
  });

  it("otherwise it tells the user to resolve the open items first", () => {
    expect(reviewReadyNote({ readyForOneClickSubmit: false, challengeDetected: false }, "panel")).toBe(
      "Resolve the items above (here or directly on the page) before you submit."
    );
  });
});

describe("fmtApplyValue", () => {
  it("renders an em-dash for empty/null values", () => {
    expect(fmtApplyValue(null)).toBe("—");
    expect(fmtApplyValue("")).toBe("—");
  });
  it("passes a plain string through", () => {
    expect(fmtApplyValue("Remote")).toBe("Remote");
  });
  it("comma-joins a multi-select array", () => {
    expect(fmtApplyValue(["Remote", "Hybrid"])).toBe("Remote, Hybrid");
  });
});
