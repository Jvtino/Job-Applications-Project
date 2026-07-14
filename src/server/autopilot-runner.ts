// src/server/autopilot-runner.ts
//
// Owns a browser session for one autopilot pass and runs it end-to-end. Two entry points:
//   - runAutopilotPass: general — mode + liveSubmit are the caller's choice. Used by the 24/7
//     scheduler CLI, where live auto-submit is legitimate behind explicit flags + a typed confirm.
//   - runSemiAutopilotPass: the dashboard's SEMI-ONLY pass. The semi/no-live lock is the explicit
//     mode/liveSubmit at the call site below — the dashboard can never auto-submit, whatever it asks.
// A fresh session per pass keeps each pass clean (no page build-up) while the persistent userDataDir
// (./browser-profile) keeps logins warm across passes and restarts.

import type { ApplicantProfile } from "../types/applicant-profile";
import type { OperatingMode } from "../ats/adapter";
import { BrowserSession } from "../ats/browser";
import type { DB } from "../db/database";
import { LedgerRepo } from "../db/ledger-repo";
import { CompaniesRepo } from "../db/companies-repo";
import { runAutopilot, type AutopilotProgressPatch, type AutopilotRun } from "../orchestrator/autopilot";
import { runAutomationCycle, type CycleResult } from "../orchestrator/automation-cycle";
import { APPLY_RECOMMENDED_MIN_SCORE } from "../jobs/actionable-jobs";

export interface PassOptions {
  mode?: OperatingMode; // default "semi_auto"
  liveSubmit?: boolean; // default false
  /** Default true: the user watches and can handle a login wall / CAPTCHA in the headed window. */
  headed?: boolean;
  /** Default = BrowserSession default (./browser-profile) so logged-in sessions persist. */
  userDataDir?: string;
  minScore?: number;
  maxTotal?: number;
  maxPerCompany?: number;
  passwordStore?: string;
  minActionDelayMs?: number;
  maxActionDelayMs?: number;
  generatedDir?: string;
  encryptionKey?: Buffer;
  /** Cap on direct per-source search pages during the pass's discovery (0 = boards only). */
  maxSourceSearches?: number;
  onProgress?: (msg: string) => void;
  onProgressUpdate?: (patch: AutopilotProgressPatch) => void;
}

function cycleToRun(cycle: CycleResult): AutopilotRun {
  const results = cycle.job && cycle.action
    ? [{ company: cycle.job.company, title: cycle.job.title, jobUrl: cycle.job.jobUrl, action: cycle.action, reason: cycle.reason ?? cycle.message }]
    : [];
  return {
    results,
    submitted: cycle.action === "submitted" ? 1 : 0,
    wouldSubmit: cycle.action === "would_submit" ? 1 : 0,
    queued: cycle.action === "queued" || cycle.action === "account" ? 1 : 0,
    skipped: cycle.action === "skipped" || cycle.action === "error" ? 1 : 0,
    message: cycle.message,
    discovered: cycle.discovered,
    matches: cycle.matches,
    ready: cycle.ready,
    discoveryMs: cycle.discoveryMs,
    applicationMs: cycle.applicationMs,
    durationMs: cycle.durationMs,
  };
}

/** Run one autopilot pass (mode/liveSubmit as the caller specifies), owning the browser session. */
export async function runAutopilotPass(
  db: DB,
  profile: ApplicantProfile,
  opts: PassOptions = {}
): Promise<AutopilotRun> {
  const session = new BrowserSession({
    headed: opts.headed ?? true,
    ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
    ...(opts.minActionDelayMs !== undefined ? { minActionDelayMs: opts.minActionDelayMs } : {}),
    ...(opts.maxActionDelayMs !== undefined ? { maxActionDelayMs: opts.maxActionDelayMs } : {}),
  });
  await session.start();
  try {
    return await runAutopilot(session, db, profile, {
      mode: opts.mode ?? "semi_auto",
      liveSubmit: opts.liveSubmit ?? false,
      ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
      ...(opts.maxTotal !== undefined ? { maxTotal: opts.maxTotal } : {}),
      ...(opts.maxPerCompany !== undefined ? { maxPerCompany: opts.maxPerCompany } : {}),
      ...(opts.passwordStore ? { passwordStore: opts.passwordStore } : {}),
      ...(opts.generatedDir ? { generatedDir: opts.generatedDir } : {}),
      ...(opts.encryptionKey ? { encryptionKey: opts.encryptionKey } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.onProgressUpdate ? { onProgressUpdate: opts.onProgressUpdate } : {}),
    });
  } finally {
    await session.close();
  }
}

export type SemiPassOptions = Omit<PassOptions, "mode" | "liveSubmit">;

/**
 * Run one SEMI-mode two-phase dashboard pass: discover first, then prepare/fill the highest-ranked
 * apply-ready job and pause at the review gate. The lock is the explicit mode/liveSubmit below —
 * NOT configurable by the caller. Used by the dashboard's POST /api/autopilot.
 */
