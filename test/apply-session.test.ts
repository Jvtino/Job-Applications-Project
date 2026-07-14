import { describe, it, expect } from "vitest";
import { submitBlocker } from "../src/orchestrator/apply-session";
import type { ReviewGate } from "../src/orchestrator/review-gate";

function gate(overrides: Partial<ReviewGate>): ReviewGate {
  return {
    url: "https://job-boards.greenhouse.io/acme/jobs/1",
    ats: "greenhouse",
    mode: "semi_auto",
    filled: [],
    flaggedForReview: [],
    needsConfirmation: [],
    attachedDocuments: [],
    challengeDetected: false,
    submitControlRef: "apf-submit",
    readyForOneClickSubmit: true,
    ...overrides,
  } as unknown as ReviewGate;
}

describe("submitBlocker — the irreversible-submit safety gate", () => {
  it("allows submit when nothing blocks it", () => {
    expect(submitBlocker(gate({}))).toBeNull();
  });

  it("blocks when a human-verification challenge is present", () => {
    expect(submitBlocker(gate({ challengeDetected: true }))).toMatch(/challenge/i);
  });

  it("blocks when the site needs an account/login", () => {
    const g = gate({ accountAction: { kind: "login", domain: "acme.com", prefilled: [], passwordOnClipboard: false } as never });
    expect(submitBlocker(g)).toMatch(/login|account/i);
  });

  it("blocks when ANY field still needs the user's input", () => {
    const g = gate({ needsConfirmation: [{ field: { label: "Race" } }] as never });
    expect(submitBlocker(g)).toMatch(/input/i);
  });

  it("blocks when the submit control wasn't located", () => {
    const g = gate({ submitControlRef: undefined });
    expect(submitBlocker(g)).toMatch(/submit button/i);
  });

  it("blocks when the generated documents failed the truth check", () => {
    const g = gate({ ledgerCheck: { passed: false, checks: [] } as never });
    expect(submitBlocker(g)).toMatch(/truth check/i);
  });

  it("allows submit when the ledger check passed", () => {
    const g = gate({ ledgerCheck: { passed: true, checks: [] } as never });
    expect(submitBlocker(g)).toBeNull();
  });

  it("reports challenge before missing input (challenge is the hardest blocker)", () => {
    const g = gate({ challengeDetected: true, needsConfirmation: [{ field: { label: "X" } }] as never });
    expect(submitBlocker(g)).toMatch(/challenge/i);
  });
});
