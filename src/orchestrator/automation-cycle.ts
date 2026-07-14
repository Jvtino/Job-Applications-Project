// src/orchestrator/automation-cycle.ts
//
// One human-paced automation cycle: browse enabled company boards for new matches, then apply to
// the single best-fit role that is ready. Used by the dashboard's continuous runner.

import { join } from "node:path";
import type { ApplicantProfile } from "../types/applicant-profile";
import type { OperatingMode } from "../ats/adapter";
import type { Fact } from "../types/facts-ledger";
import { BrowserSession } from "../ats/browser";
import { finderSecretLookup } from "../server/config-store";
import type { DB } from "../db/database";
import { recordAudit } from "../db/database";
import { CompaniesRepo } from "../db/companies-repo";
import { DiscoveredJobsRepo } from "../db/discovered-jobs-repo";
import { DuplicateApplicationError, RateLimitedError } from "../db/applications-repo";
import { runFinderDiscovery } from "../finder/pipeline/run-discovery";
import type { CompanyDiscovery } from "../finder/pipeline/discovery-run-types";
import { ResumeInsightsRepo } from "../db/resume-insights-repo";
import { runApplication, UnsupportedAtsError } from "./apply";
import type { AutopilotAction } from "./autopilot";
import { prepareApplicationDocs } from "./prepare-docs";
import { APPLY_RECOMMENDED_MIN_SCORE, isActionableDiscoveredJob } from "../jobs/actionable-jobs";
import { classifyApplyCapability } from "../jobs/apply-capability";
import { classifyUsEligibility } from "../jobs/us-eligibility";
import { resolveApplyGate, resolveJobSearchIntent } from "../jobs/job-search-intent";
import { emitPassFunnel } from "../jobs/pass-funnel";

export interface CycleOptions {
  mode: OperatingMode;
  liveSubmit: boolean;
  minScore?: number;
  onProgress?: (msg: string) => void;
  onDiscoverySourceComplete?: (summary: CompanyDiscovery, completedSources: number, totalSources: number) => void;
  generatedDir?: string;
  encryptionKey?: Buffer;
  /** Cap on direct per-source search pages (0 = company-board scan only). Passed to runDiscovery. */
  maxSourceSearches?: number;
}

export interface CycleResult {
  discovered: number;
  matches: number;
  ready: number;
  /** Actionable matches excluded from the fill step because they have no form-fill adapter. */
  manualOnly?: number;
  discoveryMs: number;
  applicationMs: number;
  durationMs: number;
  applied: boolean;
  job?: { company: string; title: string; jobUrl: string; score: number };
  action?: AutopilotAction;
  reason?: string;
  message: string;
}

