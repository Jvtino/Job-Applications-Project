// src/server/automation-runner.ts
//
// Continuous dashboard automation: discover good-fit roles and apply one at a time with human pacing
// until the user stops it. Semi mode fills and pauses at the review gate; auto mode submits when
// every safety gate passes (CAPTCHA-free, pre-approved employer, confirmed fields, etc.).

import type { ApplicantProfile } from "../types/applicant-profile";
import type { OperatingMode } from "../ats/adapter";
import { BrowserSession } from "../ats/browser";
import type { DB } from "../db/database";
import { recordAudit } from "../db/database";
import { LedgerRepo } from "../db/ledger-repo";
import type { Fact } from "../types/facts-ledger";
import { runAutomationCycle, type CycleResult } from "../orchestrator/automation-cycle";
import { APPLY_RECOMMENDED_MIN_SCORE } from "../jobs/actionable-jobs";

export type CycleFn = typeof runAutomationCycle;
let cycleFnOverride: CycleFn | null = null;

/** Test-only: replace the real discover+apply cycle (avoids launching Chromium in unit tests). */
export function __setCycleFnForTest(fn: CycleFn | null): void {
  cycleFnOverride = fn;
}

export type RunnerPhase = "idle" | "discovering" | "applying" | "waiting" | "stopping";
export type RunnerMode = "auto" | "semi";

export type FeedDot = "teal" | "coral" | "yellow" | "blue";

export interface LiveFeedItem {
  id: string;
  at: string;
  company: string;
  role?: string;
  status: string;
  dot: FeedDot;
  active?: boolean;
}

export interface RunnerStatus {
  running: boolean;
  mode: RunnerMode | null;
  phase: RunnerPhase;
  message: string;
  startedAt: string | null;
  cycles: number;
  submitted: number;
  queued: number;
  skipped: number;
  currentJob: { company: string; title: string; score: number } | null;
  lastCycle: CycleResult | null;
  nextCycleAt: string | null;
  /** Rolling live activity for the hero scan-stage (newest first). */
  feed: LiveFeedItem[];
}

export interface RunnerStartOptions {
  mode: RunnerMode;
  minScore?: number;
  /** Pause between applications (default 90s, jittered ±25%). */
  betweenJobsMs?: number;
  headed?: boolean;
  /** Where tailored résumé/cover PDFs are written before each apply. */
  generatedDir: string;
}

const DEFAULT_BETWEEN_MS = 90_000;
const FEED_MAX = 12;

function emptyStatus(): RunnerStatus {
  return {
    running: false,
    mode: null,
    phase: "idle",
    message: "Stopped",
    startedAt: null,
    cycles: 0,
    submitted: 0,
    queued: 0,
    skipped: 0,
    currentJob: null,
    lastCycle: null,
    nextCycleAt: null,
    feed: [],
  };
}

function actionToFeed(result: CycleResult): { status: string; dot: FeedDot } {
  switch (result.action) {
    case "submitted":
      return { status: "Auto-sent", dot: "teal" };
    case "queued":
      return { status: "Needs review", dot: "yellow" };
    case "would_submit":
      return { status: "Ready to submit", dot: "yellow" };
    case "account":
      return { status: "Login needed", dot: "coral" };
    case "blocked":
      return { status: "Needs you", dot: "coral" };
    case "skipped":
      return { status: "Skipped", dot: "coral" };
    case "error":
      return { status: "Error", dot: "coral" };
    default:
      return { status: "Searching", dot: "blue" };
  }
}

/** Process-wide singleton — one continuous runner at a time. */
class AutomationRunner {
  private status: RunnerStatus = emptyStatus();
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;

  getStatus(): RunnerStatus {
    return {
      ...this.status,
      currentJob: this.status.currentJob ? { ...this.status.currentJob } : null,
      feed: this.status.feed.map((f) => ({ ...f })),
    };
  }

