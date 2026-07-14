// src/orchestrator/autopilot.ts
//
// The always-on loop (Module 6 "auto"). One pass: for each enabled company, take its ready,
// high-scoring discovered jobs (not yet applied) and run the apply pipeline per job, respecting
// per-company caps and a total ceiling. In semi mode (default) it fills everything and queues it
// for your one-click review; in auto mode it submits ONLY where the employer is pre-approved and
// every safety gate passes (decideAutoSubmit), and only actually clicks when liveSubmit is set.

import type { ApplicantProfile } from "../types/applicant-profile";
import type { OperatingMode } from "../ats/adapter";
import { BrowserSession } from "../ats/browser";
import type { DB } from "../db/database";
import { recordAudit } from "../db/database";
import { CompaniesRepo } from "../db/companies-repo";
import { DiscoveredJobsRepo } from "../db/discovered-jobs-repo";
import { DuplicateApplicationError, RateLimitedError } from "../db/applications-repo";
import { runApplication, UnsupportedAtsError } from "./apply";
import { prepareApplicationDocs } from "./prepare-docs";
import { APPLY_RECOMMENDED_MIN_SCORE, isActionableDiscoveredJob } from "../jobs/actionable-jobs";
import { classifyApplyCapability } from "../jobs/apply-capability";
import { classifyUsEligibility } from "../jobs/us-eligibility";
import { resolveApplyGate } from "../jobs/job-search-intent";

/**
 * "Quality over volume" thresholds. When quality mode is on, a pass only tailors+queues matches at
 * or above this fit floor, and stops after this many — a few strong applications, not a flood. These
 * keep the dashboard pass focused on apply-recommended roles and can never loosen the user floor.
 */
export const QUALITY_MODE_MIN_SCORE = APPLY_RECOMMENDED_MIN_SCORE;
export const QUALITY_MODE_MAX_TOTAL = 5;

export interface AutopilotOptions {
  mode?: OperatingMode; // default "semi_auto" (safe)
  liveSubmit?: boolean; // default false (dry-run even in auto)
  minScore?: number; // default 0.75
  maxPerCompany?: number; // default 3
  maxTotal?: number; // default 10
  passwordStore?: string;
  generatedDir?: string;
  encryptionKey?: Buffer;
  onProgress?: (msg: string) => void;
  onProgressUpdate?: (patch: AutopilotProgressPatch) => void;
}

export interface AutopilotProgressPatch {
  status?: "queued" | "discovering" | "matching" | "preparing_packet" | "applying" | "completed" | "failed" | "paused" | "needs_review";
  currentStepLabel?: string;
  totalItems?: number;
  processedItems?: number;
  qualifiedCount?: number;
  oneClickCount?: number;
  appliedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  percentComplete?: number;
  completedAt?: string | null;
  errorMessage?: string | null;
  event?: string;
}

export type AutopilotAction = "submitted" | "would_submit" | "queued" | "account" | "blocked" | "skipped" | "error";

export interface AutopilotJobResult {
  company: string;
  title: string;
  jobUrl: string;
  action: AutopilotAction;
  reason: string;
}

export interface AutopilotRun {
  results: AutopilotJobResult[];
  submitted: number;
  wouldSubmit: number;
  queued: number;
  /** Parked because a login/account wall or a CAPTCHA needs the user ("Needs you" queue). */
  blocked?: number;
  skipped: number;
  message?: string;
  discovered?: number;
  matches?: number;
  ready?: number;
  discoveryMs?: number;
  applicationMs?: number;
  durationMs?: number;
}

