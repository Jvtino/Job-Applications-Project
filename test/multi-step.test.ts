// Multi-step wizard engine (src/ats/multi-step.ts) — pure control-flow coverage with a scripted
// adapter + a fake matcher, so the step loop is verified end-to-end WITHOUT a browser (the sandbox
// can't launch Chromium, and this logic is browser-independent anyway). Proves the safety
// invariants: confidence-gated advance (never advance past a page that needs a human), mid-wizard
// challenge handling, per-page step tagging, and the runaway step cap.

import { describe, it, expect } from "vitest";
import {
  isMultiStep,
  type FieldMatcher,
  type FormField,
  type MatchResult,
  type MultiStepAtsAdapter,
  type PageContext,
} from "../src/ats/adapter";
import { fillMultiStepApplication } from "../src/ats/multi-step";
import { GreenhouseAdapter } from "../src/ats/greenhouse";
import { WorkdayAdapter } from "../src/ats/workday";
import { createBlankProfile } from "../src/profile/factory";

// A matcher that fills any field with "value" — EXCEPT a field whose label contains UNMAPPED, which
// resolves to null so a required one pauses (needsConfirmation). Decouples the loop test from the
// real LayeredFieldMatcher: we drive fill-vs-pause purely by field label.
const scriptedMatcher: FieldMatcher = {
  classifyRisk: () => "identity",
  async match(field: FormField): Promise<MatchResult> {
    const unmapped = /UNMAPPED/.test(field.label);
    return {
      field,
      risk: "identity",
      resolvedValue: unmapped ? null : "value",
      source: "user",
      method: unmapped ? "unmapped" : "exact",
      confidence: 1,
      rationale: "",
    };
  },
};

interface ScriptPage {
  fields: FormField[];
  isFinal?: boolean;
  hasNext?: boolean;
  challenge?: boolean;
}

class ScriptedMultiStepAdapter implements MultiStepAtsAdapter {
  readonly name = "scripted";
  step = 0;
  advanceCalls = 0;
  private store = new Map<string, string | string[]>();

  constructor(private pages: ScriptPage[]) {}
  private page(): ScriptPage {
    return this.pages[Math.min(this.step, this.pages.length - 1)]!;
  }

  async detect(): Promise<boolean> {
    return true;
  }
  async getFields(): Promise<FormField[]> {
    return this.page().fields;
  }
  async setField(_ctx: PageContext, field: FormField, value: string | string[]): Promise<void> {
    this.store.set(field.ref, value); // so readField below makes readback pass -> counts as filled
  }
  async readField(_ctx: PageContext, field: FormField): Promise<string | string[] | null> {
    return this.store.get(field.ref) ?? null;
  }
  async findSubmitControl(): Promise<{ ref: string } | null> {
    return this.page().isFinal ? { ref: "submit" } : null;
  }
  async hasHumanChallenge(): Promise<boolean> {
    return this.page().challenge ?? false;
  }
  async findNextControl(): Promise<{ ref: string } | null> {
    return this.page().hasNext ? { ref: "next" } : null;
  }
  async isFinalStep(): Promise<boolean> {
    return this.page().isFinal ?? false;
  }
  async advanceStep(): Promise<void> {
    this.advanceCalls++;
    this.step++;
  }
}

const field = (label: string, ref: string, over: Partial<FormField> = {}): FormField => ({
  ref,
  label,
  controlType: "text",
  required: false,
  ...over,
});

const ctx = {} as PageContext;
const profile = createBlankProfile("multi-step");
const run = (adapter: ScriptedMultiStepAdapter, maxSteps?: number) =>
  fillMultiStepApplication(adapter, scriptedMatcher, ctx, profile, "semi_auto", maxSteps ? { maxSteps } : {});

describe("isMultiStep guard", () => {
  it("is true only for adapters that implement the wizard navigation methods", () => {
    expect(isMultiStep(new ScriptedMultiStepAdapter([]))).toBe(true);
    expect(isMultiStep(new GreenhouseAdapter())).toBe(false);
    // Single-page adapters (Lever/Ashby/SmartRecruiters subclass Greenhouse) stay single-page.
    // Workday implements the wizard contract as of Phase 2.
    expect(isMultiStep(new WorkdayAdapter())).toBe(true);
  });
});