  private pushFeed(item: Omit<LiveFeedItem, "id" | "at"> & { id?: string; at?: string }, active = false): void {
    if (active) {
      for (const f of this.status.feed) f.active = false;
    }
    const entry: LiveFeedItem = {
      id: item.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: item.at ?? new Date().toISOString(),
      company: item.company,
      status: item.status,
      dot: item.dot,
      ...(item.role ? { role: item.role } : {}),
      ...(active ? { active: true } : {}),
    };
    this.status.feed = [entry, ...this.status.feed.filter((f) => f.id !== entry.id)].slice(0, FEED_MAX);
  }

  private setActiveFeed(company: string, status: string, dot: FeedDot, role?: string): void {
    const existing = this.status.feed.find((f) => f.company === company && f.active);
    if (existing) {
      existing.status = status;
      existing.dot = dot;
      if (role) existing.role = role;
      return;
    }
    this.pushFeed({ company, status, dot, ...(role ? { role } : {}) }, true);
  }

  isRunning(): boolean {
    return this.status.running;
  }

  /** Resolves when the current loop ends (or immediately if idle). */
  whenFinished(): Promise<void> {
    return this.loopPromise ?? Promise.resolve();
  }

  async start(db: DB, profile: ApplicantProfile, encryptionKey: Buffer | undefined, opts: RunnerStartOptions): Promise<void> {
    if (this.status.running) {
      throw new Error("Automation is already running. Stop it first to change mode.");
    }

    const ledger = new LedgerRepo(db, encryptionKey).get(profile.id);
    const approvedFacts: Fact[] = (ledger?.facts ?? []).filter((f) => f.approved);

    this.stopRequested = false;
    this.status = {
      ...emptyStatus(),
      running: true,
      mode: opts.mode,
      phase: "discovering",
      message: opts.mode === "auto" ? "Auto mode — searching and applying…" : "Semi mode — searching and filling applications…",
      startedAt: new Date().toISOString(),
    };
    this.pushFeed({
      company: "Your targets",
      status: opts.mode === "auto" ? "Auto run started" : "Semi run started",
      dot: "blue",
    }, true);

    const operatingMode: OperatingMode = opts.mode === "auto" ? "auto" : "semi_auto";
    const liveSubmit = opts.mode === "auto";
    const betweenMs = opts.betweenJobsMs ?? DEFAULT_BETWEEN_MS;

    this.loopPromise = this.runLoop(db, profile, approvedFacts, encryptionKey, {
      mode: operatingMode,
      liveSubmit,
      minScore: opts.minScore ?? APPLY_RECOMMENDED_MIN_SCORE,
      betweenMs,
      headed: opts.headed ?? true,
      generatedDir: opts.generatedDir,
    });
    void this.loopPromise;
  }

  stop(): void {
    if (!this.status.running) return;
    this.stopRequested = true;
    this.status.phase = "stopping";
    this.status.message = "Stopping after the current step…";
  }

