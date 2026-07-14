import { describe, it, expect } from "vitest";
import { computeLiveActivity, parseCurrentItem } from "../src/server/live-activity";

describe("parseCurrentItem", () => {
  it("extracts role + company from a filling label", () => {
    expect(parseCurrentItem("Automation Application: filling Staff Engineer @ Ramp (78% fit)…")).toEqual({
      role: "Staff Engineer",
      company: "Ramp",
    });
  });
  it("extracts from a tailoring label", () => {
    expect(parseCurrentItem("Automation Application: tailoring documents for AML Analyst @ Brex…")).toEqual({
      role: "AML Analyst",
      company: "Brex",
    });
  });
  it("returns nulls when there is no role @ company", () => {
    expect(parseCurrentItem("Automation Discovery: scanning company boards")).toEqual({ role: null, company: null });
  });
});

describe("computeLiveActivity", () => {
  it("is idle with no inputs (never fabricates active state)", () => {
    const a = computeLiveActivity({});
    expect(a.active).toBe(false);
    expect(a.kind).toBe("idle");
    expect(a.source).toBe("none");
  });

  it("prioritizes an open apply session over everything", () => {
    const a = computeLiveActivity({
      applySession: { company: "Ramp", title: "Staff Engineer", startedAt: "2026-06-27T10:00:00Z", needsInput: true, ready: false },
      progress: { status: "discovering", currentStepLabel: "scanning", startedAt: "2026-06-27T09:00:00Z", percentComplete: 20, completedAt: null },
      discovery: { running: true, message: "searching", startedAt: null },
    });
    expect(a.source).toBe("apply_session");
    expect(a.active).toBe(true);
    expect(a.company).toBe("Ramp");
    expect(a.role).toBe("Staff Engineer");
    expect(a.stageLabel).toBe("Needs your input");
  });

  it("reflects an in-flight automation pass that is filling a form", () => {
    const a = computeLiveActivity({
      progress: {
        status: "applying",
        currentStepLabel: "Automation Application: filling Staff Engineer @ Ramp (78% fit)…",
        startedAt: "2026-06-27T10:00:00Z",
        percentComplete: 66,
        completedAt: null,
      },
    });
    expect(a.source).toBe("automation_pass");
    expect(a.kind).toBe("filling");
    expect(a.company).toBe("Ramp");
    expect(a.percent).toBe(66);
  });

  it("does NOT report active once the pass has completed", () => {
    const a = computeLiveActivity({
      progress: {
        status: "applying",
        currentStepLabel: "done",
        startedAt: "2026-06-27T10:00:00Z",
        percentComplete: 100,
        completedAt: "2026-06-27T10:05:00Z",
      },
      discovery: { running: false, message: "", startedAt: null },
    });
    expect(a.active).toBe(false);
    expect(a.kind).toBe("idle");
  });

  it("falls back to a standalone discovery pass", () => {
    const a = computeLiveActivity({
      discovery: { running: true, message: "Searching Ramp", startedAt: "2026-06-27T10:00:00Z" },
    });
    expect(a.source).toBe("discovery");
    expect(a.kind).toBe("discovering");
    expect(a.active).toBe(true);
  });
});
