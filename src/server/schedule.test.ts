// Tests for the server-side daily scheduler (commercial M9-C). This is the autonomous-trigger core,
// so the firing / re-arming / no-double-fire behaviour is covered directly with an injected clock and
// fake timers — no real wall-clock waits.
import { describe, it, expect, vi } from "vitest";
import { computeNextRun, normalizeHour, createDailyScheduler, type ScheduleSettings } from "./schedule";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("computeNextRun", () => {
  it("returns null when disabled", () => {
    expect(computeNextRun({ enabled: false, hour: 7 }, new Date("2026-07-05T09:00:00"))).toBeNull();
  });

  it("schedules later today when the hour is still ahead", () => {
    const next = computeNextRun({ enabled: true, hour: 18 }, new Date("2026-07-05T09:00:00"));
    expect(next?.toString()).toBe(new Date("2026-07-05T18:00:00").toString());
  });

  it("rolls to tomorrow when the hour has already passed", () => {
    const next = computeNextRun({ enabled: true, hour: 7 }, new Date("2026-07-05T09:00:00"));
    expect(next?.toString()).toBe(new Date("2026-07-06T07:00:00").toString());
  });

  it("rolls to tomorrow when now is exactly the scheduled hour (never fires instantly)", () => {
    const next = computeNextRun({ enabled: true, hour: 9 }, new Date("2026-07-05T09:00:00.000"));
    expect(next?.toString()).toBe(new Date("2026-07-06T09:00:00").toString());
  });

  it("normalizes out-of-range / non-finite hours", () => {
    expect(normalizeHour(30)).toBe(23);
    expect(normalizeHour(-4)).toBe(0);
    expect(normalizeHour(7.6)).toBe(8);
    expect(normalizeHour(Number.NaN)).toBe(7);
  });
});

/**
 * A deterministic fake clock + timer. The scheduler uses only these injected functions, so no real
 * time passes. `advance` moves the clock and fires every due timer in order, awaiting between fires so
 * the scheduler's async tick (fire → re-arm) completes before the next timer is considered.
 */
function makeHarness(startIso: string) {
  let now = new Date(startIso).getTime();
  let seq = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    now: () => now,
    setTimer: (cb: () => void, ms: number) => {
      const id = seq++;
      timers.set(id, { at: now + ms, cb });
      return { id, unref: () => {} };
    },
    clearTimer: (h: unknown) => {
      timers.delete((h as { id: number }).id);
    },
    async advance(ms: number) {
      const target = now + ms;
      // Fire due timers one at a time (a fire re-arms a new timer), awaiting the async tick each time.
      for (;;) {
        let due: { id: number; at: number; cb: () => void } | null = null;
        for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due.at)) due = { id, ...t };
        if (!due) break;
        now = due.at;
        timers.delete(due.id);
        due.cb();
        await flush();
      }
      now = target;
    },
  };
}

describe("createDailyScheduler", () => {
  const enabled = (hour: number): ScheduleSettings => ({ enabled: true, hour });

  it("does not arm or fire when disabled", async () => {
    const h = makeHarness("2026-07-05T09:00:00");
    const fire = vi.fn().mockResolvedValue(undefined);
    const s = createDailyScheduler({ fire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.set({ enabled: false, hour: 7 });
    expect(s.nextRunAt()).toBeNull();
    await h.advance(3 * DAY);
    expect(fire).not.toHaveBeenCalled();
  });

  it("arms for the next occurrence and reports it", () => {
    const h = makeHarness("2026-07-05T09:00:00");
    const s = createDailyScheduler({ fire: vi.fn(), now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.set(enabled(7));
    expect(s.nextRunAt()?.toString()).toBe(new Date("2026-07-06T07:00:00").toString());
  });

  it("fires at the scheduled time and re-arms for the following day", async () => {
    const h = makeHarness("2026-07-05T09:00:00");
    const fire = vi.fn().mockResolvedValue(undefined);
    const s = createDailyScheduler({ fire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.set(enabled(7));

    await h.advance(DAY); // cross 2026-07-06T07:00
    expect(fire).toHaveBeenCalledTimes(1);
    expect(s.nextRunAt()?.toString()).toBe(new Date("2026-07-07T07:00:00").toString());

    await h.advance(DAY); // cross 2026-07-07T07:00
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("keeps re-arming even when a fire throws", async () => {
    const h = makeHarness("2026-07-05T09:00:00");
    const fire = vi.fn().mockRejectedValue(new Error("pass blew up"));
    const s = createDailyScheduler({ fire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.set(enabled(7));

    await h.advance(DAY);
    expect(fire).toHaveBeenCalledTimes(1);
    // A thrown pass must not wedge the schedule — tomorrow is still armed.
    expect(s.nextRunAt()?.toString()).toBe(new Date("2026-07-07T07:00:00").toString());
    await h.advance(DAY);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels the armed timer so it never fires", async () => {
    const h = makeHarness("2026-07-05T09:00:00");
    const fire = vi.fn().mockResolvedValue(undefined);
    const s = createDailyScheduler({ fire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.set(enabled(7));
    s.stop();
    expect(s.nextRunAt()).toBeNull();
    await h.advance(3 * DAY);
    expect(fire).not.toHaveBeenCalled();
  });

  it("stop() during an in-flight fire is authoritative — tick's finally does NOT re-arm", async () => {
    const h = makeHarness("2026-07-05T09:00:00");
    let resolveFire!: () => void;
    const fire = vi.fn(() => new Promise<void>((r) => { resolveFire = r; }));
    const s = createDailyScheduler({ fire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.set(enabled(7));

    await h.advance(DAY); // reaches 07-06 07:00: tick() starts, fire() is in-flight (unresolved)
    expect(fire).toHaveBeenCalledTimes(1);

    s.stop(); // stop WHILE the pass is running — handle is already null, so this must set the kill flag
    expect(s.nextRunAt()).toBeNull();

    resolveFire(); // pass completes → tick's `finally { arm() }` runs, but stopped must suppress re-arm
    await new Promise((r) => setTimeout(r, 0));
    expect(s.nextRunAt()).toBeNull();

    await h.advance(3 * DAY);
    expect(fire).toHaveBeenCalledTimes(1); // no second fire — the scheduler stayed stopped
  });

  it("does not fire twice within the min-gap guard", async () => {
    const h = makeHarness("2026-07-05T09:00:00");
    const fire = vi.fn().mockResolvedValue(undefined);
    // minGap far larger than a day: even the next day's tick is suppressed as a double-fire.
    const s = createDailyScheduler({
      fire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer, minGapMs: 3 * DAY,
    });
    s.set(enabled(7));
    await h.advance(DAY); // first fire at 07-06 07:00
    expect(fire).toHaveBeenCalledTimes(1);
    await h.advance(DAY); // 07-07 07:00 tick — within 3-day gap, so skipped (re-armed only)
    expect(fire).toHaveBeenCalledTimes(1);
    await h.advance(2 * DAY); // 07-09 07:00 — now past the gap, fires again
    expect(fire).toHaveBeenCalledTimes(2);
  });
});
