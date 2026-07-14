// src/server/schedule.ts
//
// Server-side daily-run scheduler (commercial M9-C). The engine — not a browser timer — owns the
// "run once a day at hour H" schedule, so it survives dashboard reloads, reports a truthful
// engine-computed "Next run", and re-arms itself across engine restarts from the persisted setting.
//
// SAFETY: this only decides WHEN to start a pass. WHAT it starts is the same never-submit semi pass
// the manual "Run automation" button runs (see runSemiPass in api.ts) — the review-gate invariant is
// enforced entirely downstream, not here. The schedule is opt-in (OFF by default) because it is an
// unattended trigger of browser automation.

export interface ScheduleSettings {
  enabled: boolean;
  /** Local hour (0–23) the daily pass should start. */
  hour: number;
}

const HOUR_MIN = 0;
const HOUR_MAX = 23;
const DEFAULT_HOUR = 7;

/** Clamp/round an arbitrary hour input into a valid 0–23 hour; non-finite falls back to 7. */
export function normalizeHour(hour: number): number {
  if (!Number.isFinite(hour)) return DEFAULT_HOUR;
  return Math.min(HOUR_MAX, Math.max(HOUR_MIN, Math.round(hour)));
}

/**
 * The next occurrence of `hour:00:00` in local time strictly after `now`, or null when the schedule
 * is disabled. "Strictly after" means a schedule set to the current hour fires tomorrow, never
 * instantly on enable.
 */
export function computeNextRun(settings: ScheduleSettings, now: Date): Date | null {
  if (!settings.enabled) return null;
  const next = new Date(now.getTime());
  next.setHours(normalizeHour(settings.hour), 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

type TimerHandle = { unref?: () => void };

export interface DailySchedulerDeps {
  /**
   * Starts the scheduled pass. The scheduler awaits it and swallows/logs any rejection, so a failed
   * pass never wedges re-arming for the following day.
   */
  fire: () => Promise<unknown>;
  /** Injectable clock (ms epoch) for tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable timer for tests. Defaults to an unref'd setTimeout. */
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  log?: (message: string) => void;
  /**
   * Minimum spacing between two fires — a guard against a double-fire from a clock jump, a rapid
   * re-arm, or DST. Daily runs are ~24h apart, so 12h is safely below the real cadence. Default 12h.
   */
  minGapMs?: number;
}

export interface DailyScheduler {
  /** (Re)arm from a schedule setting. Called at boot and whenever the user changes the schedule. */
  set(settings: ScheduleSettings): void;
  /** The armed next-run instant, or null when disabled — the truthful value the UI shows. */
  nextRunAt(): Date | null;
  /** Cancel any armed timer (server shutdown / test teardown). */
  stop(): void;
}

// setTimeout coerces delays past 2^31-1 ms to 1 and would fire immediately; our delays are always
// < 24h, but clamp defensively so a bad clock can never cause a busy-loop of instant fires.
const MAX_DELAY_MS = 2_147_483_647;
const DEFAULT_MIN_GAP_MS = 12 * 60 * 60_000;

export function createDailyScheduler(deps: DailySchedulerDeps): DailyScheduler {
  const now = deps.now ?? (() => Date.now());
  const setTimer =
    deps.setTimer ??
    ((cb, ms) => {
      const t = setTimeout(cb, ms);
      t.unref?.(); // never let the schedule timer alone keep the engine process alive
      return t;
    });
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => {});
  const minGapMs = deps.minGapMs ?? DEFAULT_MIN_GAP_MS;

  let settings: ScheduleSettings = { enabled: false, hour: DEFAULT_HOUR };
  let handle: TimerHandle | null = null;
  let nextAt: Date | null = null;
  let lastFiredAt = -Infinity;
  let firing = false;
  // Authoritative kill switch. stop() during an in-flight fire can't clear the (already-null) handle,
  // so without this flag tick()'s `finally { arm() }` would re-arm a live timer from still-enabled
  // settings. `arm()` honors it; `set()` clears it (a reconfigure revives the scheduler).
  let stopped = false;

  const disarm = (): void => {
    if (handle) {
      clearTimer(handle);
      handle = null;
    }
    nextAt = null;
  };

  const arm = (): void => {
    disarm();
    if (stopped) return;
    const next = computeNextRun(settings, new Date(now()));
    if (!next) return;
    nextAt = next;
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, next.getTime() - now()));
    handle = setTimer(onTick, delay);
    log(`next daily pass at ${next.toISOString()}`);
  };

  const onTick = (): void => {
    handle = null;
    void tick();
  };

  const tick = async (): Promise<void> => {
    const t = now();
    // Never double-fire: if a pass is already running or one fired recently, re-arm for the next day
    // WITHOUT starting another. Protects against clock jumps and overlapping arms.
    if (firing || t - lastFiredAt < minGapMs) {
      arm();
      return;
    }
    firing = true;
    lastFiredAt = t;
    try {
      await deps.fire();
    } catch (err) {
      log(`daily pass threw: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      firing = false;
      arm(); // re-arm for tomorrow regardless of outcome
    }
  };

  return {
    set(next: ScheduleSettings): void {
      stopped = false;
      settings = { enabled: Boolean(next.enabled), hour: normalizeHour(next.hour) };
      arm();
    },
    nextRunAt(): Date | null {
      return nextAt;
    },
    stop(): void {
      stopped = true;
      disarm();
    },
  };
}
