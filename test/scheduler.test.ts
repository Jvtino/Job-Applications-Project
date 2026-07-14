// The 24/7 scheduler's safety guardrails, tested with an injected pass + fake clock (no browser, no
// real timers): the daily ceiling clamps the per-pass cap, the loop skips once the ceiling is hit
// until the 24h window rolls, and shouldStop ends the loop after the current pass.

import { describe, it, expect } from "vitest";
import {
  newSchedulerState,
  planPass,
  recordPass,
  runScheduler,
  WINDOW_MS,
  type ScheduleConfig,
} from "../src/orchestrator/scheduler";
import type { AutopilotRun } from "../src/orchestrator/autopilot";

const cfg: ScheduleConfig = {
  everyMs: 1000,
  mode: "semi_auto",
  liveSubmit: false,
  minScore: 0.5,
  maxPerPass: 3,
  maxPerCompany: 3,
  dailyCeiling: 5,
  jitterMs: 0,
};

/** A canned run that "processed" n jobs (submitted of them). */
function run(n: number, submitted = 0): AutopilotRun {
  return {
    results: Array.from({ length: n }, (_, i) => ({
      company: "C",
      title: "T",
      jobUrl: "u" + i,
      action: "queued" as const,
      reason: "",
    })),
    submitted,
    wouldSubmit: 0,
    queued: n - submitted,
    skipped: 0,
  };
}

describe("scheduler guardrails", () => {
  it("planPass clamps the per-pass cap to the remaining daily ceiling", () => {
    const t0 = 1_000_000;
    let s = newSchedulerState(t0);
    expect(planPass(s, cfg, t0)).toEqual({ run: true, maxTotal: 3 }); // min(perPass 3, ceiling 5)
    s = recordPass(s, run(3), t0);
    expect(planPass(s, cfg, t0)).toEqual({ run: true, maxTotal: 2 }); // remaining 2
  });

  it("planPass stops once the daily ceiling is reached, until the window rolls", () => {
    const t0 = 1_000_000;
    const s = recordPass(newSchedulerState(t0), run(5), t0); // hit the ceiling
    const blocked = planPass(s, cfg, t0);
    expect(blocked.run).toBe(false);
    if (!blocked.run) expect(blocked.reason).toMatch(/ceiling/);
    // 24h later -> the window rolls -> a fresh budget
    expect(planPass(s, cfg, t0 + WINDOW_MS + 1)).toEqual({ run: true, maxTotal: 3 });
  });

  it("recordPass accumulates processed + submitted and rolls the window after 24h", () => {
    const t0 = 1_000_000;
    let s = recordPass(newSchedulerState(t0), run(3, 1), t0);
    expect(s.processedInWindow).toBe(3);
    expect(s.submittedInWindow).toBe(1);
    s = recordPass(s, run(2, 2), t0 + WINDOW_MS + 1); // rolls
    expect(s.processedInWindow).toBe(2);
    expect(s.submittedInWindow).toBe(2);
    expect(s.windowStartMs).toBe(t0 + WINDOW_MS + 1);
  });

  it("runScheduler runs passes, clamps to remaining, and skips once the ceiling is hit", async () => {
    const calls: number[] = [];
    let clock = 1_000_000;
    const state = await runScheduler(cfg, {
      runPass: async (maxTotal) => {
        calls.push(maxTotal);
        return run(maxTotal);
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      maxIterations: 3,
      rng: () => 0,
    });
    expect(calls).toEqual([3, 2]); // pass1 cap 3, pass2 clamped to remaining 2, pass3 skipped
    expect(state.processedInWindow).toBe(5);
    expect(state.passes).toBe(2);
  });

  it("A8: a pass that throws is recorded and the loop continues to the next pass", async () => {
    const attempts: number[] = [];
    let clock = 1_000_000;
    const state = await runScheduler(cfg, {
      runPass: async (maxTotal) => {
        attempts.push(maxTotal);
        if (attempts.length === 1) throw new Error("synthetic browser startup failure");
        return run(2);
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      maxIterations: 2,
      rng: () => 0,
    });
    // Both passes were attempted (the throw did not kill the loop).
    expect(attempts).toHaveLength(2);
    expect(state.failedPasses).toBe(1);
    expect(state.passes).toBe(1); // only the successful pass counted
    // The failed pass did NOT pollute the daily-cap counters.
    expect(state.processedInWindow).toBe(2);
  });

  it("runScheduler stops after the current pass when shouldStop flips", async () => {
    const calls: number[] = [];
    let stop = false;
    await runScheduler(cfg, {
      runPass: async (m) => {
        calls.push(m);
        stop = true; // simulate Ctrl-C during the pass
        return run(m);
      },
      now: () => 1_000_000,
      sleep: async () => {},
      shouldStop: () => stop,
      maxIterations: 99,
    });
    expect(calls).toHaveLength(1); // one pass ran, then the loop broke before the next
  });
});
