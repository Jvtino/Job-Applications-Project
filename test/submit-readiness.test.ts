import { describe, it, expect } from "vitest";
import { coreSubmitBlockers, readyForHumanSubmit, decideAutoSubmit } from "../src/orchestrator/submit-readiness";

describe("submit-readiness", () => {
  const open = {
    challengeDetected: false,
    needsConfirmation: [] as unknown[],
    submitControlRef: "btn",
  };

  it("allows flagged fields for human and known-adapter auto submit", () => {
    const gate = { ...open, flaggedForReview: [{}] };
    expect(readyForHumanSubmit(gate)).toBe(true);
    expect(
      decideAutoSubmit({
        mode: "auto",
        employerApproved: true,
        liveSubmit: true,
        challengeDetected: false,
        needsConfirmationCount: 0,
        flaggedCount: 1,
        hasLedgerCheck: false,
        ledgerPassed: true,
        submitControlRef: "btn",
        ats: "greenhouse",
      }).action
    ).toBe("submit");
  });

  it("never auto-submits unknown generic fallback forms", () => {
    const decision = decideAutoSubmit({
      mode: "auto",
      employerApproved: true,
      liveSubmit: true,
      challengeDetected: false,
      needsConfirmationCount: 0,
      flaggedCount: 0,
      hasLedgerCheck: false,
      ledgerPassed: true,
      submitControlRef: "btn",
      ats: "generic",
    });
    expect(decision.action).toBe("queue");
    expect(decision.reason).toMatch(/unknown form/i);
  });

  it("blocks on needsConfirmation and ledger failure", () => {
    expect(coreSubmitBlockers({ ...open, needsConfirmation: [{}] })).toMatch(/confirmation/);
    expect(coreSubmitBlockers({ ...open, ledgerCheck: { passed: false } })).toMatch(/ledger/);
  });

  it("NEVER auto-submits a Tier A target, even when every other gate is green", () => {
    const allGreen = {
      mode: "auto" as const,
      employerApproved: true,
      liveSubmit: true,
      challengeDetected: false,
      needsConfirmationCount: 0,
      flaggedCount: 0,
      hasLedgerCheck: true,
      ledgerPassed: true,
      submitControlRef: "btn",
      ats: "greenhouse",
    };
    // Sanity: without a tier this same input would submit.
    expect(decideAutoSubmit(allGreen).action).toBe("submit");
    // Tier A is held back regardless.
    const a = decideAutoSubmit({ ...allGreen, tier: "A" });
    expect(a.action).toBe("queue");
    expect(a.reason).toMatch(/Tier A/);
    // Tiers B and C do not change the auto path.
    expect(decideAutoSubmit({ ...allGreen, tier: "B" }).action).toBe("submit");
    expect(decideAutoSubmit({ ...allGreen, tier: "C" }).action).toBe("submit");
  });

  it("NEVER auto-submits a Workday application, even when every other gate is green", () => {
    // Workday is a named adapter, so it clears the generic-only guard — it must be pinned to
    // human-submit-only explicitly (multi-step wizard + mandatory per-tenant account).
    const allGreen = {
      mode: "auto" as const,
      employerApproved: true,
      liveSubmit: true,
      challengeDetected: false,
      needsConfirmationCount: 0,
      flaggedCount: 0,
      hasLedgerCheck: true,
      ledgerPassed: true,
      submitControlRef: "btn",
      ats: "workday",
    };
    const d = decideAutoSubmit(allGreen);
    expect(d.action).toBe("queue");
    expect(d.reason).toMatch(/Workday/i);
  });
});
