// src/server/dashboard-state.ts
//
// Builds the dashboard DTO from the REAL local engine (profile, ledger, companies, discovered
// jobs, applications, audit log). This is the read-only bridge between the SQLite repos and the
// Sunrise UI. The DTO shape MUST stay in sync with dashboard/src/data.ts `DashboardState`.
// Where the engine does not yet track a metric (reply rate, interviews), we return honest zeros
// rather than inventing numbers.

import type { DB } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { CompaniesRepo } from "../db/companies-repo";
import { DiscoveredJobsRepo } from "../db/discovered-jobs-repo";
import { ApplicationsRepo } from "../db/applications-repo";
import { AutomationProgressRepo, type AutomationProgress } from "../db/automation-progress-repo";
import { AccountsRepo } from "../db/accounts-repo";
import type { Fact } from "../types/facts-ledger";
import { describeFact, summarizeLedger } from "../ingestion/ledger-ops";
import { profileToForm } from "./profile-form";
import { resolveActiveProfile } from "../profile/active-profile";
import { isDisplayableDiscoveredJob, DISPLAY_MIN_SCORE } from "../jobs/actionable-jobs";
import { classifyApplyCapability } from "../jobs/apply-capability";
import { computeLiveActivity, IDLE_LIVE_ACTIVITY, type LiveActivityDTO } from "./live-activity";

type Dot = "teal" | "coral" | "yellow" | "blue";
const VIA_DOT: Record<string, Dot> = {
  greenhouse: "teal",
  lever: "coral",
  ashby: "blue",
  workday: "yellow",
  smartrecruiters: "teal",
  jobvite: "coral",
  icims: "blue",
  linkedin: "blue",
  indeed: "teal",
  glassdoor: "yellow",
  ziprecruiter: "coral",
  monster: "yellow",
  dice: "blue",
  wellfound: "teal",
  angellist: "coral",
};

export interface DashboardStateDTO {
  configured: boolean; // false => no profile yet; UI shows an empty/setup state
  llmMode: "builtin" | "bundled" | "local" | "cloud";
  pilot: { name: string; title: string; initials: string };
  rail: { automatedToday: number; readyToClick: number };
  hero: {
    live: boolean;
    queries: string[];
    metrics: { autoApplied: number; qualified: number; needOneClick: number; appliedTotal: number };
    scanCards: { status: string; company: string; dot: Dot; role?: string; active?: boolean }[];
  };
  oneClick: { id: string; company: string; role: string; reason: string; jobUrl: string; applyCapability?: string; applyCapabilityReason?: string }[];
  // Jobs an apply attempt PARKED because they need the user: a login/account wall or a CAPTCHA. Built
  // from the applications table (which carries the precise reason), de-duplicated per job, newest-first.
  blocked: { id: string; title: string; company: string; url: string; reason: "login" | "captcha"; reasonLabel: string }[];
  progress: {
    sent: number; replyRatePct: number; interviews: number; timeSavedH: number;
    bestResume: string; topCluster: string; bestSource: string;
  };
  automatedRun: { role: string; company: string; location: string; reasons: string; progressPct: number } | null;
  automationProgress: AutomationProgress;
  automatedQueue: { company: string; role: string; fit: number; status: string; dot: Dot }[];
  preflight: { label: string; ok: boolean }[];
  applied: {
    summary: { sent: number; replies: number; interviews: number; followups: number };
    pipeline: { submitted: number; response: number; interview: number; rejected: number; offer: number };
    rows: { company: string; role: string; note: string; status: "sent" | "reply" | "interview"; tag: string; action: { label: string; kind: "details" | "toast" } }[];
  };
  rules: {
    minFit: number; minSalaryK: number; autoSubmit: boolean; sendCustomToOneClick: boolean;
    excludeRelocation: boolean; followUpDays: number; blocked: string[]; coveragePct: number;
  };
  profile: {
    name: string;
    preferredName?: string;
    title: string;
    email: string;
    phone: string;
    location: string;
    links: { label: string; value: string }[];
    targetRoles: string[];
    targetIndustries: string[];
    desiredLocations: string[];
    workModes: string[];
    yearsOfExperience: string;
    jobLevel: string;
    employmentTypes: string[];
    companiesToAvoid: string[];
    compensation: string;
    workAuthorization: string;
    earliestStart: string;
    noticePeriod: string;
    relocation: string;
    screening: { label: string; value: string; ok: boolean }[];
  };
  resume: {
    approvedAt: string | null;
    summary: { total: number; approved: number; byType: Record<string, { total: number; approved: number }> };
    facts: { id: string; type: string; approved: boolean; display: string; sourceText: string; details: Record<string, unknown> }[];
  };
  packet: string[];
  coverage: {
    companyPages: number; jobBoards: number; referrals: number;
    sources: { name: string; kind: "company" | "board" | "referral"; via: string; url?: string; found: number; lastChecked: string; status: "searched" | "queued" | "blocked" }[];
  };
  // Career-site sessions — METADATA ONLY (no passwords are ever stored; logged-in means the
  // persistent browser profile is authenticated). Lets the UI show "logged in" vs "needs login".
  accounts: {
    total: number; loggedIn: number; needsLogin: number;
    rows: { domain: string; username?: string; loggedIn: boolean; lastLoginAt?: string }[];
  };
  // The most recent autopilot pass (from the audit log), so the dashboard can show what it last did.
  lastRun:
    | { at: string; mode: string; submitted: number; wouldSubmit: number; queued: number; skipped: number; considered: number }
    | null;
  log: { time: string; dot: Dot; text: string; action: string; details: string[] }[];
  /** Live continuous-runner state (null when idle). */
  runner: {
    running: boolean;
    mode: "auto" | "semi" | null;
    phase: string;
    message: string;
    cycles: number;
    submitted: number;
    queued: number;
    currentJob: { company: string; title: string; score: number } | null;
    feed?: { company: string; role?: string; status: string; dot: "teal" | "coral" | "yellow" | "blue"; active?: boolean }[];
  } | null;
  /** Live "is the pipeline filling a form right now" indicator, derived from real telemetry only. */
  liveActivity: LiveActivityDTO;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "A") + (parts[1]?.[0] ?? "")).toUpperCase();
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function idleAutomationProgress(profileId = ""): AutomationProgress {
  const now = new Date().toISOString();
  return {
    jobId: "",
    userId: profileId,
    status: "idle",
    currentStepLabel: "Automation is idle",
    totalItems: 0,
    processedItems: 0,
    qualifiedCount: 0,
    oneClickCount: 0,
    appliedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    percentComplete: 0,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    errorMessage: null,
    recentEvents: [],
  };
}