export function runSemiAutopilotPass(
  db: DB,
  profile: ApplicantProfile,
  opts: SemiPassOptions = {}
): Promise<AutopilotRun> {
  return runSemiAutomationPass(db, profile, opts);
}

export async function runSemiAutomationPass(
  db: DB,
  profile: ApplicantProfile,
  opts: SemiPassOptions = {}
): Promise<AutopilotRun> {
  const ledger = new LedgerRepo(db, opts.encryptionKey).get(profile.id);
  const approvedFacts = (ledger?.facts ?? []).filter((f) => f.approved);
  let sourceTotal = new CompaniesRepo(db).list({ enabledOnly: true }).length + 1;
  let completedSources = 0;
  const session = new BrowserSession({
    headed: opts.headed ?? false,
    ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
    ...(opts.minActionDelayMs !== undefined ? { minActionDelayMs: opts.minActionDelayMs } : {}),
    ...(opts.maxActionDelayMs !== undefined ? { maxActionDelayMs: opts.maxActionDelayMs } : {}),
  });
  opts.onProgressUpdate?.({
    status: "discovering",
    currentStepLabel: "Automation Discovery: scanning job boards",
    totalItems: sourceTotal + 1,
    processedItems: 0,
    event: "Automation Discovery started",
  });
  await session.start();
  try {
    const cycle = await runAutomationCycle(session, db, profile, approvedFacts, {
      mode: "semi_auto",
      liveSubmit: false,
      minScore: opts.minScore ?? APPLY_RECOMMENDED_MIN_SCORE,
      generatedDir: opts.generatedDir,
      encryptionKey: opts.encryptionKey,
      maxSourceSearches: opts.maxSourceSearches,
      onDiscoverySourceComplete: (summary, completed, total) => {
        sourceTotal = total;
        completedSources = completed;
        const sourceStatus = summary.errors.length
          ? `Automation Discovery: ${summary.company} had an error`
          : `Automation Discovery: searched ${summary.company}`;
        opts.onProgressUpdate?.({
          status: "discovering",
          currentStepLabel: sourceStatus,
          totalItems: sourceTotal + 1,
          processedItems: completedSources,
          event: summary.errors.length
            ? `Discovery source failed: ${summary.company}`
            : `Discovery source searched: ${summary.company} (${summary.added} new)`,
        });
      },
      onProgress: (msg) => {
        opts.onProgress?.(msg);
        if (/Automation Application|tailoring documents|filling/i.test(msg)) {
          opts.onProgressUpdate?.({
            status: "applying",
            currentStepLabel: msg,
            totalItems: sourceTotal + 1,
            processedItems: sourceTotal,
            event: msg,
          });
        } else {
          opts.onProgressUpdate?.({
            status: "discovering",
            currentStepLabel: msg,
            totalItems: sourceTotal + 1,
            processedItems: completedSources,
            event: msg,
          });
        }
      },
    });
    const run = cycleToRun(cycle);
    const failed = cycle.action === "error";
    const paused = cycle.action === "skipped" && /rate|cap|slow|retry/i.test(`${cycle.reason ?? ""} ${cycle.message}`);
    const finalTotal = sourceTotal + (cycle.job ? 1 : 0);
    const manualOnly = cycle.manualOnly ?? 0;
    const finalPatch: AutopilotProgressPatch = {
      status: failed ? "failed" : paused ? "paused" : run.results.length ? "applying" : "completed",
      currentStepLabel: cycle.message,
      totalItems: finalTotal,
      processedItems: finalTotal,
      // "Qualified" = cleared the fit bar. Manual-only matches count — they're real matches the user
      // applies to by hand; only the PREFILL step is narrower than that.
      qualifiedCount: cycle.ready + manualOnly,
      oneClickCount: run.queued + run.wouldSubmit,
      appliedCount: run.submitted,
      failedCount: run.results.filter((r) => r.action === "error").length,
      skippedCount: run.skipped,
      event: failed
        ? `Application failed: ${safeReason(cycle.reason ?? cycle.message)}`
        : paused
          ? `Automation paused: ${safeReason(cycle.reason ?? cycle.message)}`
          : `Automation Discovery completed: ${cycle.discovered} new, ${cycle.matches} match(es), ${cycle.ready} ready to prefill${manualOnly ? `, ${manualOnly} manual-apply` : ""}`,
    };
    if (failed || paused || !run.results.length) {
      finalPatch.completedAt = new Date().toISOString();
    }
    if (failed || paused) {
      finalPatch.errorMessage = safeReason(cycle.reason ?? cycle.message);
    }
    opts.onProgressUpdate?.(finalPatch);
    return run;
  } finally {
    await session.close();
  }
}

function safeReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 180) || "unknown reason";
}