export async function runAutopilot(
  session: BrowserSession,
  db: DB,
  profile: ApplicantProfile,
  opts: AutopilotOptions = {}
): Promise<AutopilotRun> {
  const mode: OperatingMode = opts.mode ?? "semi_auto";
  const live = opts.liveSubmit ?? false;
  const minScore = opts.minScore ?? APPLY_RECOMMENDED_MIN_SCORE;
  const maxPerCompany = opts.maxPerCompany ?? 3;
  const maxTotal = opts.maxTotal ?? 10;

  const companies = new CompaniesRepo(db).list({ enabledOnly: true });
  const jobsRepo = new DiscoveredJobsRepo(db);
  const run: AutopilotRun = { results: [], submitted: 0, wouldSubmit: 0, queued: 0, blocked: 0, skipped: 0 };

  const candidates = jobsRepo
    .list(profile.id, { minScore })
    .filter((j) => isActionableDiscoveredJob(j, { minScore }));

  // Part H gate (shared): automated apply requires a confirmed / high-confidence target. Confidence
  // derives from the profile's target, so facts aren't needed here. When the target is only weakly
  // inferred or missing, matches stay reviewable but nothing is auto-applied.
  const gate = resolveApplyGate(profile);

  // The discovery→apply contract: only jobs with a real form-fill adapter enter the fill loop.
  // Each excluded job is recorded with its plain-language reason. Manual-only jobs keep their
  // status (they stay visible for a manual apply); unsupported ones (board/search pages) are dead
  // ends and are marked skipped.
  const ready: typeof candidates = [];
  for (const job of candidates) {
    if (!gate.allowed) {
      run.skipped++;
      run.results.push({ company: job.company, title: job.title, jobUrl: job.jobUrl, action: "skipped", reason: gate.reason });
      continue;
    }
    const capability = classifyApplyCapability(job.jobUrl);
    if (capability.capability === "supported_form_fill") {
      // Defense-in-depth US-only gate: automated apply requires an affirmatively US-eligible
      // location, not just the absence of a non-US token. Ambiguous ("Remote"/blank) roles stay
      // visible for manual review but never enter the automated fill loop.
      const usElig = classifyUsEligibility(job.location, job.description);
      if (usElig.status !== "eligible_us") {
        run.skipped++;
        run.results.push({ company: job.company, title: job.title, jobUrl: job.jobUrl, action: "skipped", reason: `US eligibility not confirmed — ${usElig.reason}` });
        continue;
      }
      ready.push(job);
      continue;
    }
    run.skipped++;
    run.results.push({ company: job.company, title: job.title, jobUrl: job.jobUrl, action: "skipped", reason: capability.reason });
    if (capability.capability === "unsupported") jobsRepo.setStatus(profile.id, job.id, "skipped");
    opts.onProgressUpdate?.({
      status: "matching",
      currentStepLabel: `Skipped ${job.title} at ${job.company} (${capability.capability === "manual_open_only" ? "manual apply only" : "no application page"})`,
      skippedCount: 1,
      event: `Skipped ${job.company} / ${job.title}: ${capability.reason}`,
    });
  }

  const work: { company: (typeof companies)[number]; job: (typeof ready)[number] }[] = [];
  for (const company of companies) {
    if (work.length >= maxTotal) break;
    const companyJobs = ready.filter((j) => j.company === company.name).slice(0, maxPerCompany);
    for (const job of companyJobs) {
      if (work.length >= maxTotal) break;
      work.push({ company, job });
    }
  }

  opts.onProgress?.("Started matching roles");
  opts.onProgressUpdate?.({
    status: "matching",
    currentStepLabel: "Matching roles against your rules",
    qualifiedCount: ready.length,
    totalItems: work.length,
    processedItems: 0,
    event: "Started matching roles",
  });
  opts.onProgressUpdate?.({
    status: work.length ? "preparing_packet" : "completed",
    currentStepLabel: work.length ? `Found ${ready.length} qualified role(s)` : "No eligible roles to process",
    event: `Found ${ready.length} qualified role(s)`,
  });

  const push = (job: { company: string; title: string; jobUrl: string }, action: AutopilotAction, reason: string) =>
    run.results.push({ company: job.company, title: job.title, jobUrl: job.jobUrl, action, reason });

  for (const { company, job } of work) {
      opts.onProgress?.(`Tailoring documents for ${job.title} @ ${job.company}…`);
      opts.onProgressUpdate?.({
        status: "preparing_packet",
        currentStepLabel: `Preparing review packet for ${job.company} / ${job.title}`,
        event: `Preparing review packet for ${job.company} / ${job.title}`,
      });
      let docs;
      try {
        if (!opts.generatedDir) throw new Error("generatedDir required");
        docs = await prepareApplicationDocs(db, opts.encryptionKey, opts.generatedDir, profile, {
          company: job.company,
          title: job.title,
          ...(job.location ? { location: job.location } : {}),
          rationale: job.rationale,
          jobUrl: job.jobUrl,
          ...(job.description ? { description: job.description } : {}),
        });
      } catch (err) {
        run.skipped++;
        push(job, "error", (err as Error).message);
        opts.onProgressUpdate?.({
          status: "applying",
          currentStepLabel: `Packet failed for ${job.company} / ${job.title}`,
          processedItems: 1,
          failedCount: 1,
          event: `Application failed: ${safeReason(err)}`,
        });
        continue;
      }

      opts.onProgress?.(`Applying to ${job.title} @ ${job.company} (${Math.round(job.score * 100)}% fit)…`);
      opts.onProgressUpdate?.({
        status: "applying",
        currentStepLabel: `Filling application for ${job.company} / ${job.title}`,
        event: `Filling application for ${job.company} / ${job.title}`,
      });
      try {
        const outcome = await runApplication(session, db, {
          url: job.jobUrl,
          mode,
          profile,
          company: job.company,
          title: job.title,
          resumePath: docs.resumePath,
          ...(docs.coverLetterPath ? { coverLetterPath: docs.coverLetterPath } : {}),
          ...(docs.ledgerCheck ? { ledgerCheck: docs.ledgerCheck } : {}),
          accountMode: "prefill",
          ...(opts.passwordStore ? { passwordStore: opts.passwordStore } : {}),
          autoSubmitApproved: company.autoSubmitApproved,
          liveSubmit: live,
        });

        if (outcome.submitted) {
          run.submitted++;
          jobsRepo.setStatus(profile.id, job.id, "applied");
          push(job, "submitted", "auto-submitted — all rules passed");
          opts.onProgressUpdate?.({
            status: "applying",
            currentStepLabel: `Submitted ${job.company} / ${job.title}`,
            processedItems: 1,
            appliedCount: 1,
            event: "Application submitted successfully",
          });
        } else if (outcome.needsYou) {
          // Parked: a login/account wall or a CAPTCHA needs YOU before this job can proceed. Mark the
          // discovered job "blocked" so the "Needs you" queue can tell it apart from a normal queued
          // match; the batch keeps going. Nothing was submitted.
          run.blocked = (run.blocked ?? 0) + 1;
          jobsRepo.setStatus(profile.id, job.id, "blocked");
          push(job, "blocked", outcome.needsYou.label);
          opts.onProgressUpdate?.({
            status: "needs_review",
            currentStepLabel: `${job.company} / ${job.title} needs you (${outcome.needsYou.reason === "login" ? "log in" : "CAPTCHA"})`,
            processedItems: 1,
            event: `Parked ${job.company} / ${job.title}: ${outcome.needsYou.label}`,
          });
        } else if (outcome.accountRequired) {
          run.queued++;
          jobsRepo.setStatus(profile.id, job.id, "needs_review");
          push(job, "account", `account/login required (${outcome.gate.accountAction?.kind ?? "login"}) — do it once`);
          opts.onProgressUpdate?.({
            status: "needs_review",
            currentStepLabel: `${job.company} / ${job.title} requires account review`,
            processedItems: 1,
            oneClickCount: 1,
            event: "Application requires manual review",
          });
        } else if (outcome.autoSubmitDecision?.action === "would_submit") {
          run.wouldSubmit++;
          jobsRepo.setStatus(profile.id, job.id, "needs_review");
          push(job, "would_submit", outcome.autoSubmitDecision.reason);
          opts.onProgressUpdate?.({
            status: "needs_review",
            currentStepLabel: `${job.company} / ${job.title} is ready for one-click review`,
            processedItems: 1,
            oneClickCount: 1,
            event: "Application requires manual review",
          });
        } else {
          run.queued++;
          jobsRepo.setStatus(profile.id, job.id, "needs_review");
          push(job, "queued", outcome.autoSubmitDecision?.reason ?? "queued for your one-click review");
          opts.onProgressUpdate?.({
            status: "needs_review",
            currentStepLabel: `${job.company} / ${job.title} queued for review`,
            processedItems: 1,
            oneClickCount: 1,
            event: "Application requires manual review",
          });
        }
      } catch (err) {
        if (err instanceof DuplicateApplicationError) {
          run.skipped++;
          jobsRepo.setStatus(profile.id, job.id, "applied");
          push(job, "skipped", "already submitted");
          opts.onProgressUpdate?.({
            status: "applying",
            currentStepLabel: `Skipped duplicate ${job.company} / ${job.title}`,
            processedItems: 1,
            skippedCount: 1,
            event: "Skipped job: already submitted",
          });
        } else if (err instanceof RateLimitedError) {
          run.skipped++;
          push(job, "skipped", "per-company cap reached for this window");
          opts.onProgressUpdate?.({
            status: "paused",
            currentStepLabel: `Rate limit reached for ${job.company}`,
            processedItems: 1,
            skippedCount: 1,
            event: "Skipped job: per-company rate limit reached",
          });
        } else if (err instanceof UnsupportedAtsError) {
          run.skipped++;
          push(job, "skipped", "apply adapter not built for this ATS yet (Greenhouse only)");
          opts.onProgressUpdate?.({
            status: "applying",
            currentStepLabel: `Skipped unsupported ATS for ${job.company}`,
            processedItems: 1,
            skippedCount: 1,
            event: "Skipped job: apply adapter not available",
          });
        } else {
          run.skipped++;
          push(job, "error", (err as Error).message);
          opts.onProgressUpdate?.({
            status: "applying",
            currentStepLabel: `Application failed for ${job.company} / ${job.title}`,
            processedItems: 1,
            failedCount: 1,
            event: `Application failed: ${safeReason(err)}`,
          });
      }
    }
  }

  recordAudit(db, profile.id, "autopilot.run", {
    mode,
    live,
    considered: work.length,
    submitted: run.submitted,
    wouldSubmit: run.wouldSubmit,
    queued: run.queued,
    blocked: run.blocked ?? 0,
    skipped: run.skipped,
  });
  const needsAttention = run.queued || run.wouldSubmit || (run.blocked ?? 0);
  opts.onProgressUpdate?.({
    status: needsAttention ? "needs_review" : "completed",
    currentStepLabel: needsAttention ? "Automation completed; review required" : "Automation completed",
    completedAt: new Date().toISOString(),
    event: "Automation completed",
  });
  return run;
}

function safeReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 180) || "unknown error";
}