  private async runLoop(
    db: DB,
    profile: ApplicantProfile,
    approvedFacts: Fact[],
    encryptionKey: Buffer | undefined,
    opts: {
      mode: OperatingMode;
      liveSubmit: boolean;
      minScore: number;
      betweenMs: number;
      headed: boolean;
      generatedDir: string;
    }
  ): Promise<void> {
    const runCycles = async (session: BrowserSession | null) => {
      while (!this.stopRequested) {
        this.status.phase = "discovering";
        this.status.currentJob = null;
        this.setActiveFeed("Company boards", "Searching for matches…", "blue");

        const result = await (cycleFnOverride ?? runAutomationCycle)(
          session as BrowserSession,
          db,
          profile,
          approvedFacts,
          {
            mode: opts.mode,
            liveSubmit: opts.liveSubmit,
            minScore: opts.minScore,
            generatedDir: opts.generatedDir,
            encryptionKey,
            onProgress: (msg) => {
              this.status.message = msg;
              const lower = msg.toLowerCase();
              if (lower.includes("browsing")) {
                const m = msg.match(/Browsing (.+?) \(/);
                const company = m?.[1]?.trim() ?? "Company board";
                this.setActiveFeed(company, "Browsing job board…", "blue");
              } else if (lower.includes("searching") || lower.includes("automation discovery")) {
                this.setActiveFeed("Company boards", "Searching for matches…", "blue");
              } else if (lower.includes("tailoring")) {
                this.status.phase = "applying";
                const m = msg.match(/tailoring documents for (.+?) @ (.+?)(?:…|\.{3})/i);
                const title = m?.[1]?.trim();
                const company = m?.[2]?.trim() ?? "Role";
                this.setActiveFeed(company, "Tailoring documents…", "teal", title);
              } else if (lower.includes("applying") || lower.includes("filling")) {
                this.status.phase = "applying";
                const m = msg.match(/(?:applying to|filling) (.+?) @ (.+?) \(/i);
                const title = m?.[1]?.trim();
                const company = m?.[2]?.trim() ?? "Role";
                this.setActiveFeed(
                  company,
                  opts.mode === "auto" ? "Applying — filling form…" : "Filling application…",
                  "teal",
                  title
                );
              }
            },
          }
        );

        this.status.cycles++;
        this.status.lastCycle = result;
        this.status.message = result.message;

        if (result.job) {
          this.status.currentJob = {
            company: result.job.company,
            title: result.job.title,
            score: Math.round(result.job.score * 100),
          };
          const { status, dot } = actionToFeed(result);
          this.pushFeed({
            company: result.job.company,
            role: result.job.title,
            status,
            dot,
          });
        } else if (result.discovered > 0) {
          this.pushFeed({
            company: "Discovery",
            status: `Found ${result.discovered} new role(s)`,
            dot: "blue",
          });
        } else {
          this.pushFeed({
            company: "Company boards",
            status: "No new matches this pass",
            dot: "yellow",
          });
        }

        if (result.action === "submitted") this.status.submitted++;
        else if (result.action === "queued" || result.action === "would_submit" || result.action === "account") this.status.queued++;
        else if (result.action === "skipped" || result.action === "error") this.status.skipped++;

        recordAudit(db, profile.id, "automation.cycle", {
          mode: this.status.mode,
          cycles: this.status.cycles,
          discovered: result.discovered,
          applied: result.applied,
          action: result.action ?? null,
          company: result.job?.company ?? null,
        });

        if (this.stopRequested) break;

        const wait = cycleFnOverride ? 15 : opts.betweenMs + Math.floor((Math.random() - 0.5) * opts.betweenMs * 0.5);
        this.status.phase = "waiting";
        this.status.nextCycleAt = new Date(Date.now() + wait).toISOString();
        this.status.message = cycleFnOverride
          ? result.message
          : `Pausing ${Math.round(wait / 1000)}s before the next role — watch the browser or leave it running.`;
        this.setActiveFeed("Next role", `Pausing ${Math.round(wait / 1000)}s…`, "blue");
        await sleep(wait);
      }
    };

    if (cycleFnOverride) {
      try {
        await runCycles(null);
      } catch (err) {
        this.status.message = `Runner stopped: ${(err as Error).message}`;
      } finally {
        this.status.running = false;
        this.status.phase = "idle";
        this.status.mode = null;
        this.status.currentJob = null;
        this.status.nextCycleAt = null;
        this.status.message = this.stopRequested ? "Stopped" : this.status.message;
        this.loopPromise = null;
      }
      return;
    }

    const session = new BrowserSession({
      headed: opts.headed,
      minActionDelayMs: 1200,
      maxActionDelayMs: 3500,
    });

    try {
      await session.start();
      await runCycles(session);
    } catch (err) {
      this.status.message = `Runner stopped: ${(err as Error).message}`;
    } finally {
      await session.close().catch(() => undefined);
      this.status.running = false;
      this.status.phase = "idle";
      this.status.mode = null;
      this.status.currentJob = null;
      this.status.nextCycleAt = null;
      if (!this.stopRequested && this.status.message.startsWith("Runner stopped:")) {
        /* keep error message */
      } else if (this.stopRequested) {
        this.status.message = "Stopped";
      }
      this.loopPromise = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const automationRunner = new AutomationRunner();