const EMPTY: DashboardStateDTO = {
  configured: false,
  llmMode: "local",
  pilot: { name: "Set up your profile", title: "Run setup + ingest to begin", initials: "AP" },
  rail: { automatedToday: 0, readyToClick: 0 },
  hero: { live: false, queries: [], metrics: { autoApplied: 0, qualified: 0, needOneClick: 0, appliedTotal: 0 }, scanCards: [] },
  oneClick: [],
  blocked: [],
  progress: { sent: 0, replyRatePct: 0, interviews: 0, timeSavedH: 0, bestResume: "—", topCluster: "—", bestSource: "—" },
  automatedRun: null,
  automationProgress: idleAutomationProgress(),
  automatedQueue: [],
  preflight: [
    { label: "Profile created", ok: false },
    { label: "Resume ledger approved", ok: false },
    { label: "Target companies added", ok: false },
  ],
  applied: { summary: { sent: 0, replies: 0, interviews: 0, followups: 0 }, pipeline: { submitted: 0, response: 0, interview: 0, rejected: 0, offer: 0 }, rows: [] },
  rules: { minFit: 70, minSalaryK: 0, autoSubmit: false, sendCustomToOneClick: true, excludeRelocation: true, followUpDays: 5, blocked: [], coveragePct: 0 },
  profile: {
    name: "Set up your profile",
    title: "Applicant",
    email: "—",
    phone: "—",
    location: "—",
    links: [],
    targetRoles: [],
    targetIndustries: [],
    desiredLocations: [],
    workModes: [],
    yearsOfExperience: "—",
    jobLevel: "—",
    employmentTypes: [],
    companiesToAvoid: [],
    compensation: "—",
    workAuthorization: "Not set",
    earliestStart: "—",
    noticePeriod: "—",
    relocation: "—",
    screening: [],
  },
  resume: { approvedAt: null, summary: { total: 0, approved: 0, byType: {} }, facts: [] },
  packet: ["Tailored resume", "Cover note", "Form answers", "Company notes"],
  coverage: { companyPages: 0, jobBoards: 0, referrals: 0, sources: [] },
  accounts: { total: 0, loggedIn: 0, needsLogin: 0, rows: [] },
  lastRun: null,
  log: [],
  runner: null,
  liveActivity: IDLE_LIVE_ACTIVITY,
};

