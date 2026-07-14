// src/orchestrator/scheduler.ts
//
// The 24/7 scheduler: run an autopilot pass on an interval, bounded by safety guardrails so an
// unattended live run can never become a runaway. Guardrails:
//   - daily ceiling: at most N applications PROCESSED per rolling 24h window (across passes);
//   - per-pass cap + per-company cap: handed straight to runAutopilot;
//   - human pacing: the interval between passes, plus random jitter so passes aren't clockwork.
// Hard dedup in the applications repo independently guarantees a SUBMITTED job is never sent twice,
// even across process restarts. The pass runner, clock, and sleep are injected, so the control
// logic is unit-testable without a real browser or real timers.

import type { OperatingMode } from "../ats/adapter";
import type { AutopilotRun } from "./autopilot";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ScheduleConfig {
  everyMs: number;
  mode: OperatingMode;
  liveSubmit: boolean;
  minScore: number;
  maxPerPass: number;
  maxPerCompany: number;
  dailyCeiling: number;
  jitterMs: number;
}

export interface SchedulerState {
  windowStartMs: number;
  processedInWindow: number;
  submittedInWindow: number;
  passes: number;
  /** Lifetime count of passes that threw (browser/DB/page failures). Never pollutes the daily cap. */
  failedPasses: number;
}

export function newSchedulerState(now: number): SchedulerState {
  return { windowStartMs: now, processedInWindow: 0, submittedInWindow: 0, passes: 0, failedPasses: 0 };
}

/** Reset the counters if the rolling 24h window has elapsed (passes counters are lifetime). */
function rollWindow(state: SchedulerState, now: number): SchedulerState {
  if (now - state.windowStartMs >= WINDOW_MS) {
    return { windowStartMs: now, processedInWindow: 0, submittedInWindow: 0, passes: state.passes, failedPasses: state.failedPasses };
  }
  return state;
}

export type PassPlan = { run: true; maxTotal: number } | { run: false; reason: string };

/** Decide whether to run a pass now, and with what per-pass cap (clamped to the remaining ceiling). */
export function planPass(state: SchedulerState, cfg: ScheduleConfig, now: number): PassPlan {
  const s = rollWindow(state, now);
  const remaining = cfg.dailyCeiling - s.processedInWindow;
  if (remaining <= 0) {
    const resetInMin = Math.max(0, Math.ceil((s.windowStartMs + WINDOW_MS - now) / 60000));
    return { run: false, reason: `daily ceiling ${cfg.dailyCeiling} reached; resets in ~${resetInMin}m` };
  }
  return { run: true, maxTotal: Math.min(cfg.maxPerPass, remaining) };
}

/** Fold a finished pass into the state (rolling the window first if 24h elapsed). */
export function recordPass(state: SchedulerState, run: AutopilotRun, now: number): SchedulerState {
  const s = rollWindow(state, now);
  return {
    windowStartMs: s.windowStartMs,
    processedInWindow: s.processedInWindow + run.results.length,
    submittedInWindow: s.submittedInWindow + run.submitted,
    passes: s.passes + 1,
    failedPasses: s.failedPasses,
  };
}

/**
 * Fold a FAILED pass (runPass threw) into the state. Crucially, it does NOT touch the daily-cap
 * counters (processedInWindow/submittedInWindow) or the successful-pass count — a browser startup
 * error or transient DB/page failure must never consume the day's application budget. It only bumps
 * the diagnostic failedPasses counter (rolling the window first if 24h elapsed).
 */
export function recordFailedPass(state: SchedulerState, now: number): SchedulerState {
  const s = rollWindow(state, now);
  return { ...s, failedPasses: s.failedPasses + 1 };
}

export interface SchedulerDeps {
  /** Run one pass with the given per-pass cap; returns the run summary. */
  runPass: (maxTotal: number) => Promise<AutopilotRun>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Checked at the top of each loop and right after each pass — for graceful Ctrl-C shutdown. */
  shouldStop?: () => boolean;
  /** Stop after this many loop iterations (tests / finite runs). Undefined = run forever. */
  maxIterations?: number;
  /** Deterministic jitter source for tests (default Math.random). */
  rng?: () => number;
}

/** The loop. Runs (or skips) a pass, then sleeps interval + jitter, until shouldStop / maxIterations. */
export async function runScheduler(cfg: ScheduleConfig, deps: SchedulerDeps): Promise<SchedulerState> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = deps.rng ?? Math.random;
  let state = newSchedulerState(now());
  let iterations = 0;

  while (!(deps.shouldStop?.() ?? false)) {
    const plan = planPass(state, cfg, now());
    if (plan.run) {
      deps.log?.(`▶ pass ${state.passes + 1} — up to ${plan.maxTotal} (mode=${cfg.mode}${cfg.liveSubmit ? ", LIVE" : ""})`);
      // A single pass failing (browser startup, transient DB error, an unexpected page) must record
      // the failure and continue — never terminate the 24/7 loop. The failed pass does NOT consume
      // the daily cap; only successful passes count applications.
      try {
        const run = await deps.runPass(plan.maxTotal);
        state = recordPass(state, run, now());
        deps.log?.(
          `  submitted ${run.submitted}, would-submit ${run.wouldSubmit}, queued ${run.queued}, ` +
            `skipped ${run.skipped} — window ${state.processedInWindow}/${cfg.dailyCeiling}`
        );
      } catch (err) {
        state = recordFailedPass(state, now());
        deps.log?.(`  ✖ pass failed (${state.failedPasses} total): ${(err as Error).message} — continuing`);
      }
    } else {
      deps.log?.(`⏸ ${plan.reason}`);
    }

    iterations++;
    if (deps.maxIterations !== undefined && iterations >= deps.maxIterations) break;
    if (deps.shouldStop?.() ?? false) break;

    const wait = cfg.everyMs + Math.floor(rng() * Math.max(0, cfg.jitterMs));
    deps.log?.(`  next pass in ~${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  return state;
}