export async function runAutomationCycle(
  session: BrowserSession,
  db: DB,
  profile: ApplicantProfile,
  approvedFacts: Fact[],
  opts: CycleOptions
): Promise<CycleResult> {
  const startedAt = Date.now();
  const minScore = opts.minScore ?? APPLY_RECOMMENDED_MIN_SCORE;
  const onProgress = opts.onProgress;
  const base = (patch: Omit<CycleResult, "discovered" | "matches" | "ready" | "discoveryMs" | "applicationMs" | "durationMs"> & {
    discovered: number;
    matches: number;
    ready: number;
    discoveryMs: number;
    applicationMs?: number;
  }): CycleResult => ({
    ...patch,
    applicationMs: patch.applicationMs ?? 0,
    durationMs: Date.now() - startedAt,
  });

  onProgress?.("Automation Discovery: scanning company boards for roles that fit your profile…");
  const discoveryStartedAt = Date.now();
  recordAudit(db, profile.id, "automation.discovery.start", {
    trigger: "dashboard.autopilot",
    minScore,
    approvedFacts: approvedFacts.length,
  });
  // Discovery is now the browser-free finder pass — it does not use `session`
  // (kept below for the apply step). Intent + résumé insights feed scoring.
  const intent = resolveJobSearchIntent({ profile, facts: approvedFacts });
  const insights = new ResumeInsightsRepo(db).get(profile.id);
  const envPath = process.env.APPLYPILOT_ENV_PATH?.trim() || join(process.cwd(), ".env");
  const discovery = await runFinderDiscovery({
    db,
    profile,
    intent,
    insights,
    getSecret: finderSecretLookup(envPath),
    ...(onProgress ? { onProgress } : {}),
  });
  const discoveryMs = Date.now() - discoveryStartedAt;
  const discovered = discovery.perCompany.reduce((n, c) => n + c.added, 0);
  const matches = discovery.scored.filter((s) => s.knockouts.length === 0).length;

  const companies = new CompaniesRepo(db).list({ enabledOnly: true });
  const jobsRepo = new DiscoveredJobsRepo(db);
  const candidates = jobsRepo
    .list(profile.id, { minScore })
    .filter((j) => isActionableDiscoveredJob(j, { minScore, requireEmployerJobUrl: false }));
  // The discovery→apply contract: only jobs with a real form-fill adapter enter the fill step.
  // Manual-only matches stay visible in the review list (never status-changed here) — the cycle just
  // refuses to route them into the generic fallback, and says so.
  // Automated apply requires BOTH a real form-fill adapter AND an affirmatively US-eligible location
  // (defense-in-depth over the scoring cap). Ambiguous/non-US roles stay visible for manual review.
  // Part H gate (shared): automated apply requires a confirmed / high-confidence target. When the
  // intent is only weakly inferred (or missing), discovery still runs and matches stay visible, but
  // nothing is routed into the automated fill loop — the user must confirm their target first.
  const gate = resolveApplyGate(profile, approvedFacts);
  const ready = gate.allowed
    ? candidates.filter(
        (j) =>
          classifyApplyCapability(j.jobUrl).capability === "supported_form_fill" &&
          classifyUsEligibility(j.location, j.description).status === "eligible_us"
      )
    : [];
  const manualOnly = candidates.length - ready.length;
  recordAudit(db, profile.id, "automation.discovery.complete", {
    trigger: "dashboard.autopilot",
    discovered,
    matches,
    ready: ready.length,
    manualOnly,
    discoveryMs,
  });

  // Honest funnel telemetry (brief F2/J3): classify the pipeline the same way the apply path does and
  // record WHERE jobs are lost + a zero-match bottleneck (shared emitter; best-effort).
  emitPassFunnel(db, profile.id, "dashboard.autopilot", { passId: `cycle-${startedAt}`, intent: gate.intent, rawFound: discovered });

  const job = ready
    .slice()
    .sort((a, b) => b.score - a.score)[0];

  if (!job) {
    const manualNote = manualOnly > 0 ? ` ${manualOnly} match(es) need a manual apply — open them from your matches list.` : "";
    const msg = !gate.allowed
      ? `${gate.reason} Discovery ran and your matches are ready to review.`
      : manualOnly > 0
        ? `No matches support automated prefill right now.${manualNote}`
        : discovered > 0
        ? `Found ${discovered} new role(s) — none cleared your fit threshold yet.`
        : matches > 0
        ? "Matches found, but every role is already in your pipeline."
        : "No new matches on your boards right now.";
    return base({ discovered, matches, ready: ready.length, manualOnly, discoveryMs, applied: false, message: msg });
  }

  const company = companies.find((c) => c.name === job.company);
  const applicationStartedAt = Date.now();
  const jobSummary = { company: job.company, title: job.title, jobUrl: job.jobUrl, score: job.score };
  recordAudit(db, profile.id, "automation.application.selected", {
    trigger: "dashboard.autopilot",
    company: job.company,
    title: job.title,
    score: job.score,
    minScore,
    decision: "highest_scoring_ready_job",
  });
  onProgress?.(`Automation Application: tailoring documents for ${job.title} @ ${job.company}…`);

  let docs;
  try {
    if (!opts.generatedDir) throw new Error("generatedDir required");
    docs = await prepareApplicationDocs(db, opts.encryptionKey, opts.generatedDir, profile, {
      company: job.company,
      title: job.title,
      ...(job.location ? { location: job.location } : {}),
      rationale: job.rationale,
      jobUrl: job.jobUrl,
    });
  } catch (err) {
    return base({
      discovered,
      matches,
      ready: ready.length,
      discoveryMs,
      applicationMs: Date.now() - applicationStartedAt,
      applied: false,
      job: jobSummary,
      action: "error",
      reason: (err as Error).message,
      message: `Could not prepare documents for ${job.company}: ${(err as Error).message}`,
    });
  }

  onProgress?.(`Automation Application: filling ${job.title} @ ${job.company} (${Math.round(job.score * 100)}% fit)…`);

  try {
    const outcome = await runApplication(session, db, {
      url: job.jobUrl,
      mode: opts.mode,
      profile,
      company: job.company,
      title: job.title,
      resumePath: docs.resumePath,
      ...(docs.coverLetterPath ? { coverLetterPath: docs.coverLetterPath } : {}),
      ...(docs.ledgerCheck ? { ledgerCheck: docs.ledgerCheck } : {}),
      accountMode: "prefill",
      autoSubmitApproved: company?.autoSubmitApproved ?? false,
      liveSubmit: opts.liveSubmit,
    });

    if (outcome.submitted) {
      jobsRepo.setStatus(profile.id, job.id, "applied");
      const result = base({
        discovered,
        matches,
        ready: ready.length,
        discoveryMs,
        applicationMs: Date.now() - applicationStartedAt,
        applied: true,
        job: jobSummary,
        action: "submitted",
        reason: "auto-submitted — all rules passed",
        message: `Submitted ${job.title} at ${job.company}.`,
      });
      recordAudit(db, profile.id, "automation.application.complete", { trigger: "dashboard.autopilot", ...result });
      return result;
    }
    if (outcome.needsYou) {
      // Parked: a login/account wall or a CAPTCHA needs YOU before this job can proceed. Mark the
      // discovered job "blocked" so the "Needs you" queue can tell it apart from a normal queued
      // match; the runner keeps going. Nothing was submitted.
      jobsRepo.setStatus(profile.id, job.id, "blocked");
      const result = base({
        discovered,
        matches,
        ready: ready.length,
        discoveryMs,
        applicationMs: Date.now() - applicationStartedAt,
        applied: true,
        job: jobSummary,
        action: "blocked",
        reason: outcome.needsYou.label,
        message:
          outcome.needsYou.reason === "login"
            ? `${job.company}: log in once in the browser, then re-run — parked in your "Needs you" list.`
            : `${job.company}: finish the human check (CAPTCHA) in the browser, then re-run — parked in your "Needs you" list.`,
      });
      recordAudit(db, profile.id, "automation.application.complete", { trigger: "dashboard.autopilot", ...result });
      return result;
    }
    if (outcome.accountRequired) {
      jobsRepo.setStatus(profile.id, job.id, "needs_review");
      const result = base({
        discovered,
        matches,
        ready: ready.length,
        discoveryMs,
        applicationMs: Date.now() - applicationStartedAt,
        applied: true,
        job: jobSummary,
        action: "account",
        reason: `account/login required (${outcome.gate.accountAction?.kind ?? "login"})`,
        message: `${job.company}: log in once in the browser, then the runner will continue.`,
      });
      recordAudit(db, profile.id, "automation.application.complete", { trigger: "dashboard.autopilot", ...result });
      return result;
    }
    if (outcome.autoSubmitDecision?.action === "would_submit") {
      jobsRepo.setStatus(profile.id, job.id, "needs_review");
      const result = base({
        discovered,
        matches,
        ready: ready.length,
        discoveryMs,
        applicationMs: Date.now() - applicationStartedAt,
        applied: true,
        job: jobSummary,
        action: "would_submit",
        reason: outcome.autoSubmitDecision.reason,
        message: `${job.company}: ready to submit — queued for your review.`,
      });
      recordAudit(db, profile.id, "automation.application.complete", { trigger: "dashboard.autopilot", ...result });
      return result;
    }

    jobsRepo.setStatus(profile.id, job.id, "needs_review");
    const reason = outcome.autoSubmitDecision?.reason ?? "filled and paused at the review gate";
    const result = base({
      discovered,
      matches,
      ready: ready.length,
      discoveryMs,
      applicationMs: Date.now() - applicationStartedAt,
      applied: true,
      job: jobSummary,
      action: "queued",
      reason,
      message:
        opts.mode === "semi_auto"
          ? `${job.company}: prepared for review — open it from your matches, check the real form, and submit it yourself.`
          : `${job.company}: ${reason}`,
    });
    recordAudit(db, profile.id, "automation.application.complete", { trigger: "dashboard.autopilot", ...result });
    return result;
  } catch (err) {
    if (err instanceof DuplicateApplicationError) {
      jobsRepo.setStatus(profile.id, job.id, "applied");
      return base({
        discovered,
        matches,
        ready: ready.length,
        discoveryMs,
        applicationMs: Date.now() - applicationStartedAt,
        applied: false,
        job: jobSummary,
        action: "skipped",
        reason: "already submitted",
        message: `Skipped ${job.company} — already in your applied list.`,
      });
    }
    if (err instanceof RateLimitedError) {
      return base({
        discovered,
        matches,
        ready: ready.length,
        discoveryMs,
        applicationMs: Date.now() - applicationStartedAt,
        applied: false,
        job: jobSummary,
        action: "skipped",
        reason: (err as Error).message,
        message: "Slowing down to protect your account — will retry shortly.",
      });
    }
    if (err instanceof UnsupportedAtsError) {
      jobsRepo.setStatus(profile.id, job.id, "skipped");
      return base({
        discovered,
        matches,
        ready: ready.length,
        discoveryMs,
        applicationMs: Date.now() - applicationStartedAt,
        applied: false,
        job: jobSummary,
        action: "skipped",
        reason: "unsupported ATS",
        message: `Skipped ${job.company} — form type not supported yet.`,
      });
    }
    return base({
      discovered,
      matches,
      ready: ready.length,
      discoveryMs,
      applicationMs: Date.now() - applicationStartedAt,
      applied: false,
      job: jobSummary,
      action: "error",
      reason: (err as Error).message,
      message: `Error on ${job.company}: ${(err as Error).message}`,
    });
  }
}