export function buildDashboardState(
  db: DB,
  encryptionKey: Buffer | undefined,
  llmMode: DashboardStateDTO["llmMode"] = "local",
  opts: { demoMode?: boolean } = {}
): DashboardStateDTO {
  const profile = resolveActiveProfile(new ProfileRepo(db, encryptionKey), { demoMode: opts.demoMode });
  if (!profile) return EMPTY;

  const ledger = new LedgerRepo(db, encryptionKey).get(profile.id);
  const approved: Fact[] = (ledger?.facts ?? []).filter((f) => f.approved);
  const companies = new CompaniesRepo(db).list();
  const jobs = new DiscoveredJobsRepo(db).list(profile.id);
  const applications = new ApplicationsRepo(db).list(profile.id);
  const automationProgress = new AutomationProgressRepo(db).getLatest(profile.id) ?? idleAutomationProgress(profile.id);
  const auditRows = db
    .prepare("SELECT ts, action, detail FROM audit_log WHERE profile_id = ? ORDER BY ts DESC LIMIT 12")
    .all(profile.id) as { ts: string; action: string; detail: string | null }[];

  const c = profile.contact;
  const name = `${c.preferredName?.trim() || c.legalFirstName} ${c.legalLastName}`.trim() || "Applicant";
  const recentTitle = approved.find((f) => f.type === "employment") as { title?: string } | undefined;

  const appliedDedup = new Set(applications.map((a) => a.dedupKey));
  // Surface matches the user can review/queue at the looser display floor — not the conservative
  // apply-recommended floor — so the command center and one-click queue don't read 0 whenever
  // scores sit below 0.75. Applying is always review-gated; nothing here triggers an auto-submit.
  const displayFloor = DISPLAY_MIN_SCORE;
  const ready = jobs.filter((j) => isDisplayableDiscoveredJob(j, { minScore: displayFloor, appliedDedup }));
  const submitted = applications.filter((a) => a.submitted);
  const needsReview = applications.filter((a) => a.status === "needs_review");

  // "Needs you" queue: apply attempts PARKED at a login/account wall or a CAPTCHA. The applications
  // table carries the precise reason (account_required = login, challenge = CAPTCHA); join to the
  // discovered job for its title/company/apply-url. Newest-first (applications are ordered DESC),
  // de-duplicated to one entry per job, capped.
  const jobByDedup = new Map(jobs.map((j) => [j.dedupKey, j]));
  const blockedSeen = new Set<string>();
  const blocked = applications
    .filter((a) => a.status === "account_required" || a.status === "challenge")
    .filter((a) => (blockedSeen.has(a.dedupKey) ? false : (blockedSeen.add(a.dedupKey), true)))
    .slice(0, 50)
    .map((a) => {
      const job = jobByDedup.get(a.dedupKey);
      const login = a.status === "account_required";
      return {
        id: job?.id ?? a.id,
        title: job?.title ?? a.title ?? "—",
        company: job?.company ?? a.company ?? "—",
        url: job?.jobUrl ?? a.url ?? "",
        reason: (login ? "login" : "captcha") as "login" | "captcha",
        reasonLabel: login ? "Log in / account needed" : "CAPTCHA / human check",
      };
    });

  // Coverage sources: one row per company board, with the roles found there.
  const sources = companies.map((co) => {
    const found = jobs.filter((j) => j.company === co.name);
    const last = found.map((j) => j.discoveredAt).sort().at(-1);
    return {
      name: co.name,
      kind: "company" as const,
      via: cap(co.atsType),
      url: co.boardUrl.replace(/^https?:\/\//, ""),
      found: found.length,
      lastChecked: last ? fmtTime(last) : "—",
      status: (co.enabled ? (found.length ? "searched" : "queued") : "blocked") as "searched" | "queued" | "blocked",
    };
  });

  // Most productive ATS, for "best source".
  const byAts = new Map<string, number>();
  for (const j of jobs) byAts.set(j.atsType, (byAts.get(j.atsType) ?? 0) + 1);
  const bestSource = [...byAts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // Career-site sessions (metadata only — never a password).
  const accountList = new AccountsRepo(db).list(profile.id);
  const accounts = {
    total: accountList.length,
    loggedIn: accountList.filter((a) => a.loggedIn).length,
    needsLogin: accountList.filter((a) => !a.loggedIn).length,
    rows: accountList.slice(0, 8).map((a) => ({
      domain: a.domain,
      ...(a.username ? { username: a.username } : {}),
      loggedIn: a.loggedIn,
      ...(a.lastLoginAt ? { lastLoginAt: fmtTime(a.lastLoginAt) } : {}),
    })),
  };

  // Most recent autopilot pass, from the audit log.
  const lastRunRow = db
    .prepare("SELECT ts, detail FROM audit_log WHERE profile_id = ? AND action = 'autopilot.run' ORDER BY ts DESC LIMIT 1")
    .get(profile.id) as { ts: string; detail: string | null } | undefined;
  let lastRun: DashboardStateDTO["lastRun"] = null;
  if (lastRunRow) {
    let d: Record<string, unknown> = {};
    try {
      d = lastRunRow.detail ? (JSON.parse(lastRunRow.detail) as Record<string, unknown>) : {};
    } catch {
      /* ignore */
    }
    lastRun = {
      at: fmtTime(lastRunRow.ts),
      mode: String(d.mode ?? "semi_auto"),
      submitted: Number(d.submitted ?? 0),
      wouldSubmit: Number(d.wouldSubmit ?? 0),
      queued: Number(d.queued ?? 0),
      skipped: Number(d.skipped ?? 0),
      considered: Number(d.considered ?? 0),
    };
  }

  const queries: string[] = [];
  const comp = profile.preferences.compensation;
  if (comp.desiredBaseMin) queries.push(`$${Math.round(comp.desiredBaseMin / 1000)}k+ base`);
  if (profile.preferences.desiredLocations.length) queries.push(profile.preferences.desiredLocations.slice(0, 2).join(" / "));
  queries.push("US roles only");
  if (profile.workAuthorization.requiresSponsorshipNowOrFuture.value === false) queries.push("No sponsorship needed");

  return {
    configured: true,
    llmMode,
    pilot: { name, title: recentTitle?.title ?? "Applicant", initials: initials(name) },
    rail: { automatedToday: submitted.length, readyToClick: ready.length },
    hero: {
      live: false,
      queries: queries.slice(0, 4),
      metrics: {
        autoApplied: submitted.length,
        qualified: jobs.filter((j) => isDisplayableDiscoveredJob(j, { minScore: displayFloor })).length,
        needOneClick: ready.length,
        appliedTotal: applications.length,
      },
      scanCards: applications.slice(0, 3).map((a) => ({
        status: a.submitted ? "Submitted" : a.status === "needs_review" ? "Ready to apply" : a.status === "challenge" ? "Paused" : "Skipped",
        company: a.company ?? "—",
        dot: (a.submitted ? "teal" : a.status === "needs_review" ? "yellow" : "coral") as Dot,
      })),
    },
    oneClick: ready.slice(0, 7).map((j) => {
      const capability = classifyApplyCapability(j.jobUrl);
      return {
        id: j.id,
        company: j.company,
        role: j.title,
        reason: j.rationale || (capability.capability === "supported_form_fill" ? "Tailored and ready to prefill" : capability.reason),
        jobUrl: j.jobUrl,
        applyCapability: capability.capability,
        applyCapabilityReason: capability.reason,
      };
    }),
    blocked,
    progress: {
      sent: applications.length,
      replyRatePct: 0,
      interviews: 0,
      timeSavedH: Math.round(submitted.length * 0.4 * 10) / 10,
      bestResume: profile.masterResumePath ? "Master resume" : "—",
      topCluster: recentTitle?.title ?? "—",
      bestSource: bestSource ? cap(bestSource) : "Company career pages",
    },
    automatedRun: null,
    automationProgress,
    automatedQueue: ready
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((j) => ({ company: j.company, role: j.title, fit: Math.round(j.score * 100), status: "scored, ready", dot: (VIA_DOT[j.atsType] ?? "teal") as Dot })),
    preflight: [
      { label: "Profile created", ok: true },
      { label: "Resume ledger approved", ok: approved.length > 0 },
      { label: "Contact details complete", ok: Boolean(c.email && c.phone) },
      { label: "Work authorization set", ok: profile.workAuthorization.authorizedToWorkInUS.source === "user" },
      { label: "Target companies added", ok: companies.length > 0 },
    ],
    applied: {
      summary: { sent: submitted.length, replies: 0, interviews: 0, followups: needsReview.length },
      pipeline: { submitted: submitted.length, response: 0, interview: 0, rejected: 0, offer: 0 },
      rows: applications.slice(0, 8).map((a) => ({
        company: a.company ?? "—",
        role: a.title ?? "—",
        note: `${a.status.replace("_", " ")} • ${fmtTime(a.createdAt)}`,
        status: "sent" as const,
        tag: a.submitted ? "Submitted" : a.status === "needs_review" ? "Needs review" : a.status === "challenge" ? "Paused" : cap(a.status),
        action: { label: "Details", kind: "details" as const },
      })),
    },
    rules: {
      minFit: 70,
      minSalaryK: comp.desiredBaseMin ? Math.round(comp.desiredBaseMin / 1000) : 0,
      autoSubmit: false,
      sendCustomToOneClick: true,
      excludeRelocation: profile.preferences.willingToRelocate.value === false,
      followUpDays: 5,
      blocked: [...companies.filter((co) => !co.enabled).map((co) => co.name), ...(profile.preferences.companiesToAvoid ?? [])],
      coveragePct: ready.length ? Math.round((submitted.length / (submitted.length + ready.length)) * 100) : 0,
    },
    profile: profilePayload(profile, recentTitle?.title ?? "Applicant"),
    resume: ledger ? resumePayload(ledger) : EMPTY.resume,
    packet: ["Tailored resume", "Cover note", "Form answers", "Company notes"],
    coverage: {
      companyPages: companies.length,
      jobBoards: new Set(companies.map((co) => co.atsType)).size,
      referrals: 0,
      sources,
    },
    accounts,
    lastRun,
    log: auditRows.map((r) => {
      const text = describeAudit(r.action, r.detail);
      // Drop detail lines that just repeat the headline text (or the raw detail string the headline
      // already rendered) so each log entry reads once, not two or three times.
      const details = describeAuditDetails(r.detail).filter((d) => d !== text && d !== r.detail);
      return { time: fmtTime(r.ts), dot: dotForAction(r.action), text, action: r.action, details };
    }),
    runner: null,
    liveActivity: computeLiveActivity({
      progress: {
        status: automationProgress.status,
        currentStepLabel: automationProgress.currentStepLabel,
        startedAt: automationProgress.startedAt,
        percentComplete: automationProgress.percentComplete,
        completedAt: automationProgress.completedAt,
      },
    }),
  };
}

function yn(value: "" | "yes" | "no"): string {
  return value === "yes" ? "Yes" : value === "no" ? "No" : "Not set";
}

function profilePayload(profile: NonNullable<ReturnType<ProfileRepo["getFirst"]>>, title: string): DashboardStateDTO["profile"] {
  const f = profileToForm(profile);
  const name = `${f.preferredName || f.legalFirstName} ${f.legalLastName}`.trim() || "Applicant";
  const links = [
    f.linkedin ? { label: "LinkedIn", value: f.linkedin } : null,
    f.github ? { label: "GitHub", value: f.github } : null,
    f.portfolio ? { label: "Portfolio", value: f.portfolio } : null,
  ].filter((link): link is { label: string; value: string } => Boolean(link));
  const salaryMin = Number(f.desiredBaseMin);
  const salaryMax = Number(f.desiredBaseMax);
  const compensation =
    salaryMin && salaryMax ? `$${Math.round(salaryMin / 1000)}k-$${Math.round(salaryMax / 1000)}k base` :
    salaryMin ? `$${Math.round(salaryMin / 1000)}k+ base` :
    f.isNegotiable ? "Negotiable" : "Not set";
  const auth = f.authorizedToWorkInUS === "yes" ? "Authorized" : f.authorizedToWorkInUS === "no" ? "Not authorized" : "Authorization not set";
  const sponsor = f.requiresSponsorship === "yes" ? "needs sponsorship" : f.requiresSponsorship === "no" ? "no sponsorship" : "sponsorship not set";
  return {
    name,
    ...(f.preferredName ? { preferredName: f.preferredName } : {}),
    title,
    email: f.email || "—",
    phone: f.phone || "—",
    location: [f.city, f.state].filter(Boolean).join(", ") || "—",
    links,
    targetRoles: profile.preferences.targetRoles,
    targetIndustries: profile.preferences.targetIndustries ?? [],
    desiredLocations: profile.preferences.desiredLocations,
    workModes: f.workModes,
    yearsOfExperience: f.yearsOfExperience ? `${f.yearsOfExperience} years` : "—",
    jobLevel: f.jobLevel ? cap(f.jobLevel) : "—",
    employmentTypes: f.employmentTypes ?? [],
    companiesToAvoid: profile.preferences.companiesToAvoid ?? [],
    compensation,
    workAuthorization: `${auth}, ${sponsor}`,
    earliestStart: f.earliestStartDate || "—",
    noticePeriod: f.noticePeriodDays ? `${f.noticePeriodDays} days` : "—",
    relocation: f.willingToRelocate === "yes" ? "Open to relocate" : f.willingToRelocate === "no" ? "No relocation" : "Not set",
    screening: [
      { label: "18 or older", value: yn(f.isAtLeast18), ok: f.isAtLeast18 === "yes" },
      { label: "Essential functions", value: yn(f.canPerformEssentialFunctions), ok: f.canPerformEssentialFunctions === "yes" },
      { label: "Accommodation process", value: yn(f.requiresAccommodationForProcess), ok: f.requiresAccommodationForProcess === "no" },
    ],
  };
}

function resumePayload(ledger: NonNullable<ReturnType<LedgerRepo["get"]>>): DashboardStateDTO["resume"] {
  return {
    approvedAt: ledger.approvedAt ?? null,
    summary: summarizeLedger(ledger),
    facts: ledger.facts.map((f) => ({
      id: f.id,
      type: f.type,
      approved: f.approved,
      display: describeFact(f),
      sourceText: f.sourceText ?? "",
      details: factDetails(f),
    })),
  };
}

function factDetails(f: Fact): Record<string, unknown> {
  const details: Record<string, unknown> = { ...f };
  delete details.id;
  delete details.type;
  delete details.approved;
  delete details.sourceText;
  return details;
}

function dotForAction(action: string): Dot {
  if (action.startsWith("application")) return action.includes("challenge") ? "coral" : "teal";
  if (action.startsWith("discovery")) return "blue";
  if (action.startsWith("documents")) return "yellow";
  return "teal";
}

function describeAudit(action: string, detail: string | null): string {
  let d: Record<string, unknown> = {};
  try {
    d = detail ? (JSON.parse(detail) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  switch (action) {
    case "discovery.run":
      return `Searched ${d.companies ?? "?"} company boards and added ${d.added ?? 0} roles.`;
    case "application.fill":
      return `Filled ${d.company ?? "an application"} and paused at the review gate (nothing submitted).`;
    case "application.challenge":
      return `Hit a CAPTCHA/login wall at ${d.ats ?? "a site"} and handed you the browser.`;
    case "autopilot.run":
      return `Legacy autopilot pass: ${d.queued ?? 0} queued, ${d.submitted ?? 0} submitted, ${d.skipped ?? 0} skipped.`;
    case "automation.cycle":
      return `Automation cycle ${d.cycles ?? "?"}: ${d.action ?? "searched"} ${d.company ? `at ${d.company}` : ""}.`.trim();
    case "documents.generate":
      return `Generated a tailored resume + cover letter for ${d.title ?? "a role"} at ${d.company ?? "a company"}.`;
    case "resume.ingest":
      return `Ingested your resume (${d.approved ?? 0} approved facts).`;
    case "profile.save":
      return `Saved your profile.`;
    case "ledger.save":
      return `Updated the facts ledger (${d.approvedCount ?? 0} approved).`;
    default: {
      // Humanize an unmapped action (e.g. "automation.discovery.complete" -> "Automation discovery
      // complete") so the log headline reads as prose and isn't an exact echo of the raw action tag.
      const words = action.replace(/[._]+/g, " ").trim();
      return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
    }
  }
}

function describeAuditDetails(detail: string | null): string[] {
  let d: Record<string, unknown> = {};
  try {
    d = detail ? (JSON.parse(detail) as Record<string, unknown>) : {};
  } catch {
    return detail ? [detail] : [];
  }
  return Object.entries(d)
    .flatMap(([key, value]) => detailValue(`${humanizeKey(key)}:`, value))
    .slice(0, 8);
}

function detailValue(prefix: string, value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [`${prefix} ${value.map((item) => readableValue(item)).join(", ")}`];
  }
  return [`${prefix} ${readableValue(value)}`];
}

function readableValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