describe("fillMultiStepApplication", () => {
  it("fills every clean step, stops at the final step, and tags each field with its page", async () => {
    const adapter = new ScriptedMultiStepAdapter([
      { fields: [field("Email", "p0-email")], hasNext: true },
      { fields: [field("Phone", "p1-phone")], hasNext: true },
      { fields: [field("Confirm", "p2-confirm")], isFinal: true },
    ]);
    const r = await run(adapter);

    expect(r.stopReason).toBe("final_step");
    expect(r.stepsVisited).toBe(3);
    expect(r.filled.map((m) => m.field.label)).toEqual(["Email", "Phone", "Confirm"]);
    expect(r.filled.map((m) => m.field.step)).toEqual([0, 1, 2]);
    expect(r.needsConfirmation).toHaveLength(0);
    expect(adapter.advanceCalls).toBe(2); // advanced p0->p1->p2, never past the final step
  });

  it("STOPS at the first page needing a human and never advances past it (confidence-gated)", async () => {
    const adapter = new ScriptedMultiStepAdapter([
      { fields: [field("Email", "p0-email")], hasNext: true },
      { fields: [field("UNMAPPED reason", "p1-x", { required: true })], hasNext: true },
      { fields: [field("Never reached", "p2-never")], isFinal: true },
    ]);
    const r = await run(adapter);

    expect(r.stopReason).toBe("needs_confirmation");
    expect(r.stepsVisited).toBe(2);
    expect(r.needsConfirmation).toHaveLength(1);
    expect(r.needsConfirmation[0]!.field.step).toBe(1);
    expect(r.filled.map((m) => m.field.label)).toEqual(["Email"]);
    expect(adapter.step).toBe(1); // never advanced to the final page
    expect(adapter.advanceCalls).toBe(1);
  });

  it("STOPS on a mid-wizard challenge / login wall and hands off", async () => {
    const adapter = new ScriptedMultiStepAdapter([
      { fields: [field("Email", "p0-email")], hasNext: true },
      { fields: [field("hidden", "p1")], challenge: true, hasNext: true },
      { fields: [field("Never reached", "p2")], isFinal: true },
    ]);
    const r = await run(adapter);

    expect(r.stopReason).toBe("challenge");
    expect(r.challengeDetected).toBe(true);
    expect(r.stepsVisited).toBe(2);
    expect(adapter.step).toBe(1);
  });

  it("stops when a non-final page has no advance control", async () => {
    const adapter = new ScriptedMultiStepAdapter([
      { fields: [field("Only", "p0")], isFinal: false, hasNext: false },
    ]);
    const r = await run(adapter);

    expect(r.stopReason).toBe("no_advance_control");
    expect(r.stepsVisited).toBe(1);
    expect(adapter.advanceCalls).toBe(0);
  });

  it("handles a single-page wizard whose only page is the final step", async () => {
    const adapter = new ScriptedMultiStepAdapter([{ fields: [field("Only", "p0")], isFinal: true }]);
    const r = await run(adapter);

    expect(r.stopReason).toBe("final_step");
    expect(r.stepsVisited).toBe(1);
    expect(adapter.advanceCalls).toBe(0);
  });

  it("backstops a runaway flow that never reaches a final step with the step cap", async () => {
    // Every page has a next control and none is final -> only the cap can stop it.
    const pages = Array.from({ length: 6 }, (_, i) => ({ fields: [field(`F${i}`, `p${i}`)], hasNext: true }));
    const adapter = new ScriptedMultiStepAdapter(pages);
    const r = await run(adapter, 3);

    expect(r.stopReason).toBe("max_steps");
    expect(r.stepsVisited).toBe(3);
    expect(adapter.advanceCalls).toBe(3);
  });

  it("paces each field fill and each step advance (human-like, not instant)", async () => {
    let paceCalls = 0;
    const adapter = new ScriptedMultiStepAdapter([
      { fields: [field("Email", "p0-email")], hasNext: true },
      { fields: [field("Phone", "p1-phone")], hasNext: true },
      { fields: [field("Confirm", "p2-confirm")], isFinal: true },
    ]);
    await fillMultiStepApplication(adapter, scriptedMatcher, ctx, profile, "semi_auto", {
      pace: async () => {
        paceCalls++;
      },
    });
    // 3 fields filled (one pause before each) + 2 advances (one pause before each Save & Continue) = 5.
    expect(paceCalls).toBe(5);
    expect(adapter.advanceCalls).toBe(2);
  });

  it("never submits — it only fills and stops (submit stays a human action)", async () => {
    // The engine has no path that clicks a submit control; it returns a report for the review gate.
    const adapter = new ScriptedMultiStepAdapter([{ fields: [field("Only", "p0")], isFinal: true }]);
    const r = await run(adapter);
    expect(r).not.toHaveProperty("submitted");
    // findSubmitControl is located by the orchestrator AFTER this returns — the engine never calls it.
  });
});
