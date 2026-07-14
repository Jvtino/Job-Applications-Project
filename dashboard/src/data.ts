// Dashboard data model. Shapes mirror the local engine (discovered_jobs, applications, scoring,
// review gate, automation rules). For increment 1 these are MOCK values matching the Sunrise
// design; increment 2 replaces `useDashboardData` with a fetch from the local /api.

export interface DashboardState {
  pilot: { name: string; title: string; initials: string };
  llmMode?: "builtin" | "bundled" | "local" | "cloud";
  rail: { automatedToday: number; readyToClick: number };
  hero: {
    live: boolean;
    queries: string[];
    metrics: { autoApplied: number; qualified: number; needOneClick: number; appliedTotal: number };
    scanCards: { status: string; company: string; dot: "teal" | "coral" | "yellow" | "blue"; role?: string; active?: boolean }[];
  };
  oneClick: { id: string; company: string; role: string; reason: string; jobUrl: string; applyCapability?: string; applyCapabilityReason?: string }[];
  progress: {
    sent: number;
    replyRatePct: number;
    interviews: number;
    timeSavedH: number;
    bestResume: string;
    topCluster: string;
    bestSource: string;
  };
  automatedRun: { role: string; company: string; location: string; reasons: string; progressPct: number } | null;
  automationProgress: AutomationProgress;
  automatedQueue: { company: string; role: string; fit: number; status: string; dot: "teal" | "coral" | "yellow" | "blue" }[];
  preflight: { label: string; ok: boolean }[];
  applied: {
    summary: { sent: number; replies: number; interviews: number; followups: number };
    pipeline: { submitted: number; response: number; interview: number; rejected: number; offer: number };
    rows: {
      company: string;
      role: string;
      note: string;
      status: "sent" | "reply" | "interview";
      tag: string;
      action: { label: string; kind: "details" | "toast" };
    }[];
  };
  rules: {
    minFit: number;
    minSalaryK: number;
    autoSubmit: boolean;
    sendCustomToOneClick: boolean;
    excludeRelocation: boolean;
    followUpDays: number;
    blocked: string[];
    coveragePct: number;
  };
  profile: ProfileSnapshot;
  resume: LedgerData;
  packet: string[];
  coverage: {
    companyPages: number;
    jobBoards: number;
    referrals: number;
    /** The actual places searches ran (career pages, ATS boards, and supported job-search sources). */
    sources: SearchSource[];
  };
  /** Career-site sessions — metadata only, never passwords. */
  accounts: {
    total: number;
    loggedIn: number;
    needsLogin: number;
    rows: { domain: string; username?: string; loggedIn: boolean; lastLoginAt?: string }[];
  };
  /** The most recent autopilot pass (from the audit log), or null if it has never run. */
  lastRun:
    | { at: string; mode: string; submitted: number; wouldSubmit: number; queued: number; skipped: number; considered: number }
    | null;
  log: { time: string; dot: "teal" | "coral" | "yellow" | "blue"; text: string; action?: string; details?: string[] }[];
  /** Live continuous automation runner (null when idle). */
  runner?: {
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
  /** Live "is the pipeline filling a form right now" indicator, derived server-side from real
   *  telemetry only (open apply session > automation pass > discovery pass). */
  liveActivity?: LiveActivityDTO;
  /** Applications the pilot PARKED because they need the user in person — a login/account wall or a
   *  CAPTCHA. Surfaced on the "Needs you" tab so one blocked job never hides in the normal queue.
   *  Optional: older engines omit it, so read it as `state.blocked ?? []`. */
  blocked?: BlockedApplication[];
}

/** One parked application awaiting the user (mirrors the engine's blocked-application payload). */
export interface BlockedApplication {
  id: string;
  title: string;
  company: string;
  url: string;
  /** Why the pilot had to stop: a login/account wall or a CAPTCHA it will never solve. */
  reason: "login" | "captcha";
  /** Human-readable version of `reason`, provided by the engine. */
  reasonLabel: string;
}

/** Mirrors src/server/live-activity.ts LiveActivityDTO. */
export interface LiveActivityDTO {
  active: boolean;
  kind: "filling" | "tailoring" | "discovering" | "idle";
  stageLabel: string;
  detail: string | null;
  company: string | null;
  role: string | null;
  startedAt: string | null;
  percent: number | null;
  source: "apply_session" | "automation_pass" | "discovery" | "none";
}

/** One automation pass, from GET /api/runs (mirrors the handler in src/server/api.ts). */
export interface AutomationRun {
  id: string;
  status: string;
  currentStepLabel: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  counts: { total: number; processed: number; qualified: number; oneClick: number; applied: number; failed: number; skipped: number };
  errorMessage: string | null;
  events: string[];
}

export type AutomationProgressStatus =
  | "idle"
  | "queued"
  | "discovering"
  | "matching"
  | "preparing_packet"
  | "applying"
  | "completed"
  | "failed"
  | "paused"
  | "needs_review";

export interface AutomationProgress {
  jobId: string;
  userId: string;
  status: AutomationProgressStatus;
  currentStepLabel: string;
  totalItems: number;
  processedItems: number;
  qualifiedCount: number;
  oneClickCount: number;
  appliedCount: number;
  failedCount: number;
  skippedCount: number;
  percentComplete: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  recentEvents: string[];
}

export interface SearchSource {
  name: string;
  kind: "company" | "board" | "referral";
  /** Which ATS/board the company hosts its own apply form on. */
  via: "Greenhouse" | "Lever" | "Ashby" | "Referral";
  url?: string;
  found: number;
  lastChecked: string;
  status: "searched" | "queued" | "blocked";
}

export const MOCK_STATE: DashboardState = {
  pilot: { name: "Ahmet Kaya", title: "Senior product leadership", initials: "AK" },
  llmMode: "local",
  rail: { automatedToday: 14, readyToClick: 7 },
  hero: {
    live: true,
    queries: ["92% fit minimum", "$160k+ verified", "Remote or NYC", "No relocation"],
    metrics: { autoApplied: 14, qualified: 23, needOneClick: 7, appliedTotal: 21 },
    scanCards: [
      { status: "Auto-sent", company: "Daybreak AI", dot: "teal" },
      { status: "Drafting", company: "Northstar Labs", dot: "coral" },
      { status: "Skipped", company: "Travel required", dot: "yellow" },
    ],
  },
  oneClick: [
    { id: "1", company: "Northstar Labs", role: "Head of Product, Applied AI", reason: "Equity answer needs your preference", jobUrl: "https://job-boards.greenhouse.io/northstarlabs/jobs/1" },
    { id: "2", company: "Copperline", role: "Growth Product Lead", reason: "Hybrid schedule needs approval", jobUrl: "https://job-boards.greenhouse.io/copperline/jobs/2" },
    { id: "3", company: "Bright Cart", role: "Director, Product Operations", reason: "Salary range is close to threshold", jobUrl: "https://jobs.lever.co/brightcart/3" },
  ],
  progress: {
    sent: 63,
    replyRatePct: 18,
    interviews: 7,
    timeSavedH: 11.4,
    bestResume: "AI workflow leadership",
    topCluster: "Applied AI product",
    bestSource: "Company career pages",
  },
  automatedRun: {
    role: "Staff Product Manager",
    company: "Daybreak AI",
    location: "Remote US",
    reasons: "clears fit, salary, location, and answer confidence",
    progressPct: 74,
  },
  automationProgress: {
    jobId: "sample",
    userId: "sample",
    status: "needs_review",
    currentStepLabel: "Automation completed; review required",
    totalItems: 9,
    processedItems: 9,
    qualifiedCount: 23,
    oneClickCount: 7,
    appliedCount: 14,
    failedCount: 0,
    skippedCount: 2,
    percentComplete: 100,
    startedAt: "2026-06-24T14:00:00.000Z",
    updatedAt: "2026-06-24T14:12:00.000Z",
    completedAt: "2026-06-24T14:12:00.000Z",
    errorMessage: null,
    recentEvents: ["Automation completed", "Application requires manual review", "Application submitted successfully"],
  },
  automatedQueue: [
    { company: "Fable Works", role: "Senior PM, Automation", fit: 94, status: "queued for auto-submit", dot: "teal" },
    { company: "Orbit Desk", role: "Product Lead, AI Tools", fit: 93, status: "tailoring answers", dot: "blue" },
  ],
  preflight: [
    { label: "Resume tailored to role", ok: true },
    { label: "Salary clears threshold", ok: true },
    { label: "Location matches rules", ok: true },
    { label: "Required answers filled", ok: true },
    { label: "Job post looks legitimate", ok: true },
  ],
  applied: {
    summary: { sent: 21, replies: 6, interviews: 3, followups: 5 },
    pipeline: { submitted: 12, response: 6, interview: 3, rejected: 4, offer: 0 },
    rows: [
      { company: "Daybreak AI", role: "Staff Product Manager", note: "auto-applied today at 9:42 PM", status: "sent", tag: "Submitted", action: { label: "Details", kind: "details" } },
      { company: "Fable Works", role: "Senior PM, Automation", note: "recruiter replied 2 hours ago", status: "reply", tag: "Response", action: { label: "Reply", kind: "toast" } },
      { company: "Orbit Desk", role: "Product Lead, AI Tools", note: "interview scheduled Friday", status: "interview", tag: "Interview", action: { label: "Prep", kind: "toast" } },
    ],
  },
  rules: {
    minFit: 92,
    minSalaryK: 160,
    autoSubmit: true,
    sendCustomToOneClick: true,
    excludeRelocation: true,
    followUpDays: 5,
    blocked: ["Acme Staffing", "LowSignal Jobs", "Unknown salary"],
    coveragePct: 87,
  },
  profile: {
    name: "Ahmet Kaya",
    preferredName: "Ahmet",
    title: "Senior product leadership",
    email: "ahmet.kaya@example.com",
    phone: "(555) 010-2040",
    location: "New York, NY",
    links: [
      { label: "LinkedIn", value: "linkedin.com/in/ahmetkaya" },
      { label: "Portfolio", value: "ahmetkaya.com" },
    ],
    targetRoles: ["Head of Product", "Senior Product Manager"],
    targetIndustries: ["AI", "SaaS"],
    desiredLocations: ["Remote US", "New York City"],
    workModes: ["remote", "hybrid"],
    yearsOfExperience: "10 years",
    jobLevel: "Director",
    employmentTypes: ["full_time"],
    companiesToAvoid: ["Acme Staffing"],
    compensation: "$160k-$220k base",
    workAuthorization: "Authorized, no sponsorship",
    earliestStart: "Immediate",
    noticePeriod: "14 days",
    relocation: "No relocation",
    screening: [
      { label: "18 or older", value: "Yes", ok: true },
      { label: "Essential functions", value: "Yes", ok: true },
      { label: "Accommodation process", value: "No", ok: true },
    ],
  },
  resume: {
    approvedAt: null,
    summary: {
      total: 8,
      approved: 5,
      byType: {
        employment: { total: 2, approved: 2 },
        skill: { total: 3, approved: 2 },
        education: { total: 1, approved: 1 },
        metric: { total: 2, approved: 0 },
      },
    },
    facts: [
      {
        id: "sample-employment-1",
        type: "employment",
        approved: true,
        display: "[employment] Head of Product @ Daybreak AI (2022-present) — 2 bullet(s)",
        sourceText: "Head of Product, Daybreak AI, 2022-present",
        details: {
          employer: "Daybreak AI",
          title: "Head of Product",
          startDate: "2022",
          endDate: "present",
          bullets: ["Led AI workflow launches", "Improved qualified activation by 28%"],
        },
      },
      {
        id: "sample-skill-1",
        type: "skill",
        approved: true,
        display: "[skill] AI product strategy",
        sourceText: "AI product strategy, automation systems, growth experimentation",
        details: { statement: "AI product strategy" },
      },
      {
        id: "sample-education-1",
        type: "education",
        approved: true,
        display: "[education] MBA — NYU Stern",
        sourceText: "MBA, NYU Stern",
        details: { degree: "MBA", institution: "NYU Stern" },
      },
    ],
  },
  packet: ["Tailored resume", "Cover note", "Form answers", "Company notes"],
  coverage: {
    companyPages: 42,
    jobBoards: 31,
    referrals: 12,
    sources: [
      { name: "Daybreak AI", kind: "company", via: "Greenhouse", url: "job-boards.greenhouse.io/daybreakai", found: 3, lastChecked: "9:42 PM", status: "searched" },
      { name: "Ramp", kind: "company", via: "Ashby", url: "jobs.ashbyhq.com/ramp", found: 9, lastChecked: "9:40 PM", status: "searched" },
      { name: "1Password", kind: "company", via: "Ashby", url: "jobs.ashbyhq.com/1password", found: 6, lastChecked: "9:38 PM", status: "searched" },
      { name: "HighLevel", kind: "company", via: "Lever", url: "jobs.lever.co/gohighlevel", found: 4, lastChecked: "9:35 PM", status: "searched" },
      { name: "Northstar Labs", kind: "company", via: "Greenhouse", url: "job-boards.greenhouse.io/northstarlabs", found: 2, lastChecked: "9:31 PM", status: "searched" },
      { name: "Fable Works", kind: "company", via: "Lever", url: "jobs.lever.co/fableworks", found: 5, lastChecked: "9:28 PM", status: "searched" },
      { name: "Orbit Desk", kind: "company", via: "Ashby", url: "jobs.ashbyhq.com/orbitdesk", found: 3, lastChecked: "9:24 PM", status: "searched" },
      { name: "Copperline", kind: "company", via: "Greenhouse", url: "job-boards.greenhouse.io/copperline", found: 1, lastChecked: "9:20 PM", status: "queued" },
      { name: "Bright Cart", kind: "company", via: "Lever", url: "jobs.lever.co/brightcart", found: 0, lastChecked: "9:16 PM", status: "searched" },
      { name: "Warm intro — ex-colleague @ Daybreak AI", kind: "referral", via: "Referral", found: 1, lastChecked: "9:05 PM", status: "searched" },
      { name: "Acme Staffing", kind: "company", via: "Greenhouse", url: "job-boards.greenhouse.io/acmestaffing", found: 0, lastChecked: "—", status: "blocked" },
    ],
  },
  accounts: {
    total: 3,
    loggedIn: 2,
    needsLogin: 1,
    rows: [
      { domain: "jobs.ashbyhq.com", username: "ahmet.kaya@example.com", loggedIn: true, lastLoginAt: "9:12 PM" },
      { domain: "job-boards.greenhouse.io", loggedIn: true, lastLoginAt: "8:51 PM" },
      { domain: "jobs.lever.co", username: "ahmet.kaya@example.com", loggedIn: false },
    ],
  },
  lastRun: { at: "9:42 PM", mode: "semi_auto", submitted: 0, wouldSubmit: 0, queued: 3, skipped: 1, considered: 4 },
  log: [
    { time: "9:42 PM", dot: "teal", text: "Auto-submitted Daybreak AI after fit, salary, and location checks passed.", action: "application.submit", details: ["Company: Daybreak AI", "Result: submitted after fit, salary, and location checks"] },
    { time: "9:38 PM", dot: "yellow", text: "Moved Northstar to one-click because the equity answer needs preference approval.", action: "review.queue", details: ["Company: Northstar", "Reason: equity answer needs preference approval"] },
    { time: "9:31 PM", dot: "coral", text: "Skipped a role with mandatory relocation and logged the reason.", action: "application.skip", details: ["Reason: mandatory relocation"] },
  ],
  blocked: [
    { id: "blk-1", title: "Head of Product, Applied AI", company: "Northstar Labs", url: "https://job-boards.greenhouse.io/northstarlabs/jobs/1", reason: "login", reasonLabel: "Sign in to continue" },
    { id: "blk-2", title: "Director, Product Operations", company: "Bright Cart", url: "https://jobs.lever.co/brightcart/3", reason: "captcha", reasonLabel: "CAPTCHA to solve" },
  ],
};

export const EMPTY_STATE: DashboardState = {
  ...MOCK_STATE,
  pilot: { name: "ApplyPilot", title: "Local pipeline unavailable", initials: "AP" },
  rail: { automatedToday: 0, readyToClick: 0 },
  hero: {
    live: false,
    queries: [],
    metrics: { autoApplied: 0, qualified: 0, needOneClick: 0, appliedTotal: 0 },
    scanCards: [],
  },
  oneClick: [],
  progress: { sent: 0, replyRatePct: 0, interviews: 0, timeSavedH: 0, bestResume: "—", topCluster: "—", bestSource: "—" },
  automatedRun: null,
  automationProgress: {
    jobId: "",
    userId: "",
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
    startedAt: "",
    updatedAt: "",
    completedAt: null,
    errorMessage: null,
    recentEvents: [],
  },
  automatedQueue: [],
  preflight: [],
  applied: { summary: { sent: 0, replies: 0, interviews: 0, followups: 0 }, pipeline: { submitted: 0, response: 0, interview: 0, rejected: 0, offer: 0 }, rows: [] },
  profile: {
    name: "ApplyPilot",
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
  coverage: { companyPages: 0, jobBoards: 0, referrals: 0, sources: [] },
  accounts: { total: 0, loggedIn: 0, needsLogin: 0, rows: [] },
  lastRun: null,
  log: [],
  runner: null,
  blocked: [],
};

/** A real API response adds `configured`. */
export type ApiState = DashboardState & { configured: boolean };

export interface DashboardData {
  state: DashboardState;
  configured: boolean;
  loading: boolean;
  error: string | null;
  authRequired: boolean;
  /** True when showing an explicit non-local snapshot/demo surface. Live local failures do not use samples. */
  usingSample: boolean;
  reload: () => void;
}

import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, apiJson, isAuthStatus } from "./api";
import type { ApiDownload } from "./api";

export function useDashboardData(): DashboardData {
  const [state, setState] = useState<DashboardState>(EMPTY_STATE);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [usingSample, setUsingSample] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAuthRequired(false);
    apiJson<ApiState>("/api/state")
      .then((data) => {
        if (cancelled) return;
        const { configured: cfg, ...rest } = data;
        setState(rest as DashboardState);
        setConfigured(cfg);
        setAuthRequired(false);
        setUsingSample(false);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        const locked = e instanceof ApiRequestError && isAuthStatus(e.status);
        setState(EMPTY_STATE);
        setConfigured(false);
        setAuthRequired(locked);
        // Live local failures block the operational dashboard instead of showing plausible samples.
        // API locked keeps an empty shell up and lets App show the token prompt.
        setUsingSample(false);
        setError(String(e.message ?? e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, configured, loading, error, authRequired, usingSample, reload };
}

/**
 * Fetch the reviewable discovered jobs. Pass `null` for the server's DEFAULT view — the curated
 * display gate (loose floor + "always show your best matches" backfill). Passing a number forces a
 * strict score cutoff and disables the backfill; only do that when the user explicitly asked for a
 * hard filter. A low score should hide a job from *recommendations*, never from *review*.
 */
export function useDiscoveredJobs(minFitPct: number | null, refreshNonce = 0, employerOnly = false): {
  jobs: DiscoveredJobRow[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [jobs, setJobs] = useState<DiscoveredJobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (minFitPct != null) params.set("minScore", String(minFitPct / 100));
    if (employerOnly) params.set("employerOnly", "1"); // hide aggregator (LinkedIn/Indeed) leads
    const query = params.toString() ? `?${params.toString()}` : "";
    apiJson<{ jobs: DiscoveredJobRow[] }>(`/api/discovered-jobs${query}`)
      .then((data) => {
        if (cancelled) return;
        setJobs((data.jobs ?? []).map((j) => ({ ...j, tags: j.tags ?? [] })));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setJobs([]);
        setError(String(e.message ?? e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [minFitPct, refreshNonce, nonce, employerOnly]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { jobs, loading, error, reload };
}

/** Fetch the pre-filled LinkedIn/Indeed search URLs the user opens in their OWN browser (§8.6). */
export function fetchAssistedSearch(): Promise<{
  keywords: string | null;
  location: string | null;
  linkedin: string | null;
  indeed: string | null;
}> {
  return apiJson("/api/assisted-search");
}

export function useApplicationDrafts(refreshNonce = 0, enabled = true): {
  drafts: ApplicationDraft[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  setStatus: (id: string, status: ApplicationDraftStatus) => Promise<ApplicationDraft[]>;
} {
  const [drafts, setDrafts] = useState<ApplicationDraft[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setDrafts([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiJson<{ drafts: ApplicationDraft[] }>("/api/application-drafts")
      .then((data) => {
        if (cancelled) return;
        setDrafts(data.drafts ?? []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setDrafts([]);
        setError(String(e.message ?? e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshNonce, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setStatus = useCallback(async (id: string, status: ApplicationDraftStatus) => {
    const data = await apiJson<{ drafts: ApplicationDraft[] }>("/api/application-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    const next = data.drafts ?? [];
    setDrafts(next);
    return next;
  }, []);
  return { drafts, loading, error, reload, setStatus };
}

export function useRuns(refreshNonce = 0, enabled = true): {
  runs: AutomationRun[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setRuns([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiJson<{ runs: AutomationRun[] }>("/api/runs")
      .then((d) => {
        if (cancelled) return;
        setRuns(d.runs ?? []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setRuns([]);
        setError(String(e.message ?? e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshNonce, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { runs, loading, error, reload };
}

export function useApplications(refreshNonce = 0, enabled = true): {
  applications: ApplicationDetail[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [applications, setApplications] = useState<ApplicationDetail[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setApplications([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiJson<{ applications: ApplicationDetail[] }>("/api/applications")
      .then((d) => {
        if (cancelled) return;
        setApplications(d.applications ?? []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setApplications([]);
        setError(String(e.message ?? e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshNonce, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { applications, loading, error, reload };
}

/** Flat, editable profile shape — mirrors src/server/profile-form.ts `ProfileForm`. */
export interface ProfileForm {
  legalFirstName: string;
  legalLastName: string;
  preferredName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  linkedin: string;
  github: string;
  portfolio: string;
  authorizedToWorkInUS: "" | "yes" | "no";
  requiresSponsorship: "" | "yes" | "no";
  currentWorkStatus: "" | "us_citizen" | "permanent_resident" | "visa_holder" | "other";
  earliestStartDate: string;
  noticePeriodDays: string;
  willingToRelocate: "" | "yes" | "no";
  workModes: ("remote" | "hybrid" | "onsite")[];
  targetRoles: string;
  targetIndustries: string;
  yearsOfExperience: string;
  companiesToAvoid: string;
  jobLevel: "" | "entry" | "mid" | "senior" | "staff" | "lead" | "manager" | "director" | "executive";
  employmentTypes: ("full_time" | "part_time" | "contract" | "temporary" | "internship")[];
  desiredLocations: string;
  desiredBaseMin: string;
  desiredBaseMax: string;
  isNegotiable: boolean;
  customAnswers?: { questionText: string; answer: string }[];
  positioningWhatIDo: string;
  positioningWhoIServe: string;
  positioningWhatResult: string;
  isAtLeast18: "" | "yes" | "no";
  canPerformEssentialFunctions: "" | "yes" | "no";
  requiresAccommodationForProcess: "" | "yes" | "no";
  gender: string;
  raceEthnicity: string;
  veteranStatus: string;
  disability: string;
  references: ReferenceForm[];
  eligibilityNote: string;
  criminalHistoryDisclosure: string;
}

export interface ReferenceForm {
  name: string;
  relationship: string;
  company: string;
  email: string;
  phone: string;
}

/** One parsed résumé fact, as surfaced by /api/ledger (mirrors api.ts ledgerPayload). */
export interface LedgerFact {
  id: string;
  type: string;
  approved: boolean;
  display: string;
  sourceText: string;
  details?: Record<string, unknown>;
}

export interface LedgerData {
  approvedAt: string | null;
  summary: { total: number; approved: number; byType: Record<string, { total: number; approved: number }> };
  facts: LedgerFact[];
  suggestedRoles?: string[];
}

export interface ResumeFieldIssue {
  field: string;
  label: string;
  message: string;
}

export interface ResumeMappingResult {
  mappedData: ProfileForm;
  missingFields: ResumeFieldIssue[];
  uncertainFields: ResumeFieldIssue[];
  validationErrors: ResumeFieldIssue[];
}

export interface ResumeImportPreview extends LedgerData {
  ok: boolean;
  previewId: string;
  filename: string;
  format: "pdf" | "docx" | "text";
  method: "llm" | "heuristic";
  warnings: string[];
  profileFieldsFilled: number;
  form: ProfileForm;
  mapping: ResumeMappingResult;
  parsedResume?: unknown;
}

export interface ProfileSnapshot {
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
}

/** One discovered job row from GET /api/discovered-jobs. */
export type MatchCategory = "strong" | "good" | "stretch" | "weak" | "reject";

/** Display-facing subset of the engine's JobFitScore (src/types/job-fit.ts). */
export interface DiscoveredJobFit {
  overallScore: number;
  matchCategory: MatchCategory;
  interviewProbability: "high" | "medium" | "low";
  reasoningSummary: string;
  topMatchReasons: string[];
  mainConcerns: string[];
  missingRequirements: string[];
  recommendedAction: "apply" | "apply_with_custom_resume" | "save_for_later" | "skip";
  resumeKeywordsToEmphasize: string[];
  coverLetterAngle: string;
  hardBlockers: string[];
  confidence: "high" | "medium" | "low";
  method: "deterministic" | "llm";
  /** Structured requirements/recommended-quals breakdown (mirrors engine JobFitScore.requirementListing). */
  requirementListing?: {
    requirementsMet: string[];
    requirementsMissing: string[];
    preferredMet: string[];
    preferredMissing: string[];
    transferable: string[];
    dealbreakers: string[];
  };
}

export interface DiscoveredJobRow {
  id: string;
  company: string;
  title: string;
  location?: string;
  jobUrl: string;
  atsType: string;
  score: number;
  fitPct: number;
  rationale: string;
  knockouts: string[];
  salaryMin?: number;
  salaryMax?: number;
  description?: string;
  fitFactors?: {
    skills: number;
    salary: number;
    location: number;
    seniority: number;
    culture: number;
  };
  /** Rich, structured job-fit assessment from the engine (mirrors src/types/job-fit.ts JobFitScore). */
  fit?: DiscoveredJobFit;
  tags: string[];
  /** The user's assigned strategy tier (A/B/C), if any. */
  tier?: "A" | "B" | "C";
  /** Score-derived hint shown until the user assigns their own tier. */
  suggestedTier?: "A" | "B" | "C";
  /** Backend promotion decision: true only when the role is safe for one-click/apply surfaces. */
  actionable?: boolean;
  /** The discovery→apply contract: what ApplyPilot can actually do with this job's URL. */
  applyCapability?: ApplyCapability;
  /** Plain-language explanation of the capability, shown on the card. */
  applyCapabilityReason?: string;
  /** Convenience mirror of applyCapability === "supported_form_fill". */
  formFillSupported?: boolean;
  status: string;
  discoveredAt: string;
  applied: boolean;
}

/**
 * Per-job apply capability (mirrors src/discovery/apply-capability.ts):
 *  - supported_form_fill: a real apply adapter exists (Greenhouse/Lever/Ashby) — prefill allowed.
 *  - manual_open_only: worth reviewing, but you open the page and apply by hand.
 *  - unsupported: not an individual application page (board/search page, dead link) — no action.
 */
export type ApplyCapability = "supported_form_fill" | "manual_open_only" | "unsupported";

const APPLY_READY_CATEGORIES = new Set(["strong", "good"]);
const APPLY_READY_ACTIONS = new Set(["apply", "apply_with_custom_resume"]);
const APPLY_READY_LEGACY_SCORE = 0.75;

export function isApplyReadyDiscoveredJob(job: DiscoveredJobRow, minFitPct: number): boolean {
  const minScore = minFitPct / 100;
  if (job.actionable === false) return false;
  if (job.applied || job.status === "skipped" || job.knockouts.length > 0 || job.score < minScore) return false;
  if (job.fit) {
    if (job.fit.hardBlockers.length > 0) return false;
    return APPLY_READY_CATEGORIES.has(job.fit.matchCategory) && APPLY_READY_ACTIONS.has(job.fit.recommendedAction);
  }
  return job.score >= Math.max(minScore, APPLY_READY_LEGACY_SCORE);
}

export interface TargetCompany {
  id: string;
  name: string;
  boardUrl: string;
  atsType: string;
  enabled: boolean;
  autoSubmitApproved: boolean;
  createdAt: string;
  found: number;
}

/** Result of POST /api/generate (mirrors src/server/generate-runner.ts GenerateResult). */
export interface GenerateDocSummary {
  eligible: boolean;
  claims: number;
  unsupported: { text: string; reason: string }[];
  skipped?: boolean;
  skipReason?: string;
}
export interface AtsGapReport {
  requiredTerms: string[];
  coveredTerms: string[];
  missingTerms: string[];
  coveragePercent: number;
}
export interface BulletWarning {
  bullet: string;
  issue: "weak_opener" | "no_quantifier";
  suggestion: string;
}
export interface GenerateResult {
  generator: string;
  allEligible: boolean;
  company: string;
  title: string;
  resume: GenerateDocSummary;
  coverLetter: GenerateDocSummary;
  files: string[];
  downloads?: ApiDownload[];
  atsGap?: AtsGapReport;
  bulletWarnings?: BulletWarning[];
  draft?: ApplicationDraft;
}

/** Redacted form-fill snapshot (mirrors src/server/fill-snapshot.ts RedactedFillSnapshot). Sensitive
 *  self-ID / work-auth values are redacted server-side before storage, surfaced here as redacted: true. */
export interface RedactedFillSnapshot {
  url: string;
  ats: string;
  company: string | null;
  title: string | null;
  capturedAt: string;
  submitted: boolean;
  filled: { label: string; value: string | string[] | null; redacted: boolean }[];
  flagged: { label: string; value: string | string[] | null; redacted: boolean; rationale: string }[];
  needsConfirmation: { ref: string; label: string; controlType: string; required: boolean; risk: string; rationale: string }[];
  documents: { kind: string; attached: boolean }[];
  ledger: { checked: boolean; passed: boolean } | null;
  redactedCount: number;
}

/** One row of the Applications tab, from GET /api/applications (mirrors handleApplications). */
export interface ApplicationDetail {
  dedupKey: string;
  company: string | null;
  title: string | null;
  url: string | null;
  ats: string | null;
  status: string;
  submitted: boolean;
  createdAt: string;
  source: "applied" | "draft";
  draft: {
    id: string;
    tailoredResumeSummary: string;
    coverLetter: string;
    applicationAnswers: { question: string; answer: string }[];
    status: string;
    updatedAt: string;
  } | null;
  fill: RedactedFillSnapshot | null;
}

export type ApplicationDraftStatus = "saved" | "applied" | "interviewing" | "rejected" | "offer";
export interface ApplicationDraft {
  id: string;
  profileId: string;
  dedupKey: string;
  jobId?: string;
  company?: string;
  title?: string;
  applyUrl?: string;
  tailoredResumeSummary: string;
  coverLetter: string;
  applicationAnswers: { question: string; answer: string }[];
  status: ApplicationDraftStatus;
  createdAt: string;
  updatedAt: string;
}

/** The in-app apply review gate (mirrors serializeGate in src/server/api.ts). */
export interface ApplyGateField {
  ref: string;
  label: string;
  controlType: string;
  required: boolean;
  options: string[];
  risk: string;
  rationale: string;
}
export interface ApplyGate {
  url: string;
  ats: string;
  company?: string;
  title?: string;
  challengeDetected: boolean;
  accountAction?: { kind: string; domain: string };
  filled: { label: string; value: string | string[] | null }[];
  flagged: { label: string; value: string | string[] | null; rationale: string }[];
  needsConfirmation: ApplyGateField[];
  documents: { kind: string; attached: boolean }[];
  ledger?: { checked: boolean; passed: boolean };
  submitControlFound: boolean;
  readyForOneClickSubmit: boolean;
}

/** Result of GET /api/insights (mirrors src/insights/skill-gap.ts SkillGapReport). */
export interface SkillGapTerm {
  term: string;
  jobCount: number;
}
export interface SkillGapReport {
  jobsAnalyzed: number;
  topGaps: SkillGapTerm[];
  topMatched: SkillGapTerm[];
}

export const EMPTY_FORM: ProfileForm = {
  legalFirstName: "", legalLastName: "", preferredName: "", email: "", phone: "",
  addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "",
  linkedin: "", github: "", portfolio: "",
  authorizedToWorkInUS: "", requiresSponsorship: "", currentWorkStatus: "",
  earliestStartDate: "", noticePeriodDays: "", willingToRelocate: "", workModes: [],
  targetRoles: "", targetIndustries: "", yearsOfExperience: "", companiesToAvoid: "", jobLevel: "", employmentTypes: [],
  desiredLocations: "", desiredBaseMin: "", desiredBaseMax: "", isNegotiable: true,
  customAnswers: [],
  positioningWhatIDo: "", positioningWhoIServe: "", positioningWhatResult: "",
  isAtLeast18: "", canPerformEssentialFunctions: "", requiresAccommodationForProcess: "",
  gender: "", raceEthnicity: "", veteranStatus: "", disability: "",
  references: [], eligibilityNote: "", criminalHistoryDisclosure: "",
};
