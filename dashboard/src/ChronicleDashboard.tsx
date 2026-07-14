import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./components/Icon";
import { Logo } from "./components/Logo";
import { fetchAssistedSearch, isApplyReadyDiscoveredJob, useApplicationDrafts, useApplications, useDiscoveredJobs, useRuns, type ApplicationDetail, type ApplicationDraft, type ApplicationDraftStatus, type ApplyCapability, type ApplyGate, type AutomationRun, type BlockedApplication, type DashboardState, type DiscoveredJobRow, type LedgerData, type LedgerFact, type ProfileForm, type ReferenceForm } from "./data";
import { apiFetch, apiJson, apiPostJson } from "./api";
import { closeReviewPanel, hasEmbeddedReviewPanel, openReviewPanelAt, syncReviewPanelBounds, wipeReviewPanelLogins, type ReviewPanelBounds } from "./shell";
import { humanizeAction, humanizeDetails, toneForDot } from "./lib/humanize";
import { LiveActivity, StatCard, Drawer, EmptyState, DataTable, StatusPill, statusMeta, formatDuration, relativeTime, Skeleton, type Column } from "./components/ui";
import { liveActivityFromState } from "./lib/live-activity";
import { formFromProfileSnapshot } from "./lib/profile-form";
import { resumeSections } from "./lib/resume-facts";
import { fmtApplyValue, needsBrowserStep, reviewReadyNote } from "./lib/review-gate";

export type ChronicleTab = "matches" | "automation" | "oneclick" | "applied" | "blocked" | "profile" | "rules";

export interface ChronicleUi {
  showToast: (message: string) => void;
  applyJob: (item: { jobUrl: string; company: string; role: string }) => void | Promise<void>;
  stopAll: () => void;
  runDiscovery: () => Promise<void>;
  runAutomation: () => Promise<void>;
  taskActive: boolean;
  discovering: boolean;
  applying: boolean;
  stopping: boolean;
}

type JobMode = "auto" | "oneclick";
type JobStatus = "queued" | "submitted" | "interview" | "rejected" | "skipped";
type ApplicationFilter = "all" | ApplicationDraftStatus;

interface ChronicleJob {
  id: string;
  company: string;
  role: string;
  mode: JobMode;
  score: number;
  salary: string;
  salaryMin?: number;
  location: string;
  ats: string;
  status: JobStatus;
  time: string;
  blockReason: string;
  description: string;
  tags: string[];
  jobUrl: string;
  /** The discovery→apply contract: prefill (supported), open-manually, or unsupported. */
  applyCapability: ApplyCapability;
  /** Plain-language explanation of the capability, shown on the card. */
  capabilityReason: string;
  /** True when the job clears the user's fit bar — drives the Recommended badge + batch defaults,
   *  never visibility. */
  applyReady?: boolean;
  /** User-assigned strategy tier (A/B/C), if any. */
  tier?: "A" | "B" | "C";
  /** Score-derived hint shown until the user assigns their own tier. */
  suggestedTier?: "A" | "B" | "C";
  factors: {
    skills: number;
    salary: number;
    location: number;
    seniority: number;
    culture: number;
  };
  /** Rich structured fit from the engine, when the posting had a description to analyze. */
  fit?: DiscoveredJobRow["fit"];
}

const AVATAR_COLORS = ["#24bdb3", "#ff6f61", "#5aa7ff", "#ffd166", "#c99255", "#5edc85", "#137c75", "#d28a54"];
const DOT_COLORS: Record<string, string> = { teal: "#24bdb3", coral: "#ff6f61", yellow: "#ffd166", blue: "#5aa7ff" };
const FACTOR_COLORS = ["#ff6f61", "#24bdb3", "#ffd166", "#5aa7ff", "#c99255"];
const EMPTY_RESUME_LEDGER: LedgerData = {
  approvedAt: null,
  summary: { total: 0, approved: 0, byType: {} },
  facts: [],
};

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function readableKey(value: string): string {
  return titleCase(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "A") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function avatarStyle(seed: string) {
  let n = 0;
  for (const c of seed) n += c.charCodeAt(0);
  const color = AVATAR_COLORS[n % AVATAR_COLORS.length]!;
  return {
    background: `radial-gradient(circle at 30% 25%, rgba(255,255,255,.55), rgba(255,255,255,0) 55%), ${color}`,
  };
}

function formatSalary(min?: number, max?: number, floorK = 0): string {
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  if (min && max && min !== max) return `${k(min)}-${k(max)}`;
  if (min || max) return k(min ?? max!);
  return floorK ? `$${floorK}k+ target` : "Salary not listed";
}

function formatTime(iso?: string): string {
  if (!iso) return "just now";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function scheduleTime(hour: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:00 ${suffix}`;
}

/** Format the engine's computed next-run (ISO) for display (commercial M9-C). The engine owns the
 *  clock now, so this only presents its answer — no client-side guessing at when the pass will run. */
function formatEngineNextRun(iso: string | null, enabled: boolean): string {
  if (!enabled) return "Schedule disabled";
  if (!iso) return "Not scheduled";
  const next = new Date(iso);
  if (Number.isNaN(next.getTime())) return "Not scheduled";
  const now = new Date();
  // A past next-run means the client copy is stale (the engine just fired and is re-arming) — never
  // present a past time as upcoming; the periodic re-poll replaces this with tomorrow's run shortly.
  if (next.getTime() <= now.getTime()) return "Soon";
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const day =
    next.toDateString() === now.toDateString() ? "Today"
    : next.toDateString() === tomorrow.toDateString() ? "Tomorrow"
    : next.toLocaleDateString(undefined, { weekday: "short" });
  const time = next.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

function fallbackFactors(score: number): ChronicleJob["factors"] {
  const base = clampPct(score);
  return {
    skills: clampPct(base + 3),
    salary: clampPct(base - 4),
    location: clampPct(base + 7),
    seniority: clampPct(base - 2),
    culture: clampPct(base - 6),
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

function tagsFrom(job: DiscoveredJobRow): string[] {
  if (job.tags?.length) return job.tags.slice(0, 5);
  const tags: string[] = [];
  if (/product|pm/i.test(job.title)) tags.push("Product");
  if (/ai|ml|automation/i.test(`${job.title} ${job.rationale}`)) tags.push("AI");
  if (/remote/i.test(job.location ?? "")) tags.push("Remote");
  if (job.atsType) tags.push(titleCase(job.atsType));
  return tags.slice(0, 5);
}

function jobFromDiscovered(job: DiscoveredJobRow, floorK: number): ChronicleJob {
  const score = clampPct(job.fitPct);
  return {
    id: `disc:${job.id}`,
    company: job.company,
    role: job.title,
    mode: "oneclick",
    score,
    salary: formatSalary(job.salaryMin, job.salaryMax, floorK),
    ...(job.salaryMin ? { salaryMin: job.salaryMin } : {}),
    location: job.location || "Location not listed",
    ats: titleCase(job.atsType || "ATS"),
    status: "queued",
    time: formatTime(job.discoveredAt),
    blockReason: job.rationale || "Ready for review in the employer form.",
    description: job.description || "ApplyPilot scored this role against your approved profile and résumé facts. Open the posting for the full employer description.",
    tags: tagsFrom(job),
    jobUrl: job.jobUrl,
    // Older engine payloads (before the capability contract) omit these; treat those rows as
    // manual-only rather than pretending they're fillable.
    applyCapability: job.applyCapability ?? (job.jobUrl ? "manual_open_only" : "unsupported"),
    capabilityReason: job.applyCapabilityReason ?? "",
    ...(job.tier ? { tier: job.tier } : {}),
    ...(job.suggestedTier ? { suggestedTier: job.suggestedTier } : {}),
    factors: job.fitFactors ?? fallbackFactors(score),
    ...(job.fit ? { fit: job.fit } : {}),
  };
}

/**
 * The honest per-job action under the discovery→apply contract: prefill only when a real form-fill
 * adapter exists; open-manually for everything reviewable; no action for dead/board links. Labels
 * are deliberately different so a manual job never masquerades as an automated one.
 */
function applyAction(job: ChronicleJob): { kind: "prefill" | "manual" | "none"; label: string; busyLabel: string } {
  if (job.applyCapability === "supported_form_fill") return { kind: "prefill", label: "Prefill application", busyLabel: "Prefilling…" };
  if (job.applyCapability === "manual_open_only") return { kind: "manual", label: "Open manually", busyLabel: "Opening…" };
  return { kind: "none", label: "Not an application page", busyLabel: "—" };
}

const CATEGORY_LABEL: Record<NonNullable<ChronicleJob["fit"]>["matchCategory"], string> = {
  strong: "Strong match", good: "Good match", stretch: "Stretch", weak: "Weak", reject: "Avoid",
};
const ACTION_LABEL: Record<NonNullable<ChronicleJob["fit"]>["recommendedAction"], string> = {
  apply: "Apply", apply_with_custom_resume: "Apply with a tailored résumé",
  save_for_later: "Save for later", skip: "Skip",
};

/** One labeled list inside the fit panel (skipped when empty). */
function FitRow({ label, items, warn, limit = 5 }: { label: string; items: string[]; warn?: boolean; limit?: number }) {
  if (!items.length) return null;
  return (
    <div className={warn ? "fit-row fit-warn" : "fit-row"}>
      <span>{label}</span>
      <ul>{items.slice(0, limit).map((r, i) => <li key={i}>{r}</li>)}</ul>
    </div>
  );
}

/** Compact, honest fit panel: category, interview odds, and the requirements/recommended-quals breakdown. */
function FitPanel({ fit }: { fit?: ChronicleJob["fit"] }) {
  if (!fit) return <p className="empty-copy">Run a job search to generate a structured fit assessment.</p>;
  const L = fit.requirementListing;
  return (
    <div className={`fit-panel fit-${fit.matchCategory}`}>
      <div className="fit-head">
        <span className={`fit-badge fit-badge-${fit.matchCategory}`}>{CATEGORY_LABEL[fit.matchCategory]}</span>
        <span className="fit-prob">Interview odds: <b>{fit.interviewProbability}</b></span>
        {fit.method === "llm" ? <span className="fit-ai">AI-reviewed</span> : null}
      </div>
      <p className="fit-summary">{fit.reasoningSummary}</p>
      {L ? (
        <>
          {/* Requirements are shown as negotiable: met vs. gaps you could still make a case for. */}
          <FitRow label="Requirements you meet" items={L.requirementsMet} />
          <FitRow label="Gaps — often negotiable" items={L.requirementsMissing} warn />
          <FitRow label="Recommended quals you have" items={L.preferredMet} />
          <FitRow label="Transferable strengths" items={L.transferable} />
          <FitRow label="Also asked for" items={L.preferredMissing} warn limit={4} />
          <FitRow label="Dealbreakers" items={L.dealbreakers} warn />
          {fit.mainConcerns.length ? <FitRow label="Notes" items={fit.mainConcerns} warn /> : null}
        </>
      ) : (
        <>
          {/* Older rows without the structured listing fall back to the prose fields. */}
          <FitRow label="Why it fits" items={fit.topMatchReasons} limit={3} />
          <FitRow label="Concerns" items={fit.mainConcerns} warn limit={3} />
          <FitRow label="Missing" items={fit.missingRequirements} warn limit={3} />
        </>
      )}
      <div className="fit-foot">
        <strong>{ACTION_LABEL[fit.recommendedAction]}</strong>
        {fit.coverLetterAngle ? <em>{fit.coverLetterAngle}</em> : null}
      </div>
    </div>
  );
}

function jobFromQueue(item: DashboardState["oneClick"][number], index: number, state: DashboardState): ChronicleJob {
  const match = state.automatedQueue.find((q) => q.company === item.company && q.role === item.role);
  const score = match?.fit ?? Math.max(72, 92 - index * 2);
  return {
    id: `queue:${item.id}`,
    company: item.company,
    role: item.role,
    mode: "oneclick",
    score,
    salary: formatSalary(undefined, undefined, state.rules.minSalaryK),
    location: state.hero.queries.find((q) => /remote|ny|new york|location/i.test(q)) ?? "US role",
    ats: "Employer ATS",
    status: "queued",
    time: "ready",
    blockReason: item.reason,
    description: "This role is scored and ready. ApplyPilot can prepare the employer form, then pause for your review.",
    tags: ["Ready", "Company site"],
    jobUrl: item.jobUrl,
    applyCapability: (item.applyCapability as ApplyCapability | undefined) ?? (item.jobUrl ? "manual_open_only" : "unsupported"),
    capabilityReason: item.applyCapabilityReason ?? "",
    factors: fallbackFactors(score),
  };
}

function jobFromApplied(row: DashboardState["applied"]["rows"][number], index: number, state: DashboardState): ChronicleJob {
  const status: JobStatus = row.status === "interview" ? "interview" : row.tag.toLowerCase().includes("reject") ? "rejected" : "submitted";
  const score = Math.max(70, 91 - index * 3);
  return {
    id: `applied:${row.company}:${row.role}`,
    company: row.company,
    role: row.role,
    mode: row.tag.toLowerCase().includes("needs") ? "oneclick" : "auto",
    score,
    salary: formatSalary(undefined, undefined, state.rules.minSalaryK),
    location: state.hero.queries.find((q) => /remote|ny|new york|location/i.test(q)) ?? "US role",
    ats: "Employer ATS",
    status,
    time: row.note,
    blockReason: row.tag,
    description: "Application record from the local pipeline. Details are stored in the local applications ledger.",
    tags: [row.tag, "Local log"],
    jobUrl: "",
    applyCapability: "unsupported",
    capabilityReason: "Already in your applications log.",
    factors: fallbackFactors(score),
  };
}

function distributeWeek(total: number, qualified: number): number[] {
  if (total <= 0 && qualified <= 0) return [0, 0, 0, 0, 0, 0, 0];
  const seed = Math.max(total, qualified);
  const pattern = [0.1, 0.16, 0.13, 0.2, 0.24, 0.1, 0.07];
  return pattern.map((p) => Math.max(0, Math.round(seed * p)));
}

function buildPath(data: number[], width = 480, height = 90) {
  const padX = 12;
  const padY = 8;
  const max = Math.max(1, ...data);
  const points = data.map((value, index) => ({
    x: padX + (index / Math.max(1, data.length - 1)) * (width - padX * 2),
    y: height - padY - (value / max) * (height - padY * 2),
  }));
  const line = points.map((p, index) => `${index === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `M ${points[0]!.x.toFixed(1)} ${height} ${points.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")} L ${points[points.length - 1]!.x.toFixed(1)} ${height} Z`;
  return { points, line, area, width, height };
}

function splitReason(reason: string): { title: string; summary: string } {
  const [title, ...rest] = reason.split(/\s+\|\s+/);
  return {
    title: title || "Pipeline event",
    // Only a real second segment becomes the summary — never echo the whole title back, which
    // rendered the same sentence twice in the activity log.
    summary: rest.join(" · "),
  };
}

function apiErrorText(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const data = body as { error?: unknown; errorId?: unknown };
  const message = data.error ? String(data.error) : fallback;
  return data.errorId ? `${message} (report ${String(data.errorId)})` : message;
}

function automationLogEntries(state: DashboardState): DashboardState["log"] {
  return state.log.length
    ? state.log
    : [{ time: "now", dot: "teal", text: "No activity yet. Run discovery to start the local audit log.", action: "waiting", details: ["The pilot has not recorded an automated action in this profile yet."] }];
}

function dotForAutomationAction(action: string): "teal" | "coral" | "yellow" | "blue" {
  if (action.startsWith("application")) return action.includes("challenge") ? "coral" : "teal";
  if (action.startsWith("discovery")) return "blue";
  if (action.startsWith("documents")) return "yellow";
  return "teal";
}

function detailLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => detailLines(item));
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "boolean") return [value ? "Yes" : "No"];
  if (typeof value === "number") return [String(value)];
  if (typeof value === "string") return [value];
  if (typeof value === "object") return [JSON.stringify(value)];
  return [String(value)];
}

function factDetailEntries(fact: LedgerFact): { label: string; lines: string[] }[] {
  const details = fact.details ?? {};
  return Object.entries(details)
    .map(([key, value]) => ({ label: readableKey(key), lines: detailLines(value) }))
    .filter((entry) => entry.lines.length > 0);
}

function factStatement(fact: LedgerFact): string {
  const details = fact.details ?? {};
  const statement = details.statement;
  if (typeof statement === "string" && statement.trim()) return statement.trim();
  return fact.display.replace(/^\[[^\]]+\]\s*/, "");
}

function factField(fact: LedgerFact, key: string): string {
  const value = fact.details?.[key];
  return typeof value === "string" ? value : "";
}

function cleanSkillLabel(raw: string): string {
  let label = raw
    .replace(/^[•\-\s]+/, "")
    .replace(/\s+/g, " ")
    .replace(/[,\s-]+$/, "")
    .trim();
  const lower = label.toLowerCase();
  const mapped: Record<string, string> = {
    "aml / cft & sanctions — kyc lifecycle": "AML / CFT, sanctions, KYC",
    "pep & adverse": "PEP & adverse media screening",
    "enhanced due diligence — complex investigations": "Enhanced due diligence investigations",
    "transaction monitoring & sar escalation rating methodologies": "Transaction monitoring & SAR escalation",
    "open-source intelligence (osint) — multilingual": "Open-source intelligence (OSINT)",
    "regulatory frameworks — fatf": "FATF regulatory framework",
    "risk & fraud analytics — quantitative modeling": "Risk & fraud analytics",
    "data & technology — data analysis (excel": "Data analysis in Excel",
    "power bi)": "Power BI",
    "languages: turkish (native)": "Turkish (native)",
    "english (native)": "English (native)",
  };
  label = mapped[lower] ?? label.replace(/\s+—\s+/g, ": ").replace(/\)$/, "");
  return label.trim();
}

function keepSkillLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  if (!label) return false;
  if (["risk", "power", "query", "directives", "r&c"].includes(normalized)) return false;
  return label.length > 2;
}

function skillCategory(label: string): string {
  const text = label.toLowerCase();
  if (/fatf|fincen|eu aml|fca|wolfsberg|regulatory/.test(text)) return "Regulatory frameworks";
  if (/aml|sanction|kyc|diligence|pep|transaction|sar|risk|fraud|case escalation/.test(text)) return "Compliance & investigations";
  if (/osint|research|network|geopolitical|screening/.test(text)) return "Research & intelligence";
  if (/excel|power bi|world-check|rdc|dow jones|data|analytics|trend/.test(text)) return "Data & tools";
  if (/turkish|english|native|language/.test(text)) return "Languages";
  return "Other";
}

function useCurrentClock(): string {
  const [currentTime, setCurrentTime] = useState(() => formatTime(new Date().toISOString()));
  useEffect(() => {
    const id = window.setInterval(() => setCurrentTime(formatTime(new Date().toISOString())), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return currentTime;
}

export function ChronicleDashboard({
  state,
  activeTab,
  onNavigate,
  ui,
  minFit,
  onMinFit,
  jobsRefresh,
  usingSample,
  onReload,
  hideChrome = false,
  scheduleEnabled,
  scheduleHour,
  onToggleSchedule,
  onShiftScheduleHour,
  scheduleNextRunAt,
  onPendingCount,
}: {
  state: DashboardState;
  activeTab: ChronicleTab;
  onNavigate: (tab: ChronicleTab) => void;
  ui: ChronicleUi;
  minFit: number;
  onMinFit: (value: number) => void;
  jobsRefresh: number;
  usingSample: boolean;
  onReload: () => void;
  /** When the new AppShell renders the sidebar/topbar, suppress Chronicle's own nav + footer. */
  hideChrome?: boolean;
  /** Daily-run schedule is owned by App (shared with the shell topbar); Chronicle reads + drives it.
   *  The engine persists it and fires the pass (commercial M9-C); `scheduleNextRunAt` is the engine's
   *  computed next-run (ISO), or null when disabled/engine-down. */
  scheduleEnabled: boolean;
  scheduleHour: number;
  onToggleSchedule: () => void;
  onShiftScheduleHour: (delta: number) => void;
  scheduleNextRunAt: string | null;
  /** Reports the strict apply-ready queue size up to App so the sidebar badge matches the queue. */
  onPendingCount?: (count: number) => void;
}) {
  // null = the server's curated default view (loose display floor + best-matches backfill). The
  // user's min-fit only decides which rows get RECOMMENDED (badge, batch defaults), not visibility —
  // hiding low-scored jobs entirely is how the queue used to read "clear" while 100+ jobs sat in the DB.
  // Employer-ATS-only: hide aggregator (LinkedIn/Indeed) leads, showing only company-site postings.
  const [employerOnly, setEmployerOnly] = useState(false);
  const { jobs, error: jobsError, reload: reloadJobs } = useDiscoveredJobs(null, jobsRefresh, employerOnly);
  const {
    drafts,
    loading: draftsLoading,
    error: draftsError,
    setStatus: setDraftStatus,
  } = useApplicationDrafts(jobsRefresh, !usingSample);
  const currentTime = useCurrentClock();
  const [selectedJob, setSelectedJob] = useState<ChronicleJob | null>(null);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [metricDrawer, setMetricDrawer] = useState<{ title: string; eyebrow: string; jobs: ChronicleJob[]; empty: string } | null>(null);
  const [appliedJobIds, setAppliedJobIds] = useState<string[]>([]);
  const [discardedJobIds, setDiscardedJobIds] = useState<string[]>([]);
  // Optimistic tier assignments keyed by the bare discovered-job id (persisted via set-tier).
  const [tierOverrides, setTierOverrides] = useState<Record<string, "A" | "B" | "C" | null>>({});
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null);
  const [applySession, setApplySession] = useState<{ job: ChronicleJob; sessionId: string; gate: ApplyGate; display: "embedded" | "window" } | null>(null);
  const applyLockRef = useRef(false);
  const applySessionRef = useRef<typeof applySession>(null);
  const appliedJobIdsRef = useRef<string[]>([]);
  const [applySubmitting, setApplySubmitting] = useState(false);
  const [applyRefreshing, setApplyRefreshing] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [appliedFilter, setAppliedFilter] = useState<ApplicationFilter>("all");
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);

  useEffect(() => {
    applySessionRef.current = applySession;
  }, [applySession]);
  useEffect(() => {
    appliedJobIdsRef.current = appliedJobIds;
  }, [appliedJobIds]);

  // Assisted search (§8.6): build the pre-filled LinkedIn/Indeed search URLs from the user's intent and
  // open them in their OWN browser. The app never fetches those hosts — this only hands over a link.
  const openAssistedSearch = useCallback(async () => {
    try {
      const s = await fetchAssistedSearch();
      for (const url of [s.linkedin, s.indeed]) {
        if (url) window.open(url, "_blank", "noopener");
      }
    } catch {
      /* best-effort: the button only opens the user's own browser search */
    }
  }, []);

  const discoveredQueue = useMemo(
    () =>
      jobs
        .slice()
        // Recommended matches (clear the user's fit bar) lead; everything else follows by score.
        // Low-scored and manual-only jobs stay VISIBLE with honest labels — they're just not recommended.
        .sort(
          (a, b) =>
            Number(isApplyReadyDiscoveredJob(b, minFit)) - Number(isApplyReadyDiscoveredJob(a, minFit)) ||
            b.score - a.score
        )
        .map((j) => {
          const card = jobFromDiscovered(j, state.rules.minSalaryK);
          card.applyReady = isApplyReadyDiscoveredJob(j, minFit);
          // Apply any optimistic local tier override (cleared back to the server value on reload).
          const override = tierOverrides[j.id];
          if (override === null) delete card.tier;
          else if (override) card.tier = override;
          return card;
        }),
    [jobs, minFit, state.rules.minSalaryK, tierOverrides]
  );
  const queueJobs = discoveredQueue;
  const appliedJobs = useMemo(
    () => state.applied.rows.map((row, index) => jobFromApplied(row, index, state)),
    [state]
  );
  const pendingJobs = queueJobs.filter((job) => !appliedJobIds.includes(job.id) && !discardedJobIds.includes(job.id));
  const topJob = pendingJobs[0] ?? appliedJobs[0] ?? queueJobs[0] ?? null;
  const weeklyData = distributeWeek(state.progress.sent || state.applied.summary.sent, state.hero.metrics.qualified);
  const weeklyPath = buildPath(weeklyData);
  const rules = [
    { label: `Good/strong fit and score >= ${minFit}%`, color: "#ff6f61" },
    { label: state.rules.minSalaryK ? `Salary $${state.rules.minSalaryK}k+ target` : "Salary captured when posted", color: "#24bdb3" },
    { label: "Company career pages only", color: "#ffd166" },
    { label: state.rules.excludeRelocation ? "No relocation required" : "Relocation allowed", color: "#5aa7ff" },
    { label: "User review before submit", color: "#c99255" },
    { label: `${state.rules.followUpDays} day follow-up window`, color: "#5edc85" },
  ];
  const scheduleLabel = scheduleEnabled ? `Daily ${scheduleTime(scheduleHour)}` : "No schedule";

  useEffect(() => {
    // Default batch selection: only jobs that are BOTH recommended and prefill-supported. The rest
    // stay listed (and selectable one by one), but a batch never sweeps in weak or manual-only rows.
    if (!showBatchModal) setBatchSelectedIds(pendingJobs.filter((job) => job.applyReady && job.applyCapability === "supported_form_fill").map((job) => job.id));
  }, [showBatchModal, pendingJobs.map((job) => `${job.id}:${job.applyReady ? 1 : 0}`).join("|")]);

  // Keep the shell's sidebar badge in sync with the real, strictly-filtered review queue.
  useEffect(() => {
    onPendingCount?.(pendingJobs.length);
  }, [pendingJobs.length, onPendingCount]);

  // The daily run is fired by the ENGINE now (commercial M9-C), not a browser timer — so it survives
  // dashboard reloads and doesn't depend on this tab being mounted. No client setTimeout here on
  // purpose: a client timer would double-fire alongside the engine's.

  // In-app prefill (supported jobs only): open the REAL employer form where you can see it — inside
  // the app's embedded review panel (desktop app) or a visible browser window (plain browser) — fill
  // what we confidently can while you watch, then pause. You review the actual page, fix anything,
  // and click the employer's Submit button yourself; ApplyPilot never clicks submit.
  async function handleApply(job: ChronicleJob): Promise<boolean> {
    if (applyLockRef.current || appliedJobIdsRef.current.includes(job.id) || applySessionRef.current) return false;
    if (job.applyCapability !== "supported_form_fill") {
      ui.showToast(job.capabilityReason || "This job isn't supported for automated prefill — open it manually.");
      return false;
    }
    applyLockRef.current = true;
    setApplyingJobId(job.id);
    const embedded = hasEmbeddedReviewPanel();
    // The panel must exist before the engine starts (it fills INTO the panel). Open it at a
    // provisional rectangle now; the review workspace snaps it to its real spot once it mounts.
    if (embedded) await openReviewPanelAt(provisionalPanelBounds());
    ui.showToast(
      embedded
        ? `Preparing ${job.company}… watch the form fill in the panel.`
        : `Preparing ${job.company}… a browser window will open with the employer form.`
    );
    try {
      const r = await apiFetch("/api/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: job.jobUrl, company: job.company, title: job.role, display: embedded ? "embedded" : "window" }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiErrorText(d, `API ${r.status}`));
      const nextSession = {
        job,
        sessionId: d.sessionId as string,
        gate: d.gate as ApplyGate,
        display: (d.display === "embedded" ? "embedded" : "window") as "embedded" | "window",
      };
      applySessionRef.current = nextSession;
      setApplySession(nextSession);
      return true;
    } catch (e) {
      if (embedded) void closeReviewPanel();
      ui.showToast(`Couldn't prepare ${job.company}: ${String((e as Error).message ?? e)}`);
      return false;
    } finally {
      setApplyingJobId(null);
      applyLockRef.current = false;
    }
  }

  // Manual-only jobs: open the posting in the regular browser and prepare tailored documents the
  // user can attach by hand. No automation touches the page.
  async function openManually(job: ChronicleJob) {
    if (!job.jobUrl) {
      ui.showToast("This job has no usable application link.");
      return;
    }
    window.open(job.jobUrl, "_blank", "noopener");
    ui.showToast(`Opened ${job.company} in your browser — preparing tailored documents…`);
    try {
      const discoveredId = job.id.replace(/^(disc|queue):/, "");
      const r = await apiFetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: job.company, title: job.role, jobId: discoveredId, postingUrl: job.jobUrl }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiErrorText(d, `API ${r.status}`));
      ui.showToast(`Documents ready for ${job.company} — download them from the Applied tab.`);
    } catch (e) {
      ui.showToast(`Couldn't prepare documents: ${String((e as Error).message ?? e)}`);
    }
  }

  /** Route a job to its honest action: prefill (supported), open manually, or explain why neither. */
  function handleJobAction(job: ChronicleJob): void {
    const action = applyAction(job);
    if (action.kind === "prefill") void handleApply(job);
    else if (action.kind === "manual") void openManually(job);
    else ui.showToast(job.capabilityReason || "This link isn't an individual application page.");
  }

  async function answerApplyField(ref: string, value: string | string[]) {
    if (!applySession) return;
    try {
      const r = await apiFetch("/api/apply/field", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: applySession.sessionId, ref, value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiErrorText(d, `API ${r.status}`));
      setApplySession((s) => (s ? { ...s, gate: d.gate as ApplyGate } : s));
    } catch (e) {
      ui.showToast(`Couldn't save that answer: ${String((e as Error).message ?? e)}`);
    }
  }

  async function refreshApplication() {
    if (!applySession || applyRefreshing) return;
    setApplyRefreshing(true);
    try {
      const r = await apiFetch("/api/apply/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: applySession.sessionId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiErrorText(d, `API ${r.status}`));
      setApplySession((s) => (s ? { ...s, gate: d.gate as ApplyGate } : s));
      ui.showToast(d.gate?.challengeDetected || d.gate?.accountAction ? "Still waiting on the browser step." : "Browser step cleared — review the application.");
    } catch (e) {
      ui.showToast(`Couldn't re-check the browser: ${String((e as Error).message ?? e)}`);
    } finally {
      setApplyRefreshing(false);
    }
  }

  // The app never clicks the employer's submit button. The user submits on the real page, then
  // records it here so the pipeline stats stay truthful.
  async function markApplicationSubmitted() {
    if (!applySession || applySubmitting) return;
    setApplySubmitting(true);
    const job = applySession.job;
    try {
      const r = await apiFetch("/api/apply/mark-submitted", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // url/company/title let the server record the submit even if the session idled out while
        // you finished up on the employer page.
        body: JSON.stringify({ sessionId: applySession.sessionId, url: job.jobUrl, company: job.company, title: job.role }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiErrorText(d, `API ${r.status}`));
      setAppliedJobIds((ids) => (ids.includes(job.id) ? ids : [...ids, job.id]));
      ui.showToast(`Recorded your ${job.company} application.`);
      applySessionRef.current = null;
      setApplySession(null);
      void closeReviewPanel();
      onReload();
    } catch (e) {
      ui.showToast(`Couldn't record the submit: ${String((e as Error).message ?? e)}`);
    } finally {
      setApplySubmitting(false);
    }
  }

  async function cancelApplication() {
    const s = applySession;
    applySessionRef.current = null;
    setApplySession(null);
    setApplySubmitting(false);
    setApplyRefreshing(false);
    void closeReviewPanel();
    if (s) {
      await apiFetch("/api/apply/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: s.sessionId }),
      }).catch(() => {});
    }
  }

  async function handleDiscard(job: ChronicleJob) {
    if (discardedJobIds.includes(job.id)) return;
    setDiscardedJobIds((ids) => (ids.includes(job.id) ? ids : [...ids, job.id]));
    if (selectedJob?.id === job.id) setSelectedJob(null);
    const discoveredId = job.id.replace(/^(disc|queue):/, "");
    try {
      const response = await apiFetch("/api/discovered-jobs/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: discoveredId, action: "discard" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `API ${response.status}`);
      ui.showToast(`Discarded ${job.company} · ${job.role}`);
      onReload();
    } catch (error) {
      setDiscardedJobIds((ids) => ids.filter((id) => id !== job.id));
      ui.showToast(`Could not discard role: ${String((error as Error).message ?? error)}`);
    }
  }

  async function handleSetTier(job: ChronicleJob, tier: "A" | "B" | "C" | null) {
    const discoveredId = job.id.replace(/^(disc|queue):/, "");
    const previous = tierOverrides[discoveredId];
    setTierOverrides((m) => ({ ...m, [discoveredId]: tier }));
    if (selectedJob?.id === job.id) {
      setSelectedJob((curr) => {
        if (!curr) return curr;
        const next = { ...curr };
        if (tier) next.tier = tier;
        else delete next.tier;
        return next;
      });
    }
    try {
      const response = await apiFetch("/api/discovered-jobs/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: discoveredId, action: "set-tier", tier }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `API ${response.status}`);
      ui.showToast(tier ? `Set ${job.company} · ${job.role} to Tier ${tier}` : `Cleared tier on ${job.company} · ${job.role}`);
      onReload();
    } catch (error) {
      // Revert the optimistic override on failure.
      setTierOverrides((m) => ({ ...m, [discoveredId]: previous ?? null }));
      ui.showToast(`Could not set tier: ${String((error as Error).message ?? error)}`);
    }
  }

  async function handleDraftStatus(id: string, status: ApplicationDraftStatus) {
    setDraftBusyId(id);
    try {
      await setDraftStatus(id, status);
      ui.showToast(`Moved draft to ${draftStatusLabel(status)}.`);
      onReload();
    } catch (error) {
      ui.showToast(`Could not update draft: ${String((error as Error).message ?? error)}`);
    } finally {
      setDraftBusyId(null);
    }
  }

  function runAutomation() {
    if (ui.taskActive) return;
    void ui.runAutomation();
  }

  async function applyBatch() {
    // Only supported jobs can be prefilled; manual-only rows keep their own "Open manually" action.
    const selected = pendingJobs.filter((job) => batchSelectedIds.includes(job.id) && job.applyCapability === "supported_form_fill");
    setShowBatchModal(false);
    if (!selected.length) {
      ui.showToast("None of the selected jobs support automated prefill — use their Open manually buttons.");
      return;
    }
    for (const job of selected) {
      const started = await handleApply(job);
      if (started || applySessionRef.current) break;
    }
  }

  return (
    <div className={`chronicle${hideChrome ? " is-embedded" : ""}`} aria-label="Chronicle dashboard">
      {!hideChrome ? (
        <ChronicleNav
          state={state}
          activeTab={activeTab}
          onNavigate={onNavigate}
          pendingCount={pendingJobs.length}
          scheduleLabel={scheduleLabel}
          currentTime={currentTime}
          taskActive={ui.taskActive}
          stopping={ui.stopping}
          onRun={runAutomation}
          onStop={ui.stopAll}
        />
      ) : null}

      <RunningBanner ui={ui} runner={state.runner ?? null} pending={pendingJobs.length} progress={state.automationProgress} />

      {usingSample ? (
        <div className="chronicle-offline">
          <Icon name="shield" />
          <span>Showing a non-local snapshot. Start the local API to run discovery or prepare applications.</span>
        </div>
      ) : null}

      {jobsError && !usingSample ? (
        <div className="chronicle-offline">
          <Icon name="shield" />
          <span>Unable to load the live job queue.</span>
          <button className="button compact" type="button" onClick={reloadJobs}>Retry</button>
        </div>
      ) : null}

      {activeTab === "matches" && !usingSample ? (
        <div className="offplatform-controls">
          <label className="offplatform-toggle">
            <input
              type="checkbox"
              checked={employerOnly}
              onChange={(e) => setEmployerOnly(e.target.checked)}
            />
            <span>Employer sites only</span>
            <small>Hide LinkedIn/Indeed leads — show only postings on a company's own careers page.</small>
          </label>
          <button className="button compact" type="button" onClick={() => void openAssistedSearch()}>
            Search LinkedIn / Indeed in your browser →
          </button>
        </div>
      ) : null}

      {activeTab === "matches" ? (
        <AutomatedView
          state={state}
          pendingJobs={pendingJobs}
          appliedJobs={appliedJobs}
          topJob={topJob}
          weeklyData={weeklyData}
          weeklyPath={weeklyPath}
          rules={rules}
          onAutomation={() => onNavigate("automation")}
          onSelectJob={setSelectedJob}
          onSelectCompany={setSelectedCompany}
          onApply={handleJobAction}
          onDiscard={handleDiscard}
          onBatch={() => setShowBatchModal(true)}
          onReview={() => onNavigate("oneclick")}
          onDiscovery={() => void ui.runDiscovery()}
          onMetric={setMetricDrawer}
          onNeedsYou={() => onNavigate("blocked")}
          appliedJobIds={appliedJobIds}
          applyingJobId={applyingJobId}
        />
      ) : activeTab === "automation" ? (
        <AutomationTab
          state={state}
          pendingJobs={pendingJobs}
          appliedJobs={[...queueJobs.filter((job) => appliedJobIds.includes(job.id)), ...appliedJobs]}
          weeklyData={weeklyData}
          weeklyPath={weeklyPath}
          onSelectCompany={setSelectedCompany}
          onSelectJob={setSelectedJob}
          onRules={() => onNavigate("rules")}
          usingSample={usingSample}
        />
      ) : activeTab === "oneclick" ? (
        <OneClickTab
          state={state}
          pendingJobs={pendingJobs}
          appliedJobIds={appliedJobIds}
          applyingJobId={applyingJobId}
          onSelectJob={setSelectedJob}
          onApply={handleJobAction}
          onDiscard={handleDiscard}
          onBatch={() => setShowBatchModal(true)}
        />
      ) : activeTab === "applied" ? (
        <AppliedTab usingSample={usingSample} refreshNonce={jobsRefresh} onToast={ui.showToast} />
      ) : activeTab === "profile" ? (
        <ProfileTab
          state={state}
          usingSample={usingSample}
          onToast={ui.showToast}
          onReload={onReload}
        />
      ) : activeTab === "blocked" ? (
        <BlockedView blocked={state.blocked ?? []} />
      ) : (
        <RulesTab
          state={state}
          minFit={minFit}
          onMinFit={onMinFit}
          scheduleEnabled={scheduleEnabled}
          scheduleHour={scheduleHour}
          onToggleSchedule={onToggleSchedule}
          onHour={onShiftScheduleHour}
          nextRun={formatEngineNextRun(scheduleNextRunAt, scheduleEnabled)}
          onSave={() => ui.showToast("Rules saved locally")}
        />
      )}

      {!hideChrome ? <ChronicleFooter state={state} /> : null}
      <ApplyReviewWorkspace
        session={applySession}
        submitting={applySubmitting}
        refreshing={applyRefreshing}
        onAnswer={answerApplyField}
        onRefresh={refreshApplication}
        onMarkSubmitted={markApplicationSubmitted}
        onCancel={cancelApplication}
      />
      <DetailDrawer job={selectedJob} applied={Boolean(selectedJob && appliedJobIds.includes(selectedJob.id))} applying={Boolean(selectedJob && applyingJobId === selectedJob.id)} onClose={() => setSelectedJob(null)} onApply={handleJobAction} onSetTier={(job, tier) => void handleSetTier(job, tier)} />
      <BatchModal open={showBatchModal} jobs={pendingJobs} selectedIds={batchSelectedIds} onToggle={(id) => setBatchSelectedIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])} onClose={() => setShowBatchModal(false)} onApply={applyBatch} />
      <CompanyDrawer
        company={selectedCompany}
        jobs={selectedCompany ? [...pendingJobs, ...appliedJobs].filter((job) => job.company === selectedCompany) : []}
        applied={appliedJobIds}
        onClose={() => setSelectedCompany(null)}
        onSelectJob={(job) => { setSelectedCompany(null); setSelectedJob(job); }}
      />
      <Drawer
        open={Boolean(metricDrawer)}
        onClose={() => setMetricDrawer(null)}
        eyebrow={metricDrawer?.eyebrow ?? ""}
        title={metricDrawer?.title ?? ""}
        subtitle={metricDrawer ? `${metricDrawer.jobs.length} item${metricDrawer.jobs.length === 1 ? "" : "s"}` : ""}
      >
        {metricDrawer && metricDrawer.jobs.length > 0 ? (
          <div className="apx-mini-rows">
            {metricDrawer.jobs.map((job) => {
              const badge = appliedStatusBadge(job.blockReason, job.status);
              return (
                <button key={job.id} type="button" className="apx-mini-row" onClick={() => { setMetricDrawer(null); setSelectedJob(job); }}>
                  <span className="apx-avatar sm" style={avatarStyle(job.company)}>{initials(job.company)}</span>
                  <div><strong>{job.company}</strong><span>{cleanRoleTitle(job.role)}</span></div>
                  <em className={`apx-badge apx-badge--${badge.tone}`}>{badge.label}</em>
                </button>
              );
            })}
          </div>
        ) : (
          <EmptyState inline icon={<Icon name="check" />} title="Nothing here yet" message={metricDrawer?.empty ?? ""} />
        )}
      </Drawer>
    </div>
  );
}

function ChronicleNav({
  state,
  activeTab,
  onNavigate,
  pendingCount,
  scheduleLabel,
  currentTime,
  taskActive,
  stopping,
  onRun,
  onStop,
}: {
  state: DashboardState;
  activeTab: ChronicleTab;
  onNavigate: (tab: ChronicleTab) => void;
  pendingCount: number;
  scheduleLabel: string;
  currentTime: string;
  taskActive: boolean;
  stopping: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const tabs: { key: ChronicleTab; label: string }[] = [
    { key: "matches", label: "Automated" },
    { key: "automation", label: "Automation" },
    { key: "oneclick", label: "One-click" },
    { key: "applied", label: "Applied" },
    { key: "blocked", label: "Needs you" },
    { key: "profile", label: "Profile" },
    { key: "rules", label: "Rules" },
  ];
  const blockedCount = state.blocked?.length ?? 0;
  return (
    <header className="chronicle-nav">
      <div className="chronicle-brand">
        <span className="chronicle-mark"><Logo size={22} /></span>
        <span>ApplyPilot</span>
      </div>
      <div className="chronicle-divider" />
      <nav className="chronicle-tabs" aria-label="Chronicle sections">
        {tabs.map((tab) => (
          <button key={tab.key} className={activeTab === tab.key ? "is-active" : ""} type="button" onClick={() => onNavigate(tab.key)}>
            {tab.label}
            {tab.key === "oneclick" ? <span>{pendingCount}</span> : tab.key === "blocked" && blockedCount > 0 ? <span>{blockedCount}</span> : null}
          </button>
        ))}
      </nav>
      <div className="chronicle-nav-spacer" />
      <div className={`chronicle-live${taskActive ? " is-running" : ""}`}>
        <i />
        <span>{taskActive ? "Pilot running" : state.hero.live ? "Automated live" : "Automation ready"}</span>
      </div>
      <button className="chronicle-schedule" type="button" onClick={() => onNavigate("rules")}>
        <Icon name="clock" />
        <span>{scheduleLabel}</span>
      </button>
      <span className="chronicle-time">{currentTime}</span>
      <button className="chronicle-icon-btn" type="button" aria-label="Notifications">
        <Icon name="bell" />
        <i />
      </button>
      <button className={`chronicle-run${taskActive ? " is-stop" : ""}`} type="button" onClick={taskActive ? onStop : onRun} disabled={stopping}>
        <Icon name={taskActive ? "stop" : "play"} />
        {taskActive ? (stopping ? "Stopping" : "Stop") : "Run automation"}
      </button>
    </header>
  );
}

function automationNextStep(status: DashboardState["automationProgress"]["status"]): string {
  if (status === "queued") return "Starting matching";
  if (status === "discovering") return "Selecting best match";
  if (status === "matching") return "Preparing review packet";
  if (status === "preparing_packet") return "Filling application";
  if (status === "applying") return "Updating review queue";
  if (status === "needs_review") return "Manual review needed";
  if (status === "completed") return "Finished";
  if (status === "failed") return "Check error";
  if (status === "paused") return "Paused by safety rule";
  return "Ready when you are";
}

type Tone = "success" | "warning" | "info" | "brand";
type BadgeTone = Tone | "danger" | "neutral";
const TONE_VAR: Record<Tone, string> = {
  success: "var(--ap-success)", warning: "var(--ap-warning)", info: "var(--ap-info)", brand: "var(--ap-brand)",
};

/** A reusable metric tile built on the design system. */
function Metric({ label, value, sub, icon, tone = "brand" }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: "brand" | "teal" | "blue" | "amber" }) {
  return (
    <div className="apx-card apx-metric">
      <div className="apx-metric-top">
        <span className="apx-metric-label">{label}</span>
        {icon ? <span className={`apx-metric-icon ${tone}`}>{icon}</span> : null}
      </div>
      <div className="apx-metric-value">{value}</div>
      {sub ? <div className="apx-metric-sub">{sub}</div> : null}
    </div>
  );
}

/** Humanized audit timeline: friendly event labels, plain-English summaries, and any genuinely
 *  technical fields tucked behind an opt-in disclosure (never the raw dotted event keys). */
function ActivityTimeline({ entries, limit, showDetails = false, onItemClick }: {
  entries: DashboardState["log"];
  limit?: number;
  showDetails?: boolean;
  onItemClick?: () => void;
}) {
  const items = limit ? entries.slice(0, limit) : entries;
  return (
    <div className="apx-timeline">
      {items.map((entry, index) => {
        const split = splitReason(entry.text);
        const { label } = humanizeAction(entry.action);
        const tone = toneForDot(entry.dot);
        const details = showDetails ? humanizeDetails(entry.details) : [];
        return (
          <div
            className={`apx-timeline-item${onItemClick ? " is-clickable" : ""}`}
            key={`${entry.time}-${entry.action ?? "event"}-${index}`}
            onClick={onItemClick}
            role={onItemClick ? "button" : undefined}
            tabIndex={onItemClick ? 0 : undefined}
            onKeyDown={onItemClick ? (e) => { if (e.key === "Enter") onItemClick(); } : undefined}
          >
            <div className="apx-timeline-rail" style={{ color: TONE_VAR[tone] }}>
              <i style={{ background: "currentColor" }} /><span />
            </div>
            <div className="apx-timeline-body">
              <div className="apx-timeline-meta">
                <span className={`apx-badge apx-badge--${tone}`}>{label}</span>
                <time>{entry.time}</time>
              </div>
              <strong>{split.title}</strong>
              {split.summary ? <p>{split.summary}</p> : null}
              {details.length ? (
                <details className="apx-disclosure" onClick={(e) => e.stopPropagation()}>
                  <summary>Technical details</summary>
                  <div className="apx-disclosure-body">
                    <dl>{details.map((d, j) => <Fragment key={j}><dt>{d.label}</dt><dd>{d.value}</dd></Fragment>)}</dl>
                  </div>
                </details>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Pipeline as a horizontal funnel — clearer than a row of equal tiles. */
function PipelineFunnel({ pipeline }: { pipeline: DashboardState["applied"]["pipeline"] }) {
  const stages: { label: string; value: number; tone: Tone }[] = [
    { label: "Sent", value: pipeline.submitted, tone: "info" },
    { label: "Replied", value: pipeline.response, tone: "brand" },
    { label: "Interview", value: pipeline.interview, tone: "warning" },
    { label: "Offer", value: pipeline.offer, tone: "success" },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="apx-funnel">
      {stages.map((s) => (
        <div className="apx-funnel-row" key={s.label}>
          <span className="apx-funnel-label">{s.label}</span>
          <div className={`apx-meter ${s.tone === "info" ? "blue" : s.tone === "brand" ? "" : s.tone === "warning" ? "amber" : "teal"}`}>
            <span style={{ width: `${Math.max(s.value ? 8 : 0, Math.round((s.value / max) * 100))}%` }} />
          </div>
          <b>{s.value}</b>
        </div>
      ))}
    </div>
  );
}

/** Compact ranked list (companies / sources) used across the redesigned screens. */
function RankList({ rows, onSelect, emptyCopy }: {
  rows: { name: string; count: number; width: number; meta?: string }[];
  onSelect?: (name: string) => void;
  emptyCopy: string;
}) {
  if (rows.length === 0) return <p className="apx-metric-sub" style={{ padding: "8px 2px" }}>{emptyCopy}</p>;
  return (
    <div className="apx-rank">
      {rows.map((row, index) => (
        <button
          type="button"
          className="apx-rank-row"
          key={row.name}
          onClick={onSelect ? () => onSelect(row.name) : undefined}
          style={onSelect ? undefined : { cursor: "default" }}
        >
          <span className="apx-rank-mark" style={avatarStyle(row.name)}>{String(index + 1).padStart(2, "0")}</span>
          <span className="apx-rank-body">
            <span className="apx-rank-line"><strong>{row.name}</strong><b>{row.count}</b></span>
            {row.meta ? <span>{row.meta}</span> : null}
            <span className="apx-meter thin"><span style={{ width: `${row.width}%` }} /></span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** A queued role awaiting the user's review — same apply/discard wiring, redesigned surface. */
function ReviewQueueItem({ job, applied, applying, onSelect, onApply, onDiscard }: {
  job: ChronicleJob; applied: boolean; applying: boolean;
  onSelect: (job: ChronicleJob) => void; onApply: (job: ChronicleJob) => void; onDiscard: (job: ChronicleJob) => void;
}) {
  return (
    <div
      className={`apx-review-item${applied ? " is-applied" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(job)}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(job); }}
    >
      <div className="apx-review-top">
        <span className="apx-avatar sm" style={avatarStyle(job.company)}>{initials(job.company)}</span>
        <div className="apx-review-id"><strong>{job.company}</strong><span>{job.role}</span></div>
        <span className="apx-score">{job.score}<small>fit</small></span>
      </div>
      <p className="apx-review-why">{job.blockReason}</p>
      <div className="apx-review-actions">
        <button className="apx-btn apx-btn--primary apx-btn--sm" type="button" title={job.capabilityReason || undefined} onClick={(e) => { e.stopPropagation(); onApply(job); }} disabled={applied || applying || applyAction(job).kind === "none"}>
          {applied ? "✓ Applied" : applying ? applyAction(job).busyLabel : applyAction(job).label}
        </button>
        <button className="apx-btn apx-btn--ghost apx-btn--sm" type="button" onClick={(e) => { e.stopPropagation(); onDiscard(job); }} disabled={applied || applying}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function AutomatedView({
  state,
  pendingJobs,
  appliedJobs,
  topJob,
  weeklyData,
  weeklyPath,
  rules,
  onAutomation,
  onSelectJob,
  onSelectCompany,
  onApply,
  onDiscard,
  onBatch,
  onReview,
  onDiscovery,
  onMetric,
  onNeedsYou,
  appliedJobIds,
  applyingJobId,
}: {
  state: DashboardState;
  pendingJobs: ChronicleJob[];
  appliedJobs: ChronicleJob[];
  topJob: ChronicleJob | null;
  weeklyData: number[];
  weeklyPath: ReturnType<typeof buildPath>;
  rules: { label: string; color: string }[];
  onAutomation: () => void;
  onSelectJob: (job: ChronicleJob) => void;
  onSelectCompany: (company: string) => void;
  onApply: (job: ChronicleJob) => void;
  onDiscard: (job: ChronicleJob) => void;
  onBatch: () => void;
  onReview: () => void;
  onDiscovery: () => void;
  onMetric: (view: { title: string; eyebrow: string; jobs: ChronicleJob[]; empty: string }) => void;
  /** Navigate to the "Needs you" tab (state.blocked list). */
  onNeedsYou: () => void;
  appliedJobIds: string[];
  applyingJobId: string | null;
}) {
  const companyRows = topCompanies(state, pendingJobs);
  const salaryRows = salaryBuckets(pendingJobs, state.rules.minSalaryK);
  const activeJob = topJob;
  const progress = state.automationProgress;
  const engineRunning = ["queued", "discovering", "matching", "preparing_packet", "applying"].includes(progress.status);
  const enginePct = Math.max(0, Math.min(100, Math.round(progress.percentComplete || 0)));
  const engineTitle =
    progress.status === "failed"
      ? "Automation needs attention."
      : progress.status === "needs_review"
        ? "Review packets are ready."
        : progress.status === "completed"
          ? "Automation completed."
          : engineRunning
            ? "Pilot is working."
            : "Pilot is ready.";
  const engineSubtitle = progress.status === "idle" ? "You stay in control." : "You stay in control.";
  const currentStep = progress.currentStepLabel || (activeJob ? `Preparing: ${activeJob.role} · ${activeJob.company}` : "Waiting for matching roles");
  const nextStep = automationNextStep(progress.status);
  const qualifiedMetric = progress.status === "idle" && !progress.jobId ? state.hero.metrics.qualified : progress.qualifiedCount;
  const oneClickMetric = progress.status === "idle" && !progress.jobId ? pendingJobs.length : progress.oneClickCount;
  const appliedMetric = progress.status === "idle" && !progress.jobId ? state.hero.metrics.appliedTotal : progress.appliedCount;
  const logEntries = automationLogEntries(state);
  const sentTotal = state.applied.pipeline.submitted || state.applied.summary.sent;
  const rolesFound = state.coverage.sources.reduce((sum, s) => sum + s.found, 0) || state.hero.metrics.qualified;
  const weeklyTotal = weeklyData.reduce((a, b) => a + b, 0);

  // The single most useful thing to do next — derived from real pipeline state, never invented.
  const nextAction = pendingJobs.length > 0
    ? { headline: `${pendingJobs.length} role${pendingJobs.length > 1 ? "s" : ""} ready for your review`, copy: "ApplyPilot prepared these against your approved profile. Nothing is submitted until you review and confirm each one.", cta: "Open review queue", onCta: onReview }
    : sentTotal > 0
      ? { headline: "You're all caught up", copy: "No roles are waiting on you. Run a fresh search to surface new matches from employer career pages.", cta: "Find new roles", onCta: onDiscovery }
      : { headline: "Let's find your first matches", copy: "Run discovery to search employer career pages for roles that fit your profile and résumé facts.", cta: "Run discovery", onCta: onDiscovery };

  const engineTone: Tone = progress.status === "failed" ? "warning" : progress.status === "needs_review" ? "warning" : progress.status === "completed" ? "success" : engineRunning ? "brand" : "info";
  const engineBadge = progress.status === "failed" ? "Needs attention" : progress.status === "needs_review" ? "Review needed" : progress.status === "completed" ? "Completed" : engineRunning ? "Working" : "Ready";

  const live = liveActivityFromState(state);
  // Classify by the real application tag (jobFromApplied defaults status to "submitted", so it can't be
  // trusted): anything paused / awaiting you is "needs attention", everything else was actually sent.
  const needsAttention = (j: ChronicleJob) => /paus|account|skip|challeng|fail|needs|review/i.test(j.blockReason);
  const submittedJobs = appliedJobs.filter((j) => !needsAttention(j));
  // Parked-for-you applications (login/CAPTCHA) now live on their own "Needs you" tab; this card
  // mirrors that list and links straight to it instead of re-deriving a count from applied tags.
  const blockedCount = state.blocked?.length ?? 0;

  return (
    <div className="apx-stack">
      {/* Live activity — real telemetry only (state.liveActivity); idle shows a calm resting state. */}
      <LiveActivity data={live} variant="full" onClick={live.active ? onAutomation : onReview} />

      {/* At-a-glance counts the prompt asks for, each clickable to a breakdown drawer. */}
      <div className="apx-grid apx-grid-4">
        <StatCard label="In progress" value={live.active ? 1 : 0} sub={live.active ? live.stageLabel : "nothing filling now"} icon={<Icon name="spark" />} tone="brand" onClick={onAutomation} title="View automation runs" />
        <StatCard label="Awaiting review" value={pendingJobs.length} sub={pendingJobs.length ? "ready for your confirmation" : "queue is clear"} icon={<Icon name="check" />} tone="amber" onClick={() => onMetric({ eyebrow: "Review queue", title: "Awaiting your review", jobs: pendingJobs, empty: "No roles are waiting. Run a search to surface matches from employer career pages." })} />
        <StatCard label="Submitted" value={sentTotal} sub={`${state.applied.pipeline.interview} interview, ${state.applied.pipeline.response} replies`} icon={<Icon name="send" />} tone="teal" onClick={() => onMetric({ eyebrow: "Applications", title: "Submitted applications", jobs: submittedJobs, empty: "No applications submitted yet." })} />
        <StatCard label="Needs you" value={blockedCount} sub={blockedCount ? "login or CAPTCHA" : "nothing blocked"} icon={<Icon name="shield" />} tone="blue" onClick={onNeedsYou} title="Open the Needs you tab" />
      </div>

      {/* Mission control + review queue */}
      <div className="apx-grid apx-grid-12">
        <section className="apx-card apx-hero col-8">
          <div className="apx-hero-glow" />
          <div className="apx-card-head">
            <div>
              <p className="apx-eyebrow">Pilot status</p>
              <h2 className="apx-card-title">{nextAction.headline}</h2>
            </div>
            <span className={`apx-badge apx-badge--${engineTone}`}>{engineBadge}</span>
          </div>
          <p className="apx-hero-copy">{nextAction.copy}</p>

          {engineRunning || progress.status === "needs_review" || progress.status === "failed" ? (
            <div className="apx-hero-progress" aria-live="polite">
              <div className="apx-spread"><span className="apx-hero-step">{currentStep}</span><b>{enginePct}%</b></div>
              <div className="apx-meter"><span style={{ width: `${enginePct}%` }} /></div>
              <span className="apx-hero-next">Next: {nextStep}</span>
              {progress.errorMessage ? <p className="apx-hero-err">{progress.errorMessage}</p> : null}
            </div>
          ) : null}

          <div className="apx-hero-foot">
            <button className="apx-btn apx-btn--primary" type="button" onClick={nextAction.onCta}>
              {pendingJobs.length > 0 ? <Icon name="shield" /> : <Icon name="search" />}{nextAction.cta}
            </button>
            <div className="apx-hero-stats">
              <div><strong>{qualifiedMetric}</strong><span>Qualified</span></div>
              <div><strong>{oneClickMetric}</strong><span>To review</span></div>
              <div><strong>{appliedMetric}</strong><span>Applied</span></div>
            </div>
          </div>
        </section>

        <section className="apx-card col-4 apx-queue">
          <div className="apx-card-head">
            <div><p className="apx-eyebrow">Review queue</p><h2 className="apx-card-title">Needs your tap</h2></div>
            {pendingJobs.length > 0 ? <span className="apx-badge apx-badge--brand">{pendingJobs.length}</span> : null}
          </div>
          {pendingJobs.length > 0 ? (
            <>
              <div className="apx-queue-list">
                {pendingJobs.slice(0, 3).map((job) => (
                  <ReviewQueueItem key={job.id} job={job} applied={appliedJobIds.includes(job.id)} applying={applyingJobId === job.id} onSelect={onSelectJob} onApply={onApply} onDiscard={onDiscard} />
                ))}
              </div>
              <button className="apx-btn apx-btn--secondary apx-btn--block" type="button" onClick={onBatch}>
                <Icon name="send" /> Review all {pendingJobs.length}
              </button>
            </>
          ) : (
            <div className="apx-empty is-inline">
              <span className="apx-empty-icon"><Icon name="check" /></span>
              <h3>Queue is clear</h3>
              <p>Run a search and matched roles will line up here for your review.</p>
            </div>
          )}
        </section>
      </div>

      {/* Activity + pipeline */}
      <div className="apx-grid apx-grid-12">
        <section className="apx-card col-8">
          <div className="apx-card-head">
            <div><p className="apx-eyebrow">Recent activity</p><h2 className="apx-card-title">What the pilot did</h2></div>
            <button className="apx-link-btn" type="button" onClick={onAutomation}>View all runs <Icon name="arrow-right" /></button>
          </div>
          {state.log.length > 0 ? (
            <ActivityTimeline entries={logEntries} limit={5} onItemClick={onAutomation} />
          ) : (
            <div className="apx-empty is-inline">
              <span className="apx-empty-icon"><Icon name="clock" /></span>
              <h3>No activity yet</h3>
              <p>Run automation and every step the pilot takes is logged here, in plain language.</p>
            </div>
          )}
        </section>

        <section className="apx-card col-4">
          <div className="apx-card-head">
            <div><p className="apx-eyebrow">Pipeline</p><h2 className="apx-card-title">Application stages</h2></div>
            <span className="apx-metric-sub">{weeklyTotal} this week</span>
          </div>
          <PipelineFunnel pipeline={state.applied.pipeline} />
          <div className="apx-divider" />
          {appliedJobs.length > 0 ? (
            <div className="apx-mini-rows">
              {appliedJobs.slice(0, 2).map((job) => {
                const badge = appliedStatusBadge(job.blockReason, job.status);
                return (
                  <button key={job.id} type="button" className="apx-mini-row" onClick={() => onSelectJob(job)}>
                    <span className="apx-avatar sm" style={avatarStyle(job.company)}>{initials(job.company)}</span>
                    <div><strong>{job.company}</strong><span>{cleanRoleTitle(job.role)}</span></div>
                    <em className={`apx-badge apx-badge--${badge.tone}`}>{badge.label}</em>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="apx-metric-sub" style={{ padding: "4px 2px" }}>Submitted applications will appear here.</p>
          )}
        </section>
      </div>

      {/* Insight row */}
      <div className="apx-grid apx-grid-3">
        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Pace</p><h2 className="apx-card-title">Activity over time</h2></div></div>
          <WeeklyChart path={weeklyPath} data={weeklyData} />
        </section>

        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Top matched</p><h2 className="apx-card-title">Companies</h2></div></div>
          <RankList rows={companyRows} onSelect={onSelectCompany} emptyCopy="Run a search to surface employers that match your résumé." />
        </section>

        <section className="apx-card">
          <div className="apx-card-head">
            <div><p className="apx-eyebrow">Match analysis</p><h2 className="apx-card-title">{activeJob ? activeJob.company : "No role yet"}</h2></div>
            {activeJob ? <span className="apx-badge apx-badge--brand">{activeJob.score}/100</span> : null}
          </div>
          {activeJob?.fit ? <FitPanel fit={activeJob.fit} /> : activeJob ? <FactorBars job={activeJob} /> : (
            <p className="apx-metric-sub" style={{ padding: "4px 2px" }}>Select a role to see why it scored the way it did.</p>
          )}
        </section>
      </div>
    </div>
  );
}

interface SourceHealthRow { sourceId: string; rawJobsFound: number; employerUrlsResolved: number; fullJdsFetched: number; recommendedJobs: number }
interface FunnelSummary {
  strong: number; good: number; possible: number; applyReady: number; manualRecommended: number;
  usEligible: number; deduped: number; bottleneck: string; sourceHealth?: SourceHealthRow[];
}
interface FullIntent {
  confidence: string; roleFamilies: string[]; targetTitles: string[]; adjacentTitles: string[]; excludedTitles: string[];
  seniority: { min: string; max: string }; mustHaveSkills: string[]; niceToHaveSkills: string[];
  requiredCredentials: string[]; industries: string[]; locations: string[]; workArrangement: string[];
  dealbreakers: string[]; compensation?: { min?: number; target?: number };
}
type WorkArrangement = "onsite" | "hybrid" | "remote_us";

const parseList = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
const joinList = (a?: string[]): string => (a ?? []).join(", ");

const SENIORITY_OPTIONS = [
  "intern", "entry", "associate", "mid", "senior", "lead", "manager", "director", "executive",
].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }));

const WORK_OPTIONS: { value: WorkArrangement; label: string }[] = [
  { value: "remote_us", label: "Remote (US)" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "Onsite" },
];

/** Read-only "search health" + editable target — resolved confidence, funnel diagnosis, source rows. */
function useSearchHealth(enabled: boolean): { intent: FullIntent | null; funnel: FunnelSummary | null; refresh: () => void } {
  const [intent, setIntent] = useState<FullIntent | null>(null);
  const [funnel, setFunnel] = useState<FunnelSummary | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void apiJson<{ intent: FullIntent }>("/api/search-intent")
      .then((r) => { if (!cancelled) setIntent(r.intent); })
      .catch(() => {});
    void apiJson<{ funnel: FunnelSummary | null }>("/api/automation/funnel")
      .then((r) => { if (!cancelled) setFunnel(r.funnel); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled, nonce]);
  return { intent, funnel, refresh: () => setNonce((n) => n + 1) };
}

const CONFIDENCE_LABEL: Record<string, string> = {
  confirmed: "Confirmed target",
  inferred_high: "Inferred (high) — confirm to enable apply",
  inferred_low: "Inferred (low) — confirm your target to apply",
  missing: "No target set — confirm to start",
};

interface TargetForm {
  targetTitles: string; adjacentTitles: string; excludedTitles: string; seniorityMin: string; seniorityMax: string;
  mustHaveSkills: string; niceToHaveSkills: string; requiredCredentials: string; industries: string; locations: string;
  dealbreakers: string; compensationMin: string; workArrangement: WorkArrangement[];
}

function formFromIntent(i: FullIntent | null): TargetForm {
  return {
    targetTitles: joinList(i?.targetTitles), adjacentTitles: joinList(i?.adjacentTitles), excludedTitles: joinList(i?.excludedTitles),
    seniorityMin: i?.seniority?.min ?? "mid", seniorityMax: i?.seniority?.max ?? "senior",
    mustHaveSkills: joinList(i?.mustHaveSkills), niceToHaveSkills: joinList(i?.niceToHaveSkills),
    requiredCredentials: joinList(i?.requiredCredentials), industries: joinList(i?.industries), locations: joinList(i?.locations),
    dealbreakers: joinList(i?.dealbreakers), compensationMin: i?.compensation?.min ? String(i.compensation.min) : "",
    workArrangement: (i?.workArrangement ?? ["remote_us"]).filter((w): w is WorkArrangement => w === "remote_us" || w === "hybrid" || w === "onsite"),
  };
}

function SearchHealthCard({ intent, funnel, refresh }: { intent: FullIntent | null; funnel: FunnelSummary | null; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<TargetForm>(() => formFromIntent(intent));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!intent && !funnel) return null;

  const openEdit = () => { setForm(formFromIntent(intent)); setError(null); setEditing(true); };
  const set = (patch: Partial<TargetForm>) => setForm((f) => ({ ...f, ...patch }));
  const toggleWork = (w: WorkArrangement) =>
    set({ workArrangement: form.workArrangement.includes(w) ? form.workArrangement.filter((x) => x !== w) : [...form.workArrangement, w] });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const compMin = Number(form.compensationMin);
      await apiPostJson("/api/search-intent", {
        targetTitles: parseList(form.targetTitles),
        adjacentTitles: parseList(form.adjacentTitles),
        excludedTitles: parseList(form.excludedTitles),
        seniorityMin: form.seniorityMin,
        seniorityMax: form.seniorityMax,
        mustHaveSkills: parseList(form.mustHaveSkills),
        niceToHaveSkills: parseList(form.niceToHaveSkills),
        requiredCredentials: parseList(form.requiredCredentials),
        industries: parseList(form.industries),
        locations: parseList(form.locations),
        dealbreakers: parseList(form.dealbreakers),
        workArrangement: form.workArrangement,
        ...(form.compensationMin.trim() && Number.isFinite(compMin) ? { compensationMin: compMin } : {}),
      });
      setEditing(false);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save target profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="apx-card">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">Search health</p>
          <h2>Target &amp; match funnel</h2>
          {intent ? (
            <p>
              {CONFIDENCE_LABEL[intent.confidence] ?? intent.confidence}
              {intent.targetTitles.length ? ` — ${intent.targetTitles.slice(0, 3).join(", ")}` : ""}
              {intent.roleFamilies.length ? ` (${intent.roleFamilies.slice(0, 3).join(", ")})` : ""}
            </p>
          ) : null}
        </div>
        <div className="apx-page-actions">
          <button className="apx-btn apx-btn--secondary" type="button" onClick={editing ? () => setEditing(false) : openEdit}>
            <Icon name="settings" /> {editing ? "Close" : "Edit target"}
          </button>
        </div>
      </div>

      {funnel ? (
        <>
          <div className="apx-grid apx-grid-4">
            <Metric label="Strong" value={funnel.strong} icon={<Icon name="spark" />} tone="brand" />
            <Metric label="Good" value={funnel.good} icon={<Icon name="check" />} tone="teal" />
            <Metric label="Apply-ready" value={funnel.applyReady} icon={<Icon name="send" />} tone="amber" />
            <Metric label="Manual only" value={funnel.manualRecommended} icon={<Icon name="clock" />} tone="blue" />
          </div>
          {funnel.bottleneck ? (
            <p className="apx-safenote"><Icon name="shield" /><span>{funnel.bottleneck}</span></p>
          ) : null}
          {funnel.sourceHealth && funnel.sourceHealth.length ? (
            <table className="apx-table">
              <thead>
                <tr><th>Source</th><th style={{ textAlign: "right" }}>Found</th><th style={{ textAlign: "right" }}>Employer URL</th><th style={{ textAlign: "right" }}>Full JD</th><th style={{ textAlign: "right" }}>Recommended</th></tr>
              </thead>
              <tbody>
                {funnel.sourceHealth.slice(0, 12).map((s) => (
                  <tr key={s.sourceId}>
                    <td>{s.sourceId}</td>
                    <td style={{ textAlign: "right" }}>{s.rawJobsFound}</td>
                    <td style={{ textAlign: "right" }}>{s.employerUrlsResolved}</td>
                    <td style={{ textAlign: "right" }}>{s.fullJdsFetched}</td>
                    <td style={{ textAlign: "right" }}>{s.recommendedJobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : (
        <p>No match funnel recorded yet — run discovery to see where jobs are won and lost.</p>
      )}

      {editing ? (
        <div className="apx-stack" style={{ marginTop: "var(--ap-space-4)" }}>
          <PTextarea label="Target roles (comma-separated, 3–7)" value={form.targetTitles} onChange={(v) => set({ targetTitles: v })} placeholder="AML Analyst, Compliance Analyst" rows={2} />
          <PTextarea label="Roles to avoid" value={form.excludedTitles} onChange={(v) => set({ excludedTitles: v })} optional placeholder="Software Engineer, Sales" rows={2} />
          <div className="apx-grid apx-grid-4">
            <PSelect label="Seniority min" value={form.seniorityMin} onChange={(v) => set({ seniorityMin: v })} options={SENIORITY_OPTIONS} />
            <PSelect label="Seniority max" value={form.seniorityMax} onChange={(v) => set({ seniorityMax: v })} options={SENIORITY_OPTIONS} />
            <PField label="Min compensation (USD)" value={form.compensationMin} onChange={(v) => set({ compensationMin: v })} type="number" optional placeholder="90000" />
          </div>
          <PTextarea label="Must-have skills" value={form.mustHaveSkills} onChange={(v) => set({ mustHaveSkills: v })} optional placeholder="AML, KYC, SQL" rows={2} />
          <PTextarea label="Nice-to-have skills" value={form.niceToHaveSkills} onChange={(v) => set({ niceToHaveSkills: v })} optional rows={2} />
          <PTextarea label="Adjacent roles you'd accept" value={form.adjacentTitles} onChange={(v) => set({ adjacentTitles: v })} optional rows={2} />
          <PTextarea label="Industries" value={form.industries} onChange={(v) => set({ industries: v })} optional placeholder="financial services, fintech" rows={2} />
          <PTextarea label="Required / pending credentials" value={form.requiredCredentials} onChange={(v) => set({ requiredCredentials: v })} optional placeholder="CAMS, CPA" rows={2} />
          <PTextarea label="Locations" value={form.locations} onChange={(v) => set({ locations: v })} optional placeholder="New York, NY" rows={2} />
          <PTextarea label="Dealbreakers" value={form.dealbreakers} onChange={(v) => set({ dealbreakers: v })} optional rows={2} />
          <div className="apx-field is-wide">
            <span>Work arrangement</span>
            <div style={{ display: "flex", gap: "var(--ap-space-4)", flexWrap: "wrap" }}>
              {WORK_OPTIONS.map((o) => (
                <label key={o.value} className="apx-check">
                  <input type="checkbox" checked={form.workArrangement.includes(o.value)} onChange={() => toggleWork(o.value)} />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </div>
          {error ? <p className="apx-safenote"><Icon name="shield" /><span>{error}</span></p> : null}
          <div className="apx-page-actions">
            <button className="apx-btn apx-btn--primary" type="button" onClick={save} disabled={saving}>
              <Icon name="check" /> {saving ? "Saving…" : "Confirm target"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AutomationTab({
  state,
  pendingJobs,
  appliedJobs,
  weeklyData,
  weeklyPath,
  onSelectCompany,
  onSelectJob,
  onRules,
  usingSample,
}: {
  state: DashboardState;
  pendingJobs: ChronicleJob[];
  appliedJobs: ChronicleJob[];
  weeklyData: number[];
  weeklyPath: ReturnType<typeof buildPath>;
  onSelectCompany: (company: string) => void;
  onSelectJob: (job: ChronicleJob) => void;
  onRules: () => void;
  usingSample: boolean;
}) {
  const { runs } = useRuns(0, !usingSample);
  const [runDetail, setRunDetail] = useState<AutomationRun | null>(null);
  const { intent: searchIntent, funnel: searchFunnel, refresh: refreshSearchHealth } = useSearchHealth(!usingSample);
  const live = liveActivityFromState(state);
  const logEntries = automationLogEntries(state);
  const companyRows = topCompanies(state, pendingJobs);
  const sources = state.coverage.sources;
  const totalFound = sources.reduce((sum, source) => sum + source.found, 0);
  const blockedSources = sources.filter((source) => source.status === "blocked").length;
  const maxFound = Math.max(1, ...sources.map((source) => source.found));
  const lastRun = state.lastRun;

  // Real run statistics, derived only from /api/runs. Anything the data can't support is omitted.
  const terminalRuns = runs.filter((r) => r.completedAt);
  const succeeded = runs.filter((r) => r.status === "completed" || r.status === "needs_review").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const successRate = terminalRuns.length ? Math.round((succeeded / terminalRuns.length) * 100) : null;
  const durations = runs.map((r) => r.durationMs).filter((d): d is number => typeof d === "number" && d > 0);
  const avgDurationMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const totalApplied = runs.reduce((sum, r) => sum + r.counts.applied, 0);
  const failureRows = Object.entries(
    runs
      .filter((r) => r.status === "failed" && r.errorMessage)
      .reduce<Record<string, number>>((acc, r) => {
        const key = r.errorMessage as string;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
  ).sort((a, b) => b[1] - a[1]);
  const runColumns: Column<AutomationRun>[] = [
    { key: "started", header: "Started", sortValue: (r) => r.startedAt, render: (r) => <span title={r.startedAt}>{relativeTime(r.startedAt)}</span> },
    { key: "status", header: "Status", sortValue: (r) => r.status, render: (r) => <StatusPill tone={statusMeta(r.status).tone} pulse={statusMeta(r.status).pulse}>{statusMeta(r.status).label}</StatusPill> },
    { key: "duration", header: "Duration", align: "right", sortValue: (r) => r.durationMs ?? 0, render: (r) => <span className="apx-td-num">{r.durationMs != null ? formatDuration(r.durationMs) : "—"}</span> },
    { key: "qualified", header: "Qualified", align: "right", sortValue: (r) => r.counts.qualified, render: (r) => <span className="apx-td-num">{r.counts.qualified}</span> },
    { key: "review", header: "To review", align: "right", sortValue: (r) => r.counts.oneClick, render: (r) => <span className="apx-td-num">{r.counts.oneClick}</span> },
    { key: "applied", header: "Applied", align: "right", sortValue: (r) => r.counts.applied, render: (r) => <span className="apx-td-num">{r.counts.applied}</span> },
  ];
  // Humanized event breakdown — group by friendly kind, never the raw dotted event keys.
  const kindCounts = logEntries.reduce<Record<string, number>>((counts, entry) => {
    const { label } = humanizeAction(entry.action);
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const kindRows = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]);
  const sourceTone = (status: string): Tone => status === "blocked" ? "warning" : status === "queued" ? "info" : "success";

  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">{state.runner?.running ? "Running now" : lastRun ? `Last run ${lastRun.at}` : "Ready"}</p>
          <h1>What the pilot did</h1>
          <p>A complete, plain-language audit of every discovery and application step — run entirely on your machine.</p>
        </div>
        <div className="apx-page-actions">
          <button className="apx-btn apx-btn--secondary" type="button" onClick={onRules}><Icon name="settings" /> Rules</button>
        </div>
      </div>

      {/* Search health — resolved target confidence + the latest honest match-funnel diagnosis. */}
      <SearchHealthCard intent={searchIntent} funnel={searchFunnel} refresh={refreshSearchHealth} />

      {/* Live activity — same shared component + real source as the Dashboard. */}
      <LiveActivity data={live} variant="full" />

      {/* Real run statistics (derived only from /api/runs). */}
      <div className="apx-grid apx-grid-4">
        <Metric label="Automation runs" value={runs.length} sub={lastRun ? `last at ${lastRun.at}` : "no runs yet"} icon={<Icon name="spark" />} tone="brand" />
        <Metric label="Success rate" value={successRate != null ? `${successRate}%` : "—"} sub={`${succeeded} ok, ${failed} failed`} icon={<Icon name="check" />} tone="teal" />
        <Metric label="Avg run time" value={avgDurationMs != null ? formatDuration(avgDurationMs) : "—"} sub={durations.length ? `${durations.length} timed runs` : "no timed runs"} icon={<Icon name="clock" />} tone="blue" />
        <Metric label="Applications filled" value={totalApplied} sub={`${pendingJobs.length} ready to review`} icon={<Icon name="send" />} tone="amber" />
      </div>

      {/* Structured run history — every pass clickable to its stage timeline. */}
      <section className="apx-card">
        <div className="apx-card-head">
          <div><p className="apx-eyebrow">Automation runs</p><h2 className="apx-card-title">Every pass, with its numbers</h2></div>
          {runs.length ? <span className="apx-badge apx-badge--neutral">{runs.length} runs</span> : null}
        </div>
        <DataTable
          columns={runColumns}
          rows={runs}
          getRowKey={(r) => r.id}
          onRowClick={setRunDetail}
          initialSort={{ key: "started", dir: "desc" }}
          maxHeight={440}
          empty={<EmptyState inline icon={<Icon name="clock" />} title="No automation runs yet" message={usingSample ? "Connect the local engine to see real runs." : "Press Run automation to start a pass. Each pass is recorded here with its stages and counts."} />}
        />
      </section>

      {/* Audit trail + source coverage */}
      <div className="apx-grid apx-grid-12">
        <section className="apx-card col-7">
          <div className="apx-card-head">
            <div><p className="apx-eyebrow">Full audit trail</p><h2 className="apx-card-title">Every step, in plain language</h2></div>
            <span className="apx-badge apx-badge--neutral">{logEntries.length} events</span>
          </div>
          {state.log.length > 0 ? (
            <ActivityTimeline entries={logEntries} showDetails />
          ) : (
            <div className="apx-empty is-inline">
              <span className="apx-empty-icon"><Icon name="clock" /></span>
              <h3>No runs yet</h3>
              <p>Start automation and each step is recorded here with the numbers behind it.</p>
            </div>
          )}
        </section>

        <section className="apx-card col-5">
          <div className="apx-card-head">
            <div><p className="apx-eyebrow">Discovery coverage</p><h2 className="apx-card-title">Sources searched</h2></div>
            <span className="apx-badge apx-badge--neutral">{state.coverage.companyPages || sources.length} companies</span>
          </div>
          {sources.length > 0 ? (
            <div className="apx-source-list">
              {sources.slice(0, 9).map((source) => (
                <button
                  key={`${source.name}-${source.url ?? source.kind}`}
                  type="button"
                  className="apx-source-row"
                  onClick={() => onSelectCompany(source.name)}
                >
                  <div className="apx-source-id">
                    <span className="apx-source-line"><strong>{source.name}</strong><span className={`apx-badge apx-badge--${sourceTone(source.status)}`}>{source.status}</span></span>
                    <span className="apx-source-meta">{source.via} · {source.lastChecked}</span>
                    <span className="apx-meter thin blue"><span style={{ width: `${Math.max(source.found ? 8 : 3, Math.round((source.found / maxFound) * 100))}%` }} /></span>
                  </div>
                  <b className="apx-source-count">{source.found}</b>
                </button>
              ))}
            </div>
          ) : (
            <div className="apx-empty is-inline">
              <span className="apx-empty-icon"><Icon name="search" /></span>
              <h3>No coverage yet</h3>
              <p>Run a search to build coverage from employer career pages.</p>
            </div>
          )}
        </section>
      </div>

      {/* Analytics row */}
      <div className="apx-grid apx-grid-3">
        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Pace</p><h2 className="apx-card-title">Activity over time</h2></div><span className="apx-metric-sub">{weeklyData.reduce((a, b) => a + b, 0)} total</span></div>
          <WeeklyChart path={weeklyPath} data={weeklyData} />
        </section>

        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Company signal</p><h2 className="apx-card-title">Most active employers</h2></div></div>
          <RankList rows={companyRows} onSelect={onSelectCompany} emptyCopy="Run automation to surface active employers." />
        </section>

        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">{failureRows.length ? "Failures" : "Latest pass"}</p><h2 className="apx-card-title">{failureRows.length ? "Why runs failed" : "Run summary"}</h2></div></div>
          {failureRows.length > 0 ? (
            <div className="apx-kind-list">
              {failureRows.map(([reason, count]) => (
                <div className="apx-kind-row" key={reason}><span className="apx-td-ellipsis" title={reason}>{reason}</span><b>{count}</b></div>
              ))}
            </div>
          ) : (
            <>
              <div className="apx-runsum">
                <div><strong>{lastRun?.considered ?? totalFound}</strong><span>Considered</span></div>
                <div><strong>{lastRun?.queued ?? pendingJobs.length}</strong><span>Queued</span></div>
                <div><strong>{lastRun?.skipped ?? 0}</strong><span>Skipped</span></div>
                <div><strong>{lastRun?.wouldSubmit ?? 0}</strong><span>Ready</span></div>
              </div>
              {kindRows.length > 0 ? (
                <>
                  <div className="apx-divider" />
                  <div className="apx-kind-list">
                    {kindRows.map(([label, count]) => (
                      <div className="apx-kind-row" key={label}><span>{label}</span><b>{count}</b></div>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          )}
        </section>
      </div>

      <Drawer
        open={Boolean(runDetail)}
        onClose={() => setRunDetail(null)}
        eyebrow="Automation run"
        title={runDetail ? statusMeta(runDetail.status).label : ""}
        subtitle={runDetail ? `Started ${relativeTime(runDetail.startedAt)}` : ""}
        badge={runDetail ? <StatusPill tone={statusMeta(runDetail.status).tone} pulse={statusMeta(runDetail.status).pulse}>{statusMeta(runDetail.status).label}</StatusPill> : null}
      >
        {runDetail ? (
          <>
            <dl className="apx-kv">
              <div><dt>Started</dt><dd>{new Date(runDetail.startedAt).toLocaleString()}</dd></div>
              <div><dt>Completed</dt><dd className={runDetail.completedAt ? "" : "is-empty"}>{runDetail.completedAt ? new Date(runDetail.completedAt).toLocaleString() : "in progress"}</dd></div>
              <div><dt>Duration</dt><dd>{runDetail.durationMs != null ? formatDuration(runDetail.durationMs) : "in progress"}</dd></div>
              <div><dt>Current step</dt><dd>{runDetail.currentStepLabel}</dd></div>
            </dl>
            <div>
              <p className="apx-section-title">Counts</p>
              <div className="apx-runsum">
                <div><strong>{runDetail.counts.qualified}</strong><span>Qualified</span></div>
                <div><strong>{runDetail.counts.oneClick}</strong><span>To review</span></div>
                <div><strong>{runDetail.counts.applied}</strong><span>Filled</span></div>
                <div><strong>{runDetail.counts.skipped}</strong><span>Skipped</span></div>
              </div>
            </div>
            {runDetail.errorMessage ? (
              <div className="apx-error">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>
                <div><strong>Run error</strong><p>{runDetail.errorMessage}</p></div>
              </div>
            ) : null}
            <div>
              <p className="apx-section-title">Stage timeline</p>
              {runDetail.events.length ? (
                <div className="apx-timeline">
                  {runDetail.events.map((ev, i) => (
                    <div className="apx-timeline-item" key={`${i}-${ev.slice(0, 12)}`}>
                      <div className="apx-timeline-rail"><i style={{ background: "var(--ap-info)", color: "var(--ap-info)" }} /><span /></div>
                      <div className="apx-timeline-body"><strong>{ev}</strong></div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="apx-metric-sub">No stage events recorded for this run.</p>
              )}
            </div>
          </>
        ) : null}
      </Drawer>
    </div>
  );
}

function MiniQueueCard({ job, applied, applying, onSelect, onApply, onDiscard }: { job: ChronicleJob; applied: boolean; applying: boolean; onSelect: (job: ChronicleJob) => void; onApply: (job: ChronicleJob) => void; onDiscard: (job: ChronicleJob) => void }) {
  return (
    <article className={`mini-queue-card${applied ? " is-applied" : ""}`} onClick={() => onSelect(job)}>
      <div className="mini-card-head">
        <div><strong>{job.company}</strong><span>{job.role}</span></div>
        <div className="mini-card-head-right">
          {job.tier ? <span className={`tier-badge tier-${job.tier}`} title={`Tier ${job.tier}`}>{job.tier}</span> : null}
          <b>{job.score}</b>
        </div>
      </div>
      <p>{job.blockReason}</p>
      <div className="mini-card-actions">
        <button type="button" title={job.capabilityReason || undefined} onClick={(event) => { event.stopPropagation(); onApply(job); }} disabled={applied || applying || applyAction(job).kind === "none"}>
          {applied ? "✓ Applied" : applying ? applyAction(job).busyLabel : applyAction(job).label}
        </button>
        <button className="discard-btn" type="button" onClick={(event) => { event.stopPropagation(); onDiscard(job); }} disabled={applied || applying}>
          Discard
        </button>
      </div>
    </article>
  );
}

function OneClickTab({
  state,
  pendingJobs,
  appliedJobIds,
  applyingJobId,
  onSelectJob,
  onApply,
  onDiscard,
  onBatch,
}: {
  state: DashboardState;
  pendingJobs: ChronicleJob[];
  appliedJobIds: string[];
  applyingJobId: string | null;
  onSelectJob: (job: ChronicleJob) => void;
  onApply: (job: ChronicleJob) => void;
  onDiscard: (job: ChronicleJob) => void;
  onBatch: () => void;
}) {
  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">Needs your review</p>
          <h1>Review queue</h1>
          <p>Roles that cleared your rules but need one human confirmation. ApplyPilot opens the employer form and pauses (you review, then submit).</p>
        </div>
        {pendingJobs.length > 0 ? (
          <div className="apx-page-actions">
            <button className="apx-btn apx-btn--primary" type="button" onClick={onBatch}><Icon name="send" /> Review all {pendingJobs.length}</button>
          </div>
        ) : null}
      </div>

      {/* Same live "currently filling" indicator as the Dashboard (one component, one data source). */}
      <LiveActivity data={liveActivityFromState(state)} variant="full" />

      {pendingJobs.length === 0 ? (
        <section className="apx-card">
          <div className="apx-empty">
            <span className="apx-empty-icon"><Icon name="check" /></span>
            <h3>Nothing waiting on you</h3>
            <p>When a search turns up roles that clear your rules but need one confirmation, they line up here. Run a search to fill the queue.</p>
          </div>
        </section>
      ) : (
        <div className="apx-grid apx-grid-3 apx-jobgrid">
          {pendingJobs.map((job) => {
            const applied = appliedJobIds.includes(job.id);
            const applying = applyingJobId === job.id;
            return (
              <article key={job.id} className={`apx-card is-interactive apx-jobcard${applied ? " is-applied" : ""}`} onClick={() => onSelectJob(job)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onSelectJob(job); }}>
                <div className="apx-jobcard-top">
                  <div className="apx-jobcard-id">
                    <span className="apx-avatar sm" style={avatarStyle(job.company)}>{initials(job.company)}</span>
                    <div><strong>{job.company}</strong><span>{job.ats}</span></div>
                  </div>
                  <div className="apx-jobcard-score"><strong>{job.score}</strong><span>fit</span></div>
                </div>
                <h2 className="apx-jobcard-role">{cleanRoleTitle(job.role)}</h2>
                <p className="apx-jobcard-meta">{[job.salary, job.location].filter(Boolean).join(" · ")}</p>
                {job.applyReady || job.tags.length ? (
                  <div className="apx-jobcard-tags">
                    {job.applyReady ? <span className="apx-tag apx-tag--ready">Recommended</span> : null}
                    {job.tags.slice(0, 3).map((t) => <span key={t} className="apx-tag">{t}</span>)}
                  </div>
                ) : null}
                <div className="apx-jobcard-why">
                  <span className="apx-eyebrow">{job.applyReady ? "Needs confirmation" : "Why it's listed"}</span>
                  <p>{job.blockReason}</p>
                </div>
                <div className="apx-jobcard-actions">
                  <button className="apx-btn apx-btn--primary apx-btn--sm" type="button" title={job.capabilityReason || undefined} onClick={(e) => { e.stopPropagation(); onApply(job); }} disabled={applied || applying || applyAction(job).kind === "none"}>
                    {applied ? "✓ Applied" : applying ? applyAction(job).busyLabel : applyAction(job).kind === "prefill" ? <><Icon name="shield" /> Prefill application</> : applyAction(job).label}
                  </button>
                  <button className="apx-btn apx-btn--ghost apx-btn--sm" type="button" onClick={(e) => { e.stopPropagation(); onDiscard(job); }} disabled={applied || applying}>Dismiss</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * "Needs you" tab: the applications the pilot PARKED because they need a human in person — a login /
 * account wall or a CAPTCHA it will never solve. It set them aside and kept going; the user finishes
 * each one by hand from here. The row's "Open" action just opens the posting in a new tab (the same
 * open-a-URL mechanism the Applied rows use) — it never triggers an apply/submit call.
 */
export function BlockedView({ blocked }: { blocked: BlockedApplication[] }) {
  // Login vs CAPTCHA read as distinct pills: a login wall is an amber "do this", a CAPTCHA is an
  // informational "solve this on the page".
  const reasonTone = (reason: BlockedApplication["reason"]) => (reason === "captcha" ? "info" : "warning");

  const columns: Column<BlockedApplication>[] = [
    {
      key: "role",
      header: "Role",
      sortValue: (b) => `${b.company}${b.title}`,
      render: (b) => (
        <div className="apx-row" style={{ gap: 10 }}>
          <span className="apx-avatar sm" style={avatarStyle(b.company)}>{initials(b.company)}</span>
          <div style={{ minWidth: 0 }}>
            <div className="apx-td-strong apx-td-ellipsis">{cleanRoleTitle(b.title)}</div>
            <div className="apx-metric-sub apx-td-ellipsis">{b.company}</div>
          </div>
        </div>
      ),
    },
    {
      key: "reason",
      header: "Why it's paused",
      sortValue: (b) => b.reason,
      render: (b) => <StatusPill tone={reasonTone(b.reason)}>{b.reasonLabel}</StatusPill>,
    },
    {
      key: "action",
      header: "",
      align: "right",
      render: (b) =>
        b.url ? (
          <a className="apx-btn apx-btn--secondary apx-btn--sm" style={{ textDecoration: "none" }} href={b.url} target="_blank" rel="noreferrer">
            Open <Icon name="arrow-right" />
          </a>
        ) : (
          <span className="apx-metric-sub">No link</span>
        ),
    },
  ];

  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">Paused for you</p>
          <h1>Needs you</h1>
          <p>These applications paused for a login or CAPTCHA. The app set them aside and kept going — finish them here when you have a minute.</p>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={blocked}
        getRowKey={(b) => b.id}
        empty={<EmptyState icon={<Icon name="check" />} title="Nothing needs you right now" message="Blocked applications will collect here." />}
      />
    </div>
  );
}

/** The applied feed sometimes glues a work-mode/location onto the role with no separator
 *  (e.g. "…(Merchant Advocacy)Remote US"). Peel a trailing location-ish suffix for readability. */
function cleanRoleTitle(role: string): string {
  return role.replace(/\)\s*(Remote(?:\s*US)?|Hybrid|On-?site|In-?office|US)\b.*$/i, ")").trim() || role;
}

/** Notes arrive as "<reason> • <time>" with internal reason words. Translate to user language. */
function humanizeAppliedNote(note: string): string {
  if (!note) return "";
  const parts = note.split(/\s*[•·]\s*/).filter(Boolean);
  const map: Record<string, string> = {
    challenge: "Paused at a verification step",
    login: "Waiting on a sign-in step",
    "account creation": "Waiting on an account step",
    captcha: "Paused at a verification step",
  };
  const first = parts[0]?.toLowerCase().trim() ?? "";
  const reason = map[first] ?? (parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1) : "");
  return [reason, ...parts.slice(1)].filter(Boolean).join(" · ");
}

/** The honest application status, derived from the tag (so a paused run never reads "Submitted"). */
function appliedStatusBadge(tag: string, status: JobStatus): { label: string; tone: BadgeTone } {
  const t = (tag || "").toLowerCase();
  if (t.includes("paus")) return { label: "Paused", tone: "warning" };
  if (t.includes("challenge") || t.includes("needs") || t.includes("review")) return { label: "Needs you", tone: "warning" };
  if (t.includes("reject")) return { label: "Rejected", tone: "danger" };
  if (t.includes("interview")) return { label: "Interview", tone: "info" };
  if (t.includes("offer")) return { label: "Offer", tone: "success" };
  if (t.includes("response") || t.includes("reply")) return { label: "Replied", tone: "brand" };
  if (status === "submitted" || t.includes("submit") || t.includes("sent")) return { label: "Submitted", tone: "success" };
  return { label: tag || statusLabel(status), tone: "neutral" };
}

type AppliedFilter = "all" | "submitted" | "review" | "draft";

function fmtAnswerValue(v: string | string[] | null): string {
  if (v == null) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}

function AppliedTab({
  usingSample,
  refreshNonce,
  onToast,
}: {
  usingSample: boolean;
  refreshNonce: number;
  onToast: (message: string) => void;
}) {
  const { applications, loading, error, reload } = useApplications(refreshNonce, !usingSample);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AppliedFilter>("all");
  const [selected, setSelected] = useState<ApplicationDetail | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  const q = query.trim().toLowerCase();
  const isReview = (a: ApplicationDetail) => !a.submitted && /needs_review|challenge|account|paus/i.test(a.status);
  const inFilter = (a: ApplicationDetail) =>
    filter === "all" ? true : filter === "submitted" ? a.submitted : filter === "review" ? isReview(a) : a.source === "draft" && !a.submitted;
  const filtered = applications
    .filter((a) => !q || `${a.company ?? ""} ${a.title ?? ""}`.toLowerCase().includes(q))
    .filter(inFilter);
  const counts = {
    all: applications.length,
    submitted: applications.filter((a) => a.submitted).length,
    review: applications.filter(isReview).length,
    draft: applications.filter((a) => a.source === "draft" && !a.submitted).length,
  };
  const tabs: { key: AppliedFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "submitted", label: "Submitted", count: counts.submitted },
    { key: "review", label: "Needs review", count: counts.review },
    { key: "draft", label: "Drafts", count: counts.draft },
  ];

  const statusLabel = (a: ApplicationDetail) => (a.submitted ? "Submitted" : statusMeta(a.status).label);
  const statusTone = (a: ApplicationDetail) => (a.submitted ? "success" : statusMeta(a.status).tone);

  const columns: Column<ApplicationDetail>[] = [
    {
      key: "role",
      header: "Role",
      sortValue: (a) => `${a.company ?? ""}${a.title ?? ""}`,
      render: (a) => (
        <div className="apx-row" style={{ gap: 10 }}>
          <span className="apx-avatar sm" style={avatarStyle(a.company ?? "?")}>{initials(a.company ?? "?")}</span>
          <div style={{ minWidth: 0 }}>
            <div className="apx-td-strong apx-td-ellipsis">{cleanRoleTitle(a.title ?? "Role")}</div>
            <div className="apx-metric-sub apx-td-ellipsis">{a.company ?? "Company"}</div>
          </div>
        </div>
      ),
    },
    { key: "status", header: "Status", sortValue: (a) => statusLabel(a), render: (a) => <StatusPill tone={statusTone(a)} pulse={statusMeta(a.status).pulse}>{statusLabel(a)}</StatusPill> },
    { key: "fill", header: "Form fill", sortValue: (a) => (a.fill ? a.fill.filled.length : -1), render: (a) => (a.fill ? <span className="apx-badge apx-badge--success">{a.fill.filled.length} fields</span> : <span className="apx-badge apx-badge--neutral">not filled</span>) },
    { key: "updated", header: "Updated", align: "right", sortValue: (a) => a.createdAt, render: (a) => <span className="apx-metric-sub">{relativeTime(a.createdAt)}</span> },
  ];

  const changeStatus = async (draftId: string, status: ApplicationDraftStatus) => {
    setStatusBusy(true);
    try {
      await apiPostJson("/api/application-drafts", { id: draftId, status });
      onToast(`Marked ${status}.`);
      reload();
    } catch (e) {
      onToast(`Could not update: ${String((e as Error).message ?? e)}`);
    } finally {
      setStatusBusy(false);
    }
  };

  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">Pipeline</p>
          <h1>Applications</h1>
          <p>Every role ApplyPilot prepared, paused on, or submitted, with the actual answers it put on each form.</p>
        </div>
      </div>

      <div className="apx-spread apx-applied-toolbar">
        <div className="apx-seg" role="tablist" aria-label="Filter applications">
          {tabs.map((tab) => (
            <button key={tab.key} role="tab" aria-selected={filter === tab.key} className={`apx-seg-btn${filter === tab.key ? " is-active" : ""}`} type="button" onClick={() => setFilter(tab.key)}>
              {tab.label}<span>{tab.count}</span>
            </button>
          ))}
        </div>
        <label className="apx-search">
          <Icon name="search" />
          <input type="search" value={query} placeholder="Search company or role" onChange={(e) => setQuery(e.target.value)} aria-label="Search applications" />
        </label>
      </div>

      {error ? (
        <div className="apx-error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></svg>
          <div><strong>Applications could not load</strong><p>{error}</p></div>
        </div>
      ) : null}

      {loading ? (
        <div className="apx-card"><Skeleton lines={6} /></div>
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(a) => a.dedupKey}
          onRowClick={setSelected}
          initialSort={{ key: "updated", dir: "desc" }}
          empty={<EmptyState icon={<Icon name="file" />} title={q ? "No matches" : "No applications yet"} message={q ? "Try a different search." : "Prepared and submitted applications appear here, with the field-by-field answers the form-fill agent produced."} />}
        />
      )}

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        eyebrow={selected?.company ?? "Application"}
        title={selected ? cleanRoleTitle(selected.title ?? "Application") : ""}
        subtitle={selected?.url ?? ""}
        width={620}
        badge={selected ? <StatusPill tone={statusTone(selected)} pulse={statusMeta(selected.status).pulse}>{statusLabel(selected)}</StatusPill> : null}
      >
        {selected ? <ApplicationDetailBody app={selected} busy={statusBusy} onStatus={changeStatus} /> : null}
      </Drawer>
    </div>
  );
}

function ApplicationDetailBody({ app, busy, onStatus }: { app: ApplicationDetail; busy: boolean; onStatus: (id: string, status: ApplicationDraftStatus) => void }) {
  const fill = app.fill;
  const draftStatuses: ApplicationDraftStatus[] = ["saved", "applied", "interviewing", "rejected", "offer"];
  return (
    <>
      <dl className="apx-kv">
        <div><dt>Status</dt><dd>{app.submitted ? "Submitted" : statusMeta(app.status).label}</dd></div>
        <div><dt>Source</dt><dd>{app.source === "applied" ? "Applied via the pipeline" : "Prepared draft"}</dd></div>
        {app.ats ? <div><dt>Employer ATS</dt><dd>{titleCase(app.ats)}</dd></div> : null}
        {app.url ? <div><dt>Apply URL</dt><dd className="is-mono"><a href={app.url} target="_blank" rel="noreferrer">{app.url}</a></dd></div> : null}
        <div><dt>Updated</dt><dd>{relativeTime(app.createdAt)}</dd></div>
        {fill ? <div><dt>Form snapshot</dt><dd>{fill.submitted ? "captured at submit" : "captured at fill"}, {relativeTime(fill.capturedAt)}</dd></div> : null}
      </dl>

      {app.draft ? (
        <div className="apx-subcard">
          <p className="apx-section-title">Pipeline stage</p>
          <select className="apx-select" disabled={busy} value={app.draft.status} onChange={(e) => app.draft && onStatus(app.draft.id, e.target.value as ApplicationDraftStatus)}>
            {draftStatuses.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </div>
      ) : null}

      <div>
        <p className="apx-section-title">What was put on the form</p>
        {fill ? (
          <div className="apx-answers">
            {fill.filled.length === 0 && fill.flagged.length === 0 && fill.needsConfirmation.length === 0 ? (
              <p className="apx-metric-sub">No fields were enumerated on this form.</p>
            ) : null}
            {fill.redactedCount > 0 ? <p className="apx-answer-note">{fill.redactedCount} sensitive value(s) were handled but are not stored.</p> : null}
            {fill.filled.map((f, i) => (
              <div className="apx-answer" key={`f${i}`}>
                <div className="apx-answer-q"><span>{f.label}</span>{f.redacted ? <span className="apx-badge apx-badge--neutral">private</span> : null}</div>
                <p className="apx-answer-a">{f.redacted ? <span className="apx-answer-redacted">Sensitive value, not stored</span> : fmtAnswerValue(f.value) || "(blank)"}</p>
              </div>
            ))}
            {fill.flagged.map((f, i) => (
              <div className="apx-answer is-flagged" key={`g${i}`}>
                <div className="apx-answer-q"><span>{f.label}</span><span className="apx-badge apx-badge--warning">review</span></div>
                <p className="apx-answer-a">{f.redacted ? <span className="apx-answer-redacted">Sensitive value, not stored</span> : fmtAnswerValue(f.value) || "(blank)"}</p>
                {f.rationale ? <p className="apx-answer-note">{f.rationale}</p> : null}
              </div>
            ))}
            {fill.needsConfirmation.map((f, i) => (
              <div className="apx-answer is-pending" key={`p${i}`}>
                <div className="apx-answer-q"><span>{f.label}</span><span className="apx-badge apx-badge--info">needs you</span></div>
                <p className="apx-answer-note">{f.rationale || "Left for you to answer in the review step (nothing is guessed)."}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="apx-metric-sub">No form-fill snapshot yet. Open this role in the Review queue to fill the employer form, then the answers appear here.</p>
        )}
      </div>

      {app.draft?.tailoredResumeSummary ? (
        <div>
          <p className="apx-section-title">Tailored resume summary</p>
          <div className="apx-subcard" style={{ whiteSpace: "pre-wrap" }}>{app.draft.tailoredResumeSummary}</div>
        </div>
      ) : null}

      {app.draft?.coverLetter ? (
        <div>
          <p className="apx-section-title">Cover letter</p>
          <div className="apx-subcard" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflowY: "auto" }}>{app.draft.coverLetter}</div>
        </div>
      ) : null}

      {app.draft && app.draft.applicationAnswers.length > 0 ? (
        <div>
          <p className="apx-section-title">Your saved answers (source to compare against)</p>
          <dl className="apx-kv">
            {app.draft.applicationAnswers.map((qa, i) => (
              <div key={i}><dt>{qa.question}</dt><dd>{qa.answer}</dd></div>
            ))}
          </dl>
        </div>
      ) : null}
    </>
  );
}

function ProfileTab({
  state,
  usingSample,
  onToast,
  onReload,
}: {
  state: DashboardState;
  usingSample: boolean;
  onToast: (message: string) => void;
  onReload: () => void;
}) {
  const profile = state.profile;
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [wipingBrowser, setWipingBrowser] = useState(false);

  useEffect(() => {
    if (usingSample) {
      setForm(formFromProfileSnapshot(state));
      return;
    }
    let cancelled = false;
    apiFetch("/api/profile", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<{ form: ProfileForm }>)
      .then((data) => {
        if (!cancelled) setForm(data.form);
      })
      .catch(() => {
        if (!cancelled) setForm(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state.profile.email, usingSample]);

  const update = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };

  const toggleWorkMode = (mode: ProfileForm["workModes"][number]) => {
    setForm((current) => {
      if (!current) return current;
      const next = current.workModes.includes(mode)
        ? current.workModes.filter((item) => item !== mode)
        : [...current.workModes, mode];
      return { ...current, workModes: next };
    });
  };
  const toggleEmploymentType = (kind: ProfileForm["employmentTypes"][number]) => {
    setForm((current) => {
      if (!current) return current;
      const next = (current.employmentTypes ?? []).includes(kind)
        ? (current.employmentTypes ?? []).filter((item) => item !== kind)
        : [...(current.employmentTypes ?? []), kind];
      return { ...current, employmentTypes: next };
    });
  };

  const saveProfile = async () => {
    if (!form || saving) return;
    if (usingSample) {
      onToast("This is a read-only snapshot — edit your profile in the ApplyPilot app on your Mac.");
      return;
    }
    setSaving(true);
    try {
      const response = await apiFetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `API ${response.status}`);
      setForm(data.form as ProfileForm);
      onReload();
      onToast("Profile saved.");
    } catch (error) {
      onToast(`Could not save profile: ${String((error as Error).message ?? error)}`);
    } finally {
      setSaving(false);
    }
  };

  const resetProfile = async () => {
    if (usingSample || resetting || saving) return;
    const confirmed = window.confirm(
      "Reset your profile and start from scratch?\n\nThis clears your saved profile, résumé facts, discovered jobs, applications, and uploaded résumé files on this machine. Target companies and settings are kept."
    );
    if (!confirmed) return;
    setResetting(true);
    try {
      const response = await apiFetch("/api/profile/reset", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `API ${response.status}`);
      setForm(data.form as ProfileForm);
      onReload();
      onToast("Profile reset. You can set up a fresh profile now.");
    } catch (error) {
      onToast(`Could not reset profile: ${String((error as Error).message ?? error)}`);
    } finally {
      setResetting(false);
    }
  };

  // Commercial M7: clear the persistent Chromium profile (stored career-site cookies/logins) without
  // touching profile/résumé/application data. The engine stops any live browser session first.
  const wipeBrowserLogins = async () => {
    if (usingSample || wipingBrowser || resetting || saving) return;
    const confirmed = window.confirm(
      "Forget saved career-site logins?\n\nThis clears the cookies and sessions stored in ApplyPilot's built-in browser, so you'll sign in to employer sites again next time you apply. Your profile, résumé, and applications are kept."
    );
    if (!confirmed) return;
    setWipingBrowser(true);
    try {
      // The engine clears its own Playwright profile(s); it refuses (409) if a browser task is live, so
      // we never delete a profile out from under Chromium. Only if that succeeds do we also ask the shell
      // to clear the embedded review panel's partition — where the desktop app's logins actually live.
      const response = await apiFetch("/api/browser-profile/wipe", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `API ${response.status}`);
      await wipeReviewPanelLogins();
      onToast("Cleared saved career-site logins.");
    } catch (error) {
      onToast(`Could not clear logins: ${String((error as Error).message ?? error)}`);
    } finally {
      setWipingBrowser(false);
    }
  };

  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">About you</p>
          <h1>Profile</h1>
          <p>Identity, preferences, and the standard application details employers ask for. These feed document generation and form filling. Nothing is ever submitted without your review.</p>
        </div>
        <div className="apx-page-actions">
          {!usingSample ? (
            <button className="apx-btn apx-btn--ghost" type="button" onClick={wipeBrowserLogins} disabled={wipingBrowser || resetting || saving}>{wipingBrowser ? "Clearing…" : "Forget site logins"}</button>
          ) : null}
          {!usingSample ? (
            <button className="apx-btn apx-btn--ghost" type="button" onClick={resetProfile} disabled={resetting || saving}>{resetting ? "Resetting…" : "Reset profile"}</button>
          ) : null}
          <button className="apx-btn apx-btn--primary" type="button" onClick={saveProfile} disabled={!form || saving || resetting || usingSample}><Icon name="check" />{saving ? "Saving…" : "Save profile"}</button>
        </div>
      </div>

      {usingSample ? (
        <div className="apx-safenote"><Icon name="shield" /><span>Read-only snapshot — edit your profile in the ApplyPilot app on your Mac.</span></div>
      ) : null}

      {!form ? (
        <div className="apx-card"><Skeleton lines={8} /></div>
      ) : (
        <>
          <div className="apx-grid apx-grid-2">
            <section className="apx-card">
              <div className="apx-card-head"><div><p className="apx-eyebrow">Identity</p><h2 className="apx-card-title">Name &amp; contact</h2></div></div>
              <div className="apx-field-grid">
                <PField label="Legal first name" value={form.legalFirstName} onChange={(v) => update("legalFirstName", v)} />
                <PField label="Legal last name" value={form.legalLastName} onChange={(v) => update("legalLastName", v)} />
                <PField label="Preferred name" value={form.preferredName} onChange={(v) => update("preferredName", v)} optional />
                <PField label="Email" type="email" value={form.email} onChange={(v) => update("email", v)} invalid={form.email.trim() !== "" && !EMAIL_RE.test(form.email)} />
                <PField label="Phone" value={form.phone} onChange={(v) => update("phone", v)} />
                <PField label="City" value={form.city} onChange={(v) => update("city", v)} />
                <PField label="State" value={form.state} onChange={(v) => update("state", v)} />
                <PField label="ZIP" value={form.postalCode} onChange={(v) => update("postalCode", v)} optional />
                <PField label="LinkedIn" value={form.linkedin} onChange={(v) => update("linkedin", v)} optional wide />
                <PField label="Portfolio" value={form.portfolio} onChange={(v) => update("portfolio", v)} optional wide />
              </div>
            </section>

            <section className="apx-card">
              <div className="apx-card-head"><div><p className="apx-eyebrow">Work authorization</p><h2 className="apx-card-title">Eligibility</h2></div></div>
              <div className="apx-field-grid">
                <PSelect label="Authorized to work in the US" value={form.authorizedToWorkInUS} onChange={(v) => update("authorizedToWorkInUS", v as ProfileForm["authorizedToWorkInUS"])} options={YESNO_OPTS} />
                <PSelect label="Need visa sponsorship" value={form.requiresSponsorship} onChange={(v) => update("requiresSponsorship", v as ProfileForm["requiresSponsorship"])} options={YESNO_OPTS} />
                <PSelect label="Current work status" value={form.currentWorkStatus} onChange={(v) => update("currentWorkStatus", v as ProfileForm["currentWorkStatus"])} options={WORK_STATUS_OPTS} />
                <PTextarea label="Citizenship / eligibility statement" value={form.eligibilityNote} onChange={(v) => update("eligibilityNote", v)} optional placeholder="e.g. US citizen, authorized to work for any employer." />
              </div>
            </section>
          </div>

          <section className="apx-card">
            <div className="apx-card-head"><div><p className="apx-eyebrow">What you want</p><h2 className="apx-card-title">Job preferences</h2></div></div>
            <div className="apx-field-grid">
              <PField label="Target roles" value={form.targetRoles} onChange={(v) => update("targetRoles", v)} wide placeholder="comma separated" />
              <PField label="Target industries" value={form.targetIndustries} onChange={(v) => update("targetIndustries", v)} optional wide placeholder="comma separated" />
              <PField label="Desired locations" value={form.desiredLocations} onChange={(v) => update("desiredLocations", v)} optional wide placeholder="comma separated" />
              <PField label="Companies to avoid" value={form.companiesToAvoid} onChange={(v) => update("companiesToAvoid", v)} optional wide placeholder="comma separated" />
              <PField label="Years of experience" value={form.yearsOfExperience} onChange={(v) => update("yearsOfExperience", v)} optional />
              <PSelect label="Job level" value={form.jobLevel} onChange={(v) => update("jobLevel", v as ProfileForm["jobLevel"])} options={JOB_LEVEL_OPTS} />
            </div>
            <div style={{ marginTop: "var(--ap-space-4)" }}>
              <p className="apx-section-title">Work model</p>
              <div className="apx-pill-row">
                {(["remote", "hybrid", "onsite"] as const).map((mode) => (
                  <button key={mode} type="button" className={`apx-pill${form.workModes.includes(mode) ? " ok" : ""}`} aria-pressed={form.workModes.includes(mode)} onClick={() => toggleWorkMode(mode)}>{titleCase(mode)}</button>
                ))}
              </div>
            </div>
            <div style={{ marginTop: "var(--ap-space-4)" }}>
              <p className="apx-section-title">Employment type</p>
              <div className="apx-pill-row">
                {(["full_time", "part_time", "contract", "temporary", "internship"] as const).map((kind) => (
                  <button key={kind} type="button" className={`apx-pill${(form.employmentTypes ?? []).includes(kind) ? " ok" : ""}`} aria-pressed={(form.employmentTypes ?? []).includes(kind)} onClick={() => toggleEmploymentType(kind)}>{titleCase(kind.replace("_", " "))}</button>
                ))}
              </div>
            </div>
          </section>

          <div className="apx-grid apx-grid-2">
            <section className="apx-card">
              <div className="apx-card-head"><div><p className="apx-eyebrow">Money</p><h2 className="apx-card-title">Compensation</h2></div></div>
              <div className="apx-field-grid">
                <PField label="Desired base min ($)" value={form.desiredBaseMin} onChange={(v) => update("desiredBaseMin", v)} optional />
                <PField label="Desired base max ($)" value={form.desiredBaseMax} onChange={(v) => update("desiredBaseMax", v)} optional />
              </div>
              <label className="apx-check" style={{ marginTop: "var(--ap-space-3)" }}>
                <input type="checkbox" checked={form.isNegotiable} onChange={(e) => update("isNegotiable", e.target.checked)} />
                <span>Compensation is negotiable</span>
              </label>
            </section>

            <section className="apx-card">
              <div className="apx-card-head"><div><p className="apx-eyebrow">When</p><h2 className="apx-card-title">Availability</h2></div></div>
              <div className="apx-field-grid">
                <PField label="Earliest start date" value={form.earliestStartDate} onChange={(v) => update("earliestStartDate", v)} optional placeholder="e.g. 2026-08-01 or Immediate" />
                <PField label="Notice period (days)" value={form.noticePeriodDays} onChange={(v) => update("noticePeriodDays", v)} optional />
                <PSelect label="Willing to relocate" value={form.willingToRelocate} onChange={(v) => update("willingToRelocate", v as ProfileForm["willingToRelocate"])} options={YESNO_OPTS} />
              </div>
            </section>
          </div>

          <section className="apx-card">
            <div className="apx-card-head"><div><p className="apx-eyebrow">Voluntary self-identification</p><h2 className="apx-card-title">EEO &amp; demographics</h2></div></div>
            <div className="apx-safenote" style={{ marginBottom: "var(--ap-space-4)" }}>
              <Icon name="shield" />
              <span>All optional. Choose "Decline to answer" for any field. These are never auto-submitted; the app always pauses for your confirmation before a self-ID value goes on a form.</span>
            </div>
            <div className="apx-field-grid">
              <PSelect label="Gender" value={form.gender} onChange={(v) => update("gender", v)} options={GENDER_OPTS} optional />
              <PSelect label="Race / ethnicity" value={form.raceEthnicity} onChange={(v) => update("raceEthnicity", v)} options={RACE_OPTS} optional />
              <PSelect label="Veteran status" value={form.veteranStatus} onChange={(v) => update("veteranStatus", v)} options={VET_OPTS} optional />
              <PSelect label="Disability status" value={form.disability} onChange={(v) => update("disability", v)} options={DISABILITY_OPTS} optional />
            </div>
          </section>

          <section className="apx-card">
            <div className="apx-card-head"><div><p className="apx-eyebrow">Standard screening</p><h2 className="apx-card-title">Screening questions</h2></div></div>
            <div className="apx-field-grid">
              <PSelect label="18 years or older" value={form.isAtLeast18} onChange={(v) => update("isAtLeast18", v as ProfileForm["isAtLeast18"])} options={YESNO_OPTS} />
              <PSelect label="Can perform essential functions" value={form.canPerformEssentialFunctions} onChange={(v) => update("canPerformEssentialFunctions", v as ProfileForm["canPerformEssentialFunctions"])} options={YESNO_OPTS} />
              <PSelect label="Needs accommodation for process" value={form.requiresAccommodationForProcess} onChange={(v) => update("requiresAccommodationForProcess", v as ProfileForm["requiresAccommodationForProcess"])} options={YESNO_OPTS} />
            </div>
            <div style={{ marginTop: "var(--ap-space-3)" }}>
              <PTextarea label="Criminal history disclosure (voluntary, opt-in)" value={form.criminalHistoryDisclosure} onChange={(v) => update("criminalHistoryDisclosure", v)} optional placeholder="Leave blank unless you choose to disclose. Never assumed, never auto-submitted." />
            </div>
          </section>

          <section className="apx-card">
            <div className="apx-card-head"><div><p className="apx-eyebrow">On request</p><h2 className="apx-card-title">Reference contacts</h2></div></div>
            <ReferencesEditor references={form.references} onChange={(refs) => update("references", refs)} />
          </section>

          <section className="apx-card">
            <div className="apx-card-head"><div><p className="apx-eyebrow">Framing</p><h2 className="apx-card-title">Positioning</h2></div><span className="apx-metric-sub">one sentence each, steers your documents</span></div>
            <div className="apx-field-grid">
              <PField label="What do you do?" value={form.positioningWhatIDo} onChange={(v) => update("positioningWhatIDo", v)} optional wide />
              <PField label="Who do you do it for?" value={form.positioningWhoIServe} onChange={(v) => update("positioningWhoIServe", v)} optional wide />
              <PField label="What result do you produce?" value={form.positioningWhatResult} onChange={(v) => update("positioningWhatResult", v)} optional wide />
            </div>
          </section>

          <section className="apx-card">
            <div className="apx-card-head"><div><p className="apx-eyebrow">Reusable</p><h2 className="apx-card-title">Custom answers</h2></div><span className="apx-metric-sub">responses the agent reuses for common questions</span></div>
            <ChronicleCustomAnswersEditor answers={form.customAnswers ?? []} onChange={(answers) => update("customAnswers", answers)} />
          </section>

          <ProfileReadinessCard state={state} />
        </>
      )}
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YESNO_OPTS = [{ value: "", label: "Not set" }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const WORK_STATUS_OPTS = [
  { value: "", label: "Not set" },
  { value: "us_citizen", label: "US citizen" },
  { value: "permanent_resident", label: "Permanent resident" },
  { value: "visa_holder", label: "Visa holder" },
  { value: "other", label: "Other" },
];
const JOB_LEVEL_OPTS = [
  { value: "", label: "Not set" },
  ...["entry", "mid", "senior", "staff", "lead", "manager", "director", "executive"].map((v) => ({ value: v, label: titleCase(v) })),
];
const GENDER_OPTS = [
  { value: "", label: "Skip" },
  { value: "decline", label: "Decline to answer" },
  { value: "male", label: "Man" },
  { value: "female", label: "Woman" },
  { value: "non_binary", label: "Non-binary" },
];
const RACE_OPTS = [
  { value: "", label: "Skip" },
  { value: "decline", label: "Decline to answer" },
  { value: "hispanic_or_latino", label: "Hispanic or Latino" },
  { value: "white", label: "White" },
  { value: "black_or_african_american", label: "Black or African American" },
  { value: "asian", label: "Asian" },
  { value: "native_hawaiian_or_other_pacific_islander", label: "Native Hawaiian or Pacific Islander" },
  { value: "american_indian_or_alaska_native", label: "American Indian or Alaska Native" },
  { value: "two_or_more_races", label: "Two or more races" },
];
const VET_OPTS = [
  { value: "", label: "Skip" },
  { value: "decline", label: "Decline to answer" },
  { value: "protected_veteran", label: "I am a protected veteran" },
  { value: "not_protected_veteran", label: "I am not a protected veteran" },
];
const DISABILITY_OPTS = [
  { value: "", label: "Skip" },
  { value: "decline", label: "Decline to answer" },
  { value: "yes_has_disability", label: "Yes, I have a disability" },
  { value: "no_disability", label: "No, I do not" },
];

function OptionalTag() {
  return <em style={{ fontWeight: 400, fontStyle: "normal", color: "var(--ap-text-tertiary)" }}> (optional)</em>;
}
function PField({ label, value, onChange, type = "text", placeholder, optional, wide, invalid }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; optional?: boolean; wide?: boolean; invalid?: boolean }) {
  return (
    <label className={`apx-field${wide ? " is-wide" : ""}`}>
      <span>{label}{optional ? <OptionalTag /> : null}</span>
      <input className="apx-input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} style={invalid ? { borderColor: "var(--ap-danger)" } : undefined} />
    </label>
  );
}
function PSelect({ label, value, onChange, options, optional }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; optional?: boolean }) {
  return (
    <label className="apx-field">
      <span>{label}{optional ? <OptionalTag /> : null}</span>
      <select className="apx-select apx-select-wide" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
function PTextarea({ label, value, onChange, optional, placeholder, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; optional?: boolean; placeholder?: string; rows?: number }) {
  return (
    <label className="apx-field is-wide">
      <span>{label}{optional ? <OptionalTag /> : null}</span>
      <textarea className="apx-textarea" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
function ReferencesEditor({ references, onChange }: { references: ReferenceForm[]; onChange: (refs: ReferenceForm[]) => void }) {
  const set = (i: number, patch: Partial<ReferenceForm>) => onChange(references.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div className="apx-stack" style={{ gap: "var(--ap-space-3)" }}>
      {references.length === 0 ? <p className="apx-metric-sub">No references yet. Add the people employers can contact.</p> : null}
      {references.map((r, i) => (
        <div className="apx-subcard" key={i}>
          <div className="apx-spread" style={{ marginBottom: 10 }}>
            <strong style={{ fontSize: "var(--ap-text-sm)" }}>Reference {i + 1}</strong>
            <button type="button" className="apx-link-btn" onClick={() => onChange(references.filter((_, idx) => idx !== i))}>Remove</button>
          </div>
          <div className="apx-field-grid">
            <PField label="Name" value={r.name} onChange={(v) => set(i, { name: v })} />
            <PField label="Relationship" value={r.relationship} onChange={(v) => set(i, { relationship: v })} placeholder="e.g. Former manager" />
            <PField label="Company" value={r.company} onChange={(v) => set(i, { company: v })} optional />
            <PField label="Email" value={r.email} onChange={(v) => set(i, { email: v })} optional />
            <PField label="Phone" value={r.phone} onChange={(v) => set(i, { phone: v })} optional />
          </div>
        </div>
      ))}
      <div><button type="button" className="apx-btn apx-btn--secondary apx-btn--sm" onClick={() => onChange([...references, { name: "", relationship: "", company: "", email: "", phone: "" }])}><Icon name="spark" /> Add reference</button></div>
    </div>
  );
}

function ProfileTextInput({ label, value, onChange, wide }: { label: string; value: string; onChange: (value: string) => void; wide?: boolean }) {
  return (
    <label className={wide ? "is-wide" : ""}>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ProfileSelectInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: "" | "yes" | "no";
  onChange: (value: "" | "yes" | "no") => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as "" | "yes" | "no")}>
        <option value="">Not set</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
}

function ProfileJobLevelInput({
  value,
  onChange,
}: {
  value: ProfileForm["jobLevel"];
  onChange: (value: ProfileForm["jobLevel"]) => void;
}) {
  return (
    <label>
      <span>Job level</span>
      <select value={value} onChange={(event) => onChange(event.target.value as ProfileForm["jobLevel"])}>
        <option value="">Not set</option>
        <option value="entry">Entry</option>
        <option value="mid">Mid</option>
        <option value="senior">Senior</option>
        <option value="staff">Staff</option>
        <option value="lead">Lead</option>
        <option value="manager">Manager</option>
        <option value="director">Director</option>
        <option value="executive">Executive</option>
      </select>
    </label>
  );
}

function ChronicleCustomAnswersEditor({
  answers,
  onChange,
}: {
  answers: { questionText: string; answer: string }[];
  onChange: (answers: { questionText: string; answer: string }[]) => void;
}) {
  const update = (index: number, patch: Partial<{ questionText: string; answer: string }>) => {
    onChange(answers.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  return (
    <div className="chronicle-custom-answers">
      {answers.map((item, index) => (
        <article key={index}>
          <ProfileTextInput label="Question" value={item.questionText} onChange={(v) => update(index, { questionText: v })} wide />
          <ProfileTextInput label="Answer" value={item.answer} onChange={(v) => update(index, { answer: v })} wide />
          <button type="button" aria-label="Remove answer" onClick={() => onChange(answers.filter((_, i) => i !== index))}>×</button>
        </article>
      ))}
      <button type="button" onClick={() => onChange([...answers, { questionText: "", answer: "" }])}>Add reusable answer</button>
    </div>
  );
}

function ProfileReadinessCard({ state }: { state: DashboardState }) {
  const profile = state.profile;
  return (
    <section className="profile-block profile-readiness-card">
      <p>Current snapshot</p>
      <div className="profile-readiness-grid">
        <article><span>Email</span><strong>{profile.email}</strong></article>
        <article><span>Phone</span><strong>{profile.phone}</strong></article>
        <article><span>Location</span><strong>{profile.location}</strong></article>
        <article><span>Authorization</span><strong>{profile.workAuthorization}</strong></article>
        <article><span>Compensation</span><strong>{profile.compensation}</strong></article>
        <article><span>Notice</span><strong>{profile.noticePeriod}</strong></article>
      </div>
      <div className="profile-chip-row">
        {profile.targetRoles.length ? profile.targetRoles.map((value) => <span key={value}>{value}</span>) : <span>Target roles not set</span>}
      </div>
      <div className="profile-screening-list">
        {profile.screening.map((item) => (
          <article key={item.label} className={item.ok ? "is-ok" : ""}>
            <i>{item.ok ? "✓" : "!"}</i>
            <div><strong>{item.label}</strong><span>{item.value}</span></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RulesTab({
  state,
  minFit,
  onMinFit,
  scheduleEnabled,
  scheduleHour,
  onToggleSchedule,
  onHour,
  nextRun,
  onSave,
}: {
  state: DashboardState;
  minFit: number;
  onMinFit: (value: number) => void;
  scheduleEnabled: boolean;
  scheduleHour: number;
  onToggleSchedule: () => void;
  onHour: (delta: number) => void;
  nextRun: string;
  onSave: () => void;
}) {
  const mode = state.llmMode ?? "bundled";
  const llmLabels: Record<string, { title: string; badge: string; tone: BadgeTone; hint: string }> = {
    bundled: { title: "Bundled AI", badge: "Private AI", tone: "success", hint: "The built-in model runs on this machine — no setup, no account, nothing sent anywhere. Download or check it in Settings." },
    cloud: { title: "Anthropic Claude", badge: "Cloud AI", tone: "brand", hint: "AI reranking, cover-letter enhancement, and smarter matching are active via Claude." },
    local: { title: "Local server", badge: "Local AI", tone: "success", hint: "Using your own local model server (Ollama or compatible). Nothing leaves your machine." },
    builtin: { title: "Built-in engine", badge: "Rule-based", tone: "info", hint: "Full pipeline works without AI: rule-based scoring + template documents. Switch to the bundled model in Settings for AI-grade matching." },
  };
  const llm = llmLabels[mode] ?? llmLabels.bundled!;
  const [qualityMode, setQualityMode] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/settings", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<{ qualityMode?: boolean }>)
      .then((s) => { if (!cancelled) { setQualityMode(Boolean(s.qualityMode)); setSettingsLoaded(true); } })
      .catch(() => { if (!cancelled) setSettingsLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  const toggleQuality = async (next: boolean) => {
    setQualityMode(next);
    try {
      const r = await apiFetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qualityMode: next }) });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error ?? `API ${r.status}`);
      setQualityMode(Boolean(s.qualityMode));
    } catch {
      setQualityMode(!next);
    }
  };
  // Real values from the profile (these rules live in Profile; shown here read-only).
  const seniority = state.profile.jobLevel && state.profile.jobLevel !== "—" ? state.profile.jobLevel : "Any level";
  const locations = state.profile.desiredLocations.length
    ? state.profile.desiredLocations.map((l) => ({ label: l, ok: true }))
    : [{ label: "No location set", ok: true }];
  const relocationOk = !state.rules.excludeRelocation;

  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">Configuration</p>
          <h1>Automation rules</h1>
          <p>The boundaries ApplyPilot works inside. Discovery, scoring, and review-first preparation all stay within these.</p>
        </div>
        <div className="apx-page-actions">
          <span className="apx-metric-sub">Changes save as you make them.</span>
          <button className="apx-btn apx-btn--primary" type="button" onClick={onSave}><Icon name="check" /> Done</button>
        </div>
      </div>

      <div className="apx-grid apx-grid-2">
        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Safety</p><h2 className="apx-card-title">Review-first mode</h2></div><span className="apx-badge apx-badge--success has-icon"><Icon name="shield" />On</span></div>
          <div className="apx-rule-row">
            <div><strong>Prepare only, never auto-submit</strong><span>Applications are filled and parked for your review. You click submit; ApplyPilot never does it for you. This is locked on and cannot be turned off.</span></div>
            <button className="apx-switch is-on" type="button" aria-label="Review-first mode (locked on)" aria-pressed="true" disabled title="This safety setting cannot be changed" style={{ cursor: "not-allowed" }}><i /></button>
          </div>
        </section>

        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Fit requirements</p><h2 className="apx-card-title">Quality bar</h2></div></div>
          <div className="apx-rule-control">
            <div className="apx-spread"><span className="apx-rule-name">Minimum fit score</span><b className="apx-rule-val">{minFit}%</b></div>
            <input className="apx-range" type="range" min={70} max={100} value={minFit} onChange={(e) => onMinFit(Number(e.target.value))} aria-label="Minimum fit score" />
            <span className="apx-rule-hint">Roles below this stay out of your review queue.</span>
          </div>
          <div className="apx-divider" />
          <div className="apx-spread"><div><strong className="apx-rule-name">Minimum salary</strong><span className="apx-rule-hint">Used when a posting lists compensation.</span></div><b className="apx-rule-val">${state.rules.minSalaryK || 0}k</b></div>
          <div className="apx-spread" style={{ marginTop: 12 }}><div><strong className="apx-rule-name">Seniority level</strong><span className="apx-rule-hint">From your profile job level.</span></div><span className="apx-badge apx-badge--neutral">{titleCase(seniority)}</span></div>
        </section>

        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Selectivity</p><h2 className="apx-card-title">Quality mode</h2></div><span className={`apx-badge apx-badge--${qualityMode ? "success" : "neutral"}`}>{qualityMode ? "On" : "Off"}</span></div>
          <div className="apx-rule-row">
            <div><strong>Prefer a few strong matches</strong><span>When on, only high-fit roles (70 percent and up) are tailored and queued, fewer per pass. It can only raise the bar, never lower it. Persists to your config.</span></div>
            <button className={`apx-switch${qualityMode ? " is-on" : ""}`} type="button" disabled={!settingsLoaded} onClick={() => void toggleQuality(!qualityMode)} aria-label="Quality mode" aria-pressed={qualityMode}><i /></button>
          </div>
        </section>

        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Location preferences</p><h2 className="apx-card-title">Where you apply</h2></div></div>
          <div className="apx-pill-row">
            {locations.map((loc) => (
              <span key={loc.label} className={`apx-pill ${loc.ok ? "ok" : "no"}`}>{loc.ok ? "✓" : "✗"} {loc.label}</span>
            ))}
            <span className={`apx-pill ${relocationOk ? "ok" : "no"}`}>{relocationOk ? "✓" : "✗"} Relocation</span>
          </div>
          <span className="apx-rule-hint" style={{ display: "block", marginTop: 10 }}>Set your locations and relocation preference in Profile.</span>
        </section>

        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">AI intelligence</p><h2 className="apx-card-title">{llm.title}</h2></div><span className={`apx-badge apx-badge--${llm.tone}`}>{llm.badge}</span></div>
          <p className="apx-rule-hint" style={{ lineHeight: "var(--ap-leading-relaxed)" }}>{llm.hint}</p>
        </section>

        <section className="apx-card col-full apx-grid-span-2">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Scheduled automation</p><h2 className="apx-card-title">Daily run</h2></div>
            <button className={`apx-switch${scheduleEnabled ? " is-on" : ""}`} type="button" onClick={onToggleSchedule} aria-label="Toggle daily scheduled run" aria-pressed={scheduleEnabled}><i /></button>
          </div>
          <div className="apx-schedule">
            <div className="apx-hourpick">
              <button type="button" onClick={() => onHour(-1)} aria-label="Earlier">−</button>
              <strong>{scheduleTime(scheduleHour)}</strong>
              <button type="button" onClick={() => onHour(1)} aria-label="Later">+</button>
            </div>
            <div className={`apx-nextrun${scheduleEnabled ? " is-on" : ""}`}><span>Next run</span><strong>{nextRun}</strong></div>
          </div>
          <p className="apx-rule-hint">Saved on this Mac. Runs once each day at this time while ApplyPilot is open — it prepares matches for your review and never submits anything on its own.</p>
        </section>
      </div>
    </div>
  );
}

function ResumeVerifierPanel({
  state,
  usingSample,
  onToast,
  onReload,
}: {
  state: DashboardState;
  usingSample: boolean;
  onToast: (message: string) => void;
  onReload: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [resumeName, setResumeName] = useState<string | null>(null);
  // Checked = "AI parsing when available" (flag omitted; the engine's resolver decides).
  const [preferLlm, setPreferLlm] = useState(true);
  const [localResume, setLocalResume] = useState<LedgerData | null>(null);
  const [suggestedRoles, setSuggestedRoles] = useState<string[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<string[]>(() => state.profile?.targetRoles ?? []);
  const [roleFlash, setRoleFlash] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resumeLedger = localResume ?? state.resume ?? EMPTY_RESUME_LEDGER;
  const resumeFacts = resumeLedger.facts ?? [];
  const resumeTotal = resumeLedger.summary.total ?? resumeFacts.length;
  const resumeApproved = resumeLedger.summary.approved ?? resumeFacts.filter((fact) => fact.approved).length;

  // Load suggested roles (and sync selected from profile) whenever facts change.
  useEffect(() => {
    if (usingSample) return;
    let cancelled = false;
    apiFetch("/api/ledger")
      .then((r) => r.json() as Promise<{ suggestedRoles?: string[] }>)
      .then((d) => {
        if (cancelled) return;
        if (Array.isArray(d.suggestedRoles) && d.suggestedRoles.length) {
          setSuggestedRoles(d.suggestedRoles);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [usingSample, resumeTotal]);

  const toggleRole = async (role: string) => {
    if (usingSample) return;
    const next = selectedRoles.includes(role)
      ? selectedRoles.filter((r) => r !== role)
      : [...selectedRoles, role];
    setSelectedRoles(next);
    try {
      await apiFetch("/api/target-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roles: next }),
      });
      setRoleFlash(true);
      setTimeout(() => setRoleFlash(false), 1400);
      onReload();
    } catch {
      setSelectedRoles(selectedRoles); // revert on error
      onToast("Couldn't save role preference.");
    }
  };

  // Approve / un-approve a single parsed fact. Only approved facts may reach a generated document,
  // so this is the gate the user controls. POST returns the updated ledger, which we adopt locally.
  const setFactApproved = async (id: string, approved: boolean) => {
    if (usingSample) {
      onToast("ApplyPilot isn't running yet — open the app and try again.");
      return;
    }
    try {
      const response = await apiFetch("/api/ledger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setApproved: [{ id, approved }] }),
      });
      const data = await response.json() as LedgerData & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `API ${response.status}`);
      setLocalResume(data);
      onReload();
    } catch (error) {
      onToast(`Couldn't update fact: ${String((error as Error).message ?? error)}`);
    }
  };

  const approveAllFacts = async () => {
    if (usingSample) {
      onToast("ApplyPilot isn't running yet — open the app and try again.");
      return;
    }
    try {
      const response = await apiFetch("/api/ledger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approveAll: true }),
      });
      const data = await response.json() as LedgerData & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `API ${response.status}`);
      setLocalResume(data);
      onReload();
      onToast("All résumé facts approved.");
    } catch (error) {
      onToast(`Couldn't approve facts: ${String((error as Error).message ?? error)}`);
    }
  };

  const onResumeFile = async (file: File | undefined) => {
    if (!file) return;
    if (usingSample) {
      onToast("ApplyPilot isn't running yet — open the app and try again.");
      return;
    }
    setUploading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const response = await apiFetch("/api/resume/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentBase64, ...(preferLlm ? {} : { preferLlm: false }) }),
      });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error((data.error as string) ?? `API ${response.status}`);
      setResumeName(file.name);
      setLocalResume(data as unknown as LedgerData);
      // After a fresh parse, adopt all suggested roles as the starting selection.
      if (Array.isArray(data.suggestedRoles) && (data.suggestedRoles as string[]).length) {
        const roles = data.suggestedRoles as string[];
        setSuggestedRoles(roles);
        setSelectedRoles(roles);
        // Persist the pre-selection immediately so discovery uses them.
        apiFetch("/api/target-roles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roles }),
        }).catch(() => {});
      }
      const facts = Array.isArray(data.facts) ? (data.facts as unknown[]).length : 0;
      const filled = typeof data.profileFieldsFilled === "number" ? data.profileFieldsFilled : 0;
      onToast(
        filled > 0
          ? `Parsed ${facts} fact(s) and auto-filled ${filled} profile field${filled === 1 ? "" : "s"}.`
          : `Parsed ${facts} résumé fact(s). Review and approve them in Résumé.`
      );
      onReload();
    } catch (error) {
      onToast(`Résumé upload failed: ${String((error as Error).message ?? error)}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const skills = resumeFacts.filter((fact) => fact.type === "skill");
  const nonSkillSections = resumeSections(resumeFacts.filter((fact) => fact.type !== "skill"));
  return (
    <aside className="resume-verifier-panel" aria-label="Résumé verification">
          <article className="rule-block resume-upload-block">
            <div className="resume-verifier-topline">
              <p>Résumé source</p>
              <span>{resumeApproved}/{resumeTotal} approved</span>
            </div>
            <div className="resume-upload-head">
              <div>
                <strong>Upload or replace résumé</strong>
                <span>Parses facts into the local ledger and refreshes matching signals.</span>
              </div>
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                <Icon name="upload" />
                {uploading ? "Uploading…" : "Choose file"}
              </button>
            </div>
            <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.md" hidden onChange={(event) => void onResumeFile(event.target.files?.[0])} />
            <label className="resume-llm-toggle">
              <input type="checkbox" checked={preferLlm} onChange={(event) => setPreferLlm(event.target.checked)} />
              <span>Use AI parser when configured</span>
            </label>
            <div className="resume-upload-meta">
              <span>{resumeName ? `Last upload: ${resumeName}` : "PDF, DOCX, TXT, or MD"}</span>
              <span>Approved facts stay local and gate generated documents.</span>
            </div>
          </article>
          {suggestedRoles.length > 0 && (
            <article className={`rule-block resume-roles-block${roleFlash ? " role-saved" : ""}`}>
              <p>Preferences: Target roles</p>
              <span className="resume-roles-hint">Select the roles you want to apply for. Discovery will focus on these.</span>
              <div className="role-chips">
                {suggestedRoles.map((role) => (
                  <button
                    key={role}
                    type="button"
                    className={`role-chip${selectedRoles.includes(role) ? " is-selected" : ""}`}
                    onClick={() => void toggleRole(role)}
                  >
                    {role}
                  </button>
                ))}
              </div>
            </article>
          )}
          <article className="resume-reader-block">
            <header>
              <div>
                <p>Reader verification</p>
                <h2>Parsed résumé details</h2>
              </div>
              <b>{resumeApproved}/{resumeTotal}</b>
            </header>
            {resumeFacts.length === 0 ? (
              <div className="resume-reader-empty">
                <Icon name="file" />
                <strong>No résumé facts yet</strong>
                <span>Upload a résumé and the extracted details appear here for review.</span>
              </div>
            ) : (
              <>
                <div className="resume-reader-actions">
                  <span>Tap any item to approve it. Only approved facts can appear in a generated document.</span>
                  <button type="button" onClick={() => void approveAllFacts()} disabled={resumeApproved === resumeTotal}>
                    {resumeApproved === resumeTotal ? "All approved" : "Approve all"}
                  </button>
                </div>
                <div className="resume-reader-sections">
                  {skills.length ? <ResumeSkillsSection facts={skills} onToggle={setFactApproved} /> : null}
                  {nonSkillSections.map((section) => (
                    <section key={section.key} className="resume-reader-section">
                      <div className="resume-reader-section-head">
                        <strong>{section.label}</strong>
                        <span>{section.facts.filter((fact) => fact.approved).length}/{section.facts.length} approved</span>
                      </div>
                      <div className="resume-reader-list">
                        {section.facts.map((fact) => (
                          <ResumeFactCard key={fact.id} fact={fact} onToggle={setFactApproved} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </>
            )}
          </article>
    </aside>
  );
}

function ResumeSkillsSection({ facts, onToggle }: { facts: LedgerFact[]; onToggle: (id: string, approved: boolean) => void }) {
  const byLabel = new Map<string, { fact: LedgerFact; label: string }>();
  for (const fact of facts) {
    const label = cleanSkillLabel(factStatement(fact));
    if (!keepSkillLabel(label)) continue;
    if (!byLabel.has(label.toLowerCase())) byLabel.set(label.toLowerCase(), { fact, label });
  }
  const skills = [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
  const groups = ["Compliance & investigations", "Research & intelligence", "Regulatory frameworks", "Data & tools", "Languages", "Other"]
    .map((category) => ({ category, skills: skills.filter((skill) => skillCategory(skill.label) === category) }))
    .filter((group) => group.skills.length > 0);
  return (
    <section className="resume-reader-section resume-skills-section">
      <div className="resume-reader-section-head">
        <strong>Skills</strong>
        <span>{facts.filter((fact) => fact.approved).length}/{facts.length} approved · {skills.length} shown</span>
      </div>
      <div className="resume-skill-groups">
        {groups.map((group) => (
          <article key={group.category}>
            <strong>{group.category}</strong>
            <div className="resume-skill-cloud">
              {group.skills.map(({ fact, label }) => (
                <button
                  type="button"
                  key={fact.id}
                  className={fact.approved ? "is-approved" : ""}
                  title={`${fact.approved ? "Approved" : "Tap to approve"} — ${fact.sourceText || label}`}
                  aria-pressed={fact.approved}
                  onClick={() => onToggle(fact.id, !fact.approved)}
                >
                  {fact.approved ? "✓ " : ""}{label}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ResumeFactCard({ fact, onToggle }: { fact: LedgerFact; onToggle: (id: string, approved: boolean) => void }) {
  const entries = factDetailEntries(fact);
  const isEmployment = fact.type === "employment";
  const title = isEmployment ? (factField(fact, "title") || "Role") : factStatement(fact);
  const employer = isEmployment ? factField(fact, "employer") : "";
  const dates = isEmployment ? [factField(fact, "startDate"), factField(fact, "endDate")].filter(Boolean).join(" – ") : "";
  return (
    <article className={`resume-fact-card${fact.approved ? " is-approved" : ""}`}>
      <div className="resume-fact-card-head">
        <span>{titleCase(fact.type)}</span>
        <button
          type="button"
          className={`fact-approve${fact.approved ? " is-approved" : ""}`}
          aria-pressed={fact.approved}
          onClick={() => onToggle(fact.id, !fact.approved)}
        >
          {fact.approved ? "✓ Approved" : "Approve"}
        </button>
      </div>
      <h3>{title}</h3>
      {isEmployment ? (
        (employer || dates) ? (
          <p className="fact-employer">
            {employer ? <span className="fact-employer-name">{employer}</span> : null}
            {dates ? <span className="fact-dates">{dates}</span> : null}
          </p>
        ) : null
      ) : null}
      {entries.length ? (
        <dl className={isEmployment ? "is-compact" : ""}>
          {entries.map((entry) => (
            <div key={entry.label}>
              <dt>{entry.label}</dt>
              <dd>
                {entry.lines.map((line, index) => (
                  <span key={`${entry.label}-${index}`}>{line}</span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {fact.sourceText ? (
        <details className="resume-source-details">
          <summary>Source text</summary>
          <blockquote>{fact.sourceText}</blockquote>
        </details>
      ) : null}
    </article>
  );
}

function Sparkline() {
  return (
    <svg viewBox="0 0 120 34" aria-hidden="true" className="hero-sparkline">
      <polyline points="0,24 20,18 40,21 60,12 80,3 100,8 120,13" fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="80" cy="3" r="3.5" fill="#fff" />
    </svg>
  );
}

function WeeklyChart({ path, data }: { path: ReturnType<typeof buildPath>; data: number[] }) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <svg viewBox={`0 0 ${path.width} ${path.height + 28}`} className="weekly-chart" aria-label="Weekly application activity">
      <defs><linearGradient id="chronicle-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff6f61" stopOpacity=".18" /><stop offset="100%" stopColor="#ff6f61" stopOpacity="0" /></linearGradient></defs>
      {[0.25, 0.5, 0.75].map((t, index) => <line key={index} x1="12" y1={(path.height - 8 - t * (path.height - 16)).toFixed(1)} x2={path.width - 12} y2={(path.height - 8 - t * (path.height - 16)).toFixed(1)} />)}
      <path d={path.area} fill="url(#chronicle-chart-fill)" />
      <path d={path.line} className="weekly-line" />
      {path.points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="5" />)}
      {path.points.map((point, index) => <text key={days[index]} x={point.x} y={path.height + 22}>{days[index]}</text>)}
      {data.some(Boolean) ? <text className="chart-peak" x={path.points[data.indexOf(Math.max(...data))]?.x ?? 20} y={(path.points[data.indexOf(Math.max(...data))]?.y ?? 20) - 13}>{Math.max(...data)}</text> : null}
    </svg>
  );
}

function FactorBars({ job }: { job: ChronicleJob | null }) {
  const rows = [
    ["Skills", job?.factors.skills ?? 0],
    ["Salary", job?.factors.salary ?? 0],
    ["Location", job?.factors.location ?? 0],
    ["Seniority", job?.factors.seniority ?? 0],
    ["Culture", job?.factors.culture ?? 0],
  ] as const;
  return <div className="factor-bars">{rows.map(([label, value], index) => <article key={label}><span>{label}</span><em><i style={{ width: `${value}%`, background: FACTOR_COLORS[index] }} /></em><b>{value}%</b></article>)}</div>;
}

function AppliedMiniRow({ job, onSelect }: { job: ChronicleJob; onSelect: (job: ChronicleJob) => void }) {
  return (
    <article onClick={() => onSelect(job)}>
      <i style={avatarStyle(job.company)}><span>{initials(job.company)}</span></i>
      <div><strong>{job.company}</strong><span>{job.role}</span></div>
      <b className={`status-pill ${job.status}`}>{statusLabel(job.status)}</b>
    </article>
  );
}

function AppliedFullRow({ job, onSelect }: { job: ChronicleJob; onSelect: (job: ChronicleJob) => void }) {
  const badge = appliedStatusBadge(job.blockReason, job.status);
  const note = humanizeAppliedNote(job.time);
  return (
    <button type="button" className="apx-app-row" onClick={() => onSelect(job)}>
      <span className="apx-avatar sm" style={avatarStyle(job.company)}>{initials(job.company)}</span>
      <div className="apx-app-main">
        <div className="apx-app-line">
          <strong>{job.company}</strong>
          <span className={`apx-tag ${job.mode}`}>{job.mode === "auto" ? "Auto" : "1-click"}</span>
        </div>
        <span className="apx-app-role">{cleanRoleTitle(job.role)}</span>
        <span className="apx-app-meta">{[job.salary, job.location].filter(Boolean).join(" · ")}{note ? ` · ${note}` : ""}</span>
      </div>
      <span className={`apx-badge apx-badge--${badge.tone}`}>{badge.label}</span>
    </button>
  );
}

const DRAFT_STATUS_OPTIONS: ApplicationDraftStatus[] = ["saved", "applied", "interviewing", "rejected", "offer"];

function ApplicationDraftRow({
  draft,
  busy,
  onStatus,
}: {
  draft: ApplicationDraft;
  busy: boolean;
  onStatus: (id: string, status: ApplicationDraftStatus) => void;
}) {
  const company = draft.company || "Application draft";
  const title = draft.title || "Untitled role";
  const draftTone: BadgeTone = draft.status === "offer" ? "success" : draft.status === "interviewing" ? "info" : draft.status === "rejected" ? "danger" : draft.status === "applied" ? "success" : "neutral";
  return (
    <div className="apx-app-row is-draft">
      <span className="apx-avatar sm" style={avatarStyle(company)}>{initials(company)}</span>
      <div className="apx-app-main">
        <div className="apx-app-line">
          <strong>{company}</strong>
          <span className="apx-tag draft">Draft</span>
        </div>
        <span className="apx-app-role">{cleanRoleTitle(title)}</span>
        <span className="apx-app-meta">{draft.applicationAnswers.length} answer{draft.applicationAnswers.length === 1 ? "" : "s"} · updated {formatTime(draft.updatedAt)}</span>
      </div>
      <div className="apx-app-actions">
        <span className={`apx-badge apx-badge--${draftTone}`}>{draftStatusLabel(draft.status)}</span>
        <select
          className="apx-select"
          value={draft.status}
          disabled={busy}
          aria-label={`Set status for ${company}`}
          onChange={(event) => onStatus(draft.id, event.target.value as ApplicationDraftStatus)}
        >
          {DRAFT_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>{draftStatusLabel(status)}</option>
          ))}
        </select>
        {draft.applyUrl ? <a className="apx-link-btn" href={draft.applyUrl} target="_blank" rel="noreferrer">Apply link</a> : null}
      </div>
    </div>
  );
}

function draftStatusLabel(status: ApplicationDraftStatus): string {
  if (status === "saved") return "Saved";
  if (status === "applied") return "Applied";
  if (status === "interviewing") return "Interviewing";
  if (status === "rejected") return "Rejected";
  return "Offer";
}

function statusLabel(status: JobStatus): string {
  if (status === "submitted") return "Submitted";
  if (status === "interview") return "Interview";
  if (status === "rejected") return "Rejected";
  if (status === "skipped") return "Skipped";
  return "Queued";
}

function topCompanies(state: DashboardState, jobs: ChronicleJob[]) {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.company, (counts.get(job.company) ?? 0) + 1);
  for (const source of state.coverage.sources) counts.set(source.name, Math.max(counts.get(source.name) ?? 0, source.found));
  const rows = [...counts.entries()].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = Math.max(1, ...rows.map(([, count]) => count));
  return rows.map(([name, count]) => ({ name, count, width: Math.max(12, Math.round((count / max) * 100)) }));
}

function salaryBuckets(jobs: ChronicleJob[], floorK: number) {
  const floor = floorK || 140;
  const buckets = [
    { label: `$${floor - 20}-${floor}k`, min: (floor - 20) * 1000, max: floor * 1000 },
    { label: `$${floor}-${floor + 20}k`, min: floor * 1000, max: (floor + 20) * 1000 },
    { label: `$${floor + 20}-${floor + 40}k`, min: (floor + 20) * 1000, max: (floor + 40) * 1000 },
    { label: `$${floor + 40}k+`, min: (floor + 40) * 1000, max: Infinity },
  ];
  const counts = buckets.map((bucket) => ({
    label: bucket.label,
    count: jobs.filter((job) => job.salaryMin && job.salaryMin >= bucket.min && job.salaryMin < bucket.max).length,
  }));
  const max = Math.max(1, ...counts.map((bucket) => bucket.count));
  return counts.map((bucket) => ({ ...bucket, width: bucket.count ? Math.max(10, Math.round((bucket.count / max) * 100)) : 0 }));
}

function TierPicker({ job, onSetTier }: { job: ChronicleJob; onSetTier: (job: ChronicleJob, tier: "A" | "B" | "C" | null) => void }) {
  const active = job.tier;
  const labels: Record<"A" | "B" | "C", string> = {
    A: "A · Dream — fully tailored + find a contact",
    B: "B · Strong fit — tailored résumé",
    C: "C · Backup — light touch, no cover letter",
  };
  return (
    <div className="detail-tier" aria-label="Strategy tier">
      <p className="cell-label">
        Strategy tier{!active && job.suggestedTier ? <em> · suggested {job.suggestedTier}</em> : null}
      </p>
      <div className="detail-tier-row">
        {(["A", "B", "C"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`tier-chip tier-${t}${active === t ? " is-on" : ""}`}
            aria-pressed={active === t}
            title={labels[t]}
            onClick={() => onSetTier(job, active === t ? null : t)}
          >
            {t}
          </button>
        ))}
      </div>
      <span className="detail-tier-hint">{active ? labels[active] : "Tier your dream roles (keep Tier A to 8 or fewer)."}</span>
      {active === "A" ? (
        <div className="tier-a-nudge"><Icon name="shield" /><span>Tier A: find a contact inside before you apply, and it’s held for your manual review — never auto-submitted.</span></div>
      ) : null}
    </div>
  );
}

function DetailDrawer({ job, applied, applying, onClose, onApply, onSetTier }: { job: ChronicleJob | null; applied: boolean; applying: boolean; onClose: () => void; onApply: (job: ChronicleJob) => void; onSetTier: (job: ChronicleJob, tier: "A" | "B" | "C" | null) => void }) {
  const open = Boolean(job);
  return (
    <aside className={`chronicle-detail${open ? " is-open" : ""}`} aria-hidden={!open} role="dialog" aria-label="Job detail">
      <div className="chronicle-detail-scrim" onClick={onClose} />
      <section className="chronicle-detail-panel">
        <header><div><p className="cell-label">Application packet</p><h2>{job?.company}</h2><span>{job?.role}</span></div><button type="button" onClick={onClose} aria-label="Close"><Icon name="arrow-right" /></button></header>
        {job ? (
          <>
            <div className="detail-stats"><article><strong>{job.score}</strong><span>Fit</span></article><article><strong>{job.salary}</strong><span>Salary</span></article><article><strong>{job.ats}</strong><span>ATS</span></article></div>
            <p className="detail-desc">{job.description}</p>
            <TierPicker job={job} onSetTier={onSetTier} />
            {job.fit ? <FitPanel fit={job.fit} /> : null}
            <FactorBars job={job} />
            <div className="detail-tags">{job.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            {job.mode === "oneclick" ? <div className="needs-input"><span>Needs your input</span><strong>{job.blockReason}</strong></div> : null}
            {job.jobUrl ? <a className="detail-link" href={job.jobUrl} target="_blank" rel="noreferrer">Open apply link</a> : null}
            {job.capabilityReason ? <p className="detail-capability">{job.capabilityReason}</p> : null}
            <button className={`detail-apply${applied ? " is-applied" : ""}`} type="button" title={job.capabilityReason || undefined} onClick={() => onApply(job)} disabled={applied || applying || !job.jobUrl || applyAction(job).kind === "none"}>
              {applied ? "✓ Applied" : applying ? applyAction(job).busyLabel : applyAction(job).label}
            </button>
          </>
        ) : null}
      </section>
    </aside>
  );
}

function BatchModal({ open, jobs, selectedIds, onToggle, onClose, onApply }: { open: boolean; jobs: ChronicleJob[]; selectedIds: string[]; onToggle: (id: string) => void; onClose: () => void; onApply: () => void }) {
  return (
    <div className={`chronicle-batch${open ? " is-open" : ""}`} aria-hidden={!open} role="dialog" aria-label="Batch apply">
      <div className="chronicle-batch-scrim" onClick={onClose} />
      <section className="chronicle-batch-panel">
        <header><div><p className="cell-label">Batch apply</p><h2>Review {selectedIds.length} selected</h2></div><button type="button" onClick={onClose} aria-label="Close"><Icon name="stop" /></button></header>
        <div className="batch-grid">
          {jobs.map((job) => {
            const checked = selectedIds.includes(job.id);
            const supported = job.applyCapability === "supported_form_fill";
            return <article key={job.id} className={checked ? "is-selected" : ""} onClick={() => onToggle(job.id)}><i>{checked ? "✓" : ""}</i><div><strong>{job.company}</strong><span>{job.role}</span><p>{supported ? job.blockReason : job.capabilityReason || "Manual apply only — use Open manually."}</p></div><b>{job.score}</b></article>;
          })}
        </div>
        <footer><button type="button" onClick={onApply} disabled={selectedIds.length === 0}>Prefill {selectedIds.length} selected</button><button type="button" onClick={onClose}>Cancel</button></footer>
      </section>
    </div>
  );
}

/** Where the embedded review panel first appears (before the workspace mounts and takes over):
 *  the right-hand share of the window, roughly matching the workspace's stage area. */
function provisionalPanelBounds(): ReviewPanelBounds {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = Math.round(Math.max(360, w * 0.4));
  return { x, y: 72, width: Math.max(320, w - x - 16), height: Math.max(240, h - 88) };
}

// The in-app review workspace. The REAL employer application page is visible the whole time — in
// the embedded panel (desktop app) or a separate browser window — and ApplyPilot fills it where you
// can watch. This rail shows what was filled and what still needs you. The final click is YOURS, on
// the employer's page; ApplyPilot never clicks submit. When you've submitted, record it here.
function ApplyReviewWorkspace({
  session,
  submitting,
  refreshing,
  onAnswer,
  onRefresh,
  onMarkSubmitted,
  onCancel,
}: {
  session: { job: ChronicleJob; sessionId: string; gate: ApplyGate; display: "embedded" | "window" } | null;
  submitting: boolean;
  refreshing: boolean;
  onAnswer: (ref: string, value: string | string[]) => void;
  onRefresh: () => void;
  onMarkSubmitted: () => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const sessionId = session?.sessionId;
  const embedded = session?.display === "embedded";
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setDrafts({});
  }, [sessionId]);
  // Keep the shell's browser view glued to the stage rectangle across mount, resize, and layout
  // shifts. The view floats above the window, so this reserved rectangle IS the visible page.
  useEffect(() => {
    if (!embedded || !sessionId) return undefined;
    const el = stageRef.current;
    if (!el) return undefined;
    const sync = () => syncReviewPanelBounds(el);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [embedded, sessionId]);
  if (!session) return null;
  const gate = session.gate;
  const pageWord = embedded ? "panel" : "browser window";
  const needsBrowser = needsBrowserStep(gate);

  // Portal to <body>: the app shell has transformed/filtered ancestors that would otherwise become
  // the containing block for this position:fixed overlay (same reason Modal.tsx / Drawer.tsx portal),
  // clipping the rail behind the sidebar. Rendering at <body> makes it a true full-viewport overlay,
  // and stageRef's getBoundingClientRect then gives correct window coords for the embedded browser view.
  return createPortal(
    <div className="apply-review is-open apply-workspace" role="dialog" aria-label="Review the application on the employer page">
      <div className="apply-review-scrim" onClick={submitting ? undefined : onCancel} />
      <div className="apply-workspace-grid">
      <section className="apply-review-panel apply-workspace-rail">
        <header>
          <div>
            <p className="cell-label">Review on the employer page · {gate.ats}</p>
            <h2>{session.job.company} · {session.job.role}</h2>
          </div>
          <button type="button" onClick={onCancel} disabled={submitting} aria-label="Close"><Icon name="stop" /></button>
        </header>
        <p className="apply-review-sub">
          {embedded
            ? "The employer's real application page is open in the panel — ApplyPilot filled what it safely could while you watched. Finish anything below or directly on the page, then click the employer's Submit button yourself."
            : "The employer's real application page is open in a separate browser window — ApplyPilot filled what it safely could there. Finish anything below or directly on the page, then click the employer's Submit button yourself."}
        </p>

        {gate.challengeDetected && <div className="apply-flag warn">This site shows a human-verification challenge. Solve it in the {pageWord}, then click Check again.</div>}
        {gate.accountAction && <div className="apply-flag warn">This site needs a {gate.accountAction.kind} at {gate.accountAction.domain}. Handle it in the {pageWord}, then click Check again.</div>}
        {needsBrowser ? (
          <div className="apply-human-step">
            <strong>Over to you</strong>
            <span>Use the {pageWord} like you normally would. ApplyPilot will only continue after you tell it to re-check.</span>
            <button type="button" onClick={onRefresh} disabled={refreshing || submitting}>{refreshing ? "Checking…" : "Check again"}</button>
          </div>
        ) : null}

        {gate.needsConfirmation.length > 0 && (
          <div className="apply-section">
            <h3>Needs your input <span className="apply-count">{gate.needsConfirmation.length}</span></h3>
            {gate.needsConfirmation.map((f) => (
              <div key={f.ref} className="apply-field">
                <label>{f.label}{f.required ? <em> *</em> : null}</label>
                {f.rationale ? <p className="apply-field-hint">{f.rationale}</p> : null}
                <div className="apply-field-row">
                  {f.options.length > 0 ? (
                    <select value={drafts[f.ref] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [f.ref]: e.target.value }))}>
                      <option value="" disabled>Choose…</option>
                      {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={drafts[f.ref] ?? ""} placeholder="Your answer" onChange={(e) => setDrafts((d) => ({ ...d, [f.ref]: e.target.value }))} />
                  )}
                  <button type="button" disabled={!(drafts[f.ref] ?? "").trim()} onClick={() => onAnswer(f.ref, (drafts[f.ref] ?? "").trim())}>Save</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {gate.flagged.length > 0 && (
          <div className="apply-section">
            <h3>Filled — please double-check <span className="apply-count">{gate.flagged.length}</span></h3>
            {gate.flagged.map((m, i) => (
              <div key={i} className="apply-readrow"><span>{m.label}</span><b>{fmtApplyValue(m.value)}</b>{m.rationale ? <small>{m.rationale}</small> : null}</div>
            ))}
          </div>
        )}

        {gate.filled.length > 0 && (
          <details className="apply-section apply-filled">
            <summary>Filled for you ({gate.filled.length})</summary>
            {gate.filled.map((m, i) => <div key={i} className="apply-readrow"><span>{m.label}</span><b>{fmtApplyValue(m.value)}</b></div>)}
          </details>
        )}

        <div className="apply-meta">
          <span>{gate.documents.map((d) => `${d.attached ? "📎" : "✗"} ${d.kind.replace(/_/g, " ")}`).join("   ") || "no documents"}</span>
          {gate.ledger ? <span className={gate.ledger.passed ? "ok" : "bad"}>Truth check {gate.ledger.passed ? "passed" : "FAILED"}</span> : null}
        </div>

        <footer>
          <span className="apply-ready-note">{reviewReadyNote(gate, pageWord)}</span>
          <div className="apply-actions">
            <button type="button" className="button secondary" onClick={onRefresh} disabled={refreshing || submitting}>{refreshing ? "Checking…" : "Check again"}</button>
            <button type="button" className="button secondary" onClick={onCancel} disabled={submitting}>Cancel</button>
            <button type="button" className="button primary" onClick={onMarkSubmitted} disabled={submitting}>{submitting ? "Recording…" : "I submitted it"}</button>
          </div>
        </footer>
      </section>
      <section className="apply-workspace-stage">
        {embedded ? (
          <div ref={stageRef} className="apply-panel-host" aria-label="Employer application page" />
        ) : (
          <div className="apply-panel-fallback">
            <h3>The employer page is open in a separate browser window</h3>
            <p>
              Review the real form there — ApplyPilot filled what it safely could. Handle any login or
              verification, complete the remaining fields, and click the employer's Submit button
              yourself. Then come back and press “I submitted it”.
            </p>
          </div>
        )}
      </section>
      </div>
    </div>,
    document.body
  );
}

// Persistent, unmissable "automation is running" bar shown under the nav whenever the REAL engine
// is working (ui.taskActive / ui.discovering / the live runner). Replaces the old fake staged modal
// that auto-dismissed after a few seconds and misled the user into thinking the run had finished.
function RunningBanner({ ui, runner, pending, progress }: { ui: ChronicleUi; runner: DashboardState["runner"]; pending: number; progress: DashboardState["automationProgress"] }) {
  const running = ui.taskActive || ui.discovering || Boolean(runner?.running);
  if (!running) return null;
  const current = runner?.currentJob;
  const phase = runner?.phase ? titleCase(runner.phase) : ui.discovering ? "Scanning" : ui.applying ? titleCase(progress.status.replace("_", " ")) : "Working";
  const message = current
    ? `Reviewing ${current.title} · ${current.company}`
    : runner?.message || (ui.discovering ? "Reading employer career pages and scoring matches…" : progress.currentStepLabel || "Automation engine is working — this can take a minute.");
  return (
    <div className="chronicle-running" role="status" aria-live="polite">
      <div className="chronicle-running-main">
        <span className="chronicle-running-pulse" aria-hidden="true"><i /><i /><i /></span>
        <div className="chronicle-running-copy">
          <strong>Automation running · {phase}</strong>
          <span>{message}</span>
        </div>
        <div className="chronicle-running-stats">
          {typeof runner?.submitted === "number" && runner.submitted > 0 ? <span><b>{runner.submitted}</b> prepared</span> : null}
          <span><b>{pending}</b> ready to review</span>
          {ui.applying ? <span><b>{Math.round(progress.percentComplete || 0)}%</b> done</span> : null}
        </div>
        <button type="button" className="chronicle-running-stop" onClick={ui.stopAll} disabled={ui.stopping}>
          <Icon name="stop" />{ui.stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
      <div className="chronicle-running-track" aria-hidden="true"><i /></div>
    </div>
  );
}

// Click a row in "Top matched companies" to open this — an employer-level detail view with the
// match analysis (strongest role's factor breakdown) and every scored role from that employer.
function CompanyDrawer({ company, jobs, applied, onClose, onSelectJob }: { company: string | null; jobs: ChronicleJob[]; applied: string[]; onClose: () => void; onSelectJob: (job: ChronicleJob) => void }) {
  const open = Boolean(company);
  const sorted = [...jobs].sort((a, b) => b.score - a.score);
  const top = sorted[0] ?? null;
  const avgScore = sorted.length ? Math.round(sorted.reduce((sum, job) => sum + job.score, 0) / sorted.length) : 0;
  const salaries = sorted.map((job) => job.salaryMin).filter((value): value is number => typeof value === "number" && value > 0);
  const salaryRange = salaries.length
    ? (Math.min(...salaries) === Math.max(...salaries) ? formatSalary(salaries[0]) : `${formatSalary(Math.min(...salaries))}–${formatSalary(Math.max(...salaries))}`)
    : "Not listed";
  return (
    <aside className={`chronicle-detail company-detail${open ? " is-open" : ""}`} aria-hidden={!open} role="dialog" aria-label="Company detail">
      <div className="chronicle-detail-scrim" onClick={onClose} />
      <section className="chronicle-detail-panel">
        <header>
          <div><p className="cell-label">Employer match</p><h2>{company}</h2><span>{sorted.length} scored role{sorted.length === 1 ? "" : "s"} from this employer</span></div>
          <button type="button" onClick={onClose} aria-label="Close"><Icon name="arrow-right" /></button>
        </header>
        {company ? (
          <>
            <div className="detail-stats">
              <article><strong>{avgScore || (top?.score ?? 0)}</strong><span>Avg fit</span></article>
              <article><strong>{sorted.length}</strong><span>Roles</span></article>
              <article><strong>{salaryRange}</strong><span>Salary</span></article>
            </div>
            {top ? (
              <>
                <p className="company-detail-label">Match analysis · strongest role</p>
                <div className="company-detail-toprole"><div><strong>{top.role}</strong><span>{top.location || "Location not listed"}</span></div><b>{top.score}</b></div>
                <FactorBars job={top} />
              </>
            ) : null}
            <p className="company-detail-label">Roles at {company}</p>
            <div className="company-role-list">
              {sorted.length ? sorted.map((job) => (
                <article key={job.id} className={applied.includes(job.id) ? "is-applied" : ""} onClick={() => onSelectJob(job)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onSelectJob(job); }}>
                  <div><strong>{job.role}</strong><span>{job.salary} · {job.ats}</span></div>
                  <b>{job.score}</b>
                  <Icon name="arrow-right" />
                </article>
              )) : <p className="empty-copy">No individually scored roles yet — this employer is on your discovery coverage list. Run automation to pull open roles.</p>}
            </div>
            <p className="company-detail-foot">Discovery reads supported career pages, ATS boards, and job-search sources.</p>
          </>
        ) : null}
      </section>
    </aside>
  );
}

function ChronicleFooter({ state }: { state: DashboardState }) {
  return (
    <footer className="chronicle-footer">
      <article><strong>{state.progress.sent}</strong><span>sent this week</span></article>
      <article><strong>{state.progress.replyRatePct}%</strong><span>reply rate</span></article>
      <article><strong>{state.progress.interviews}</strong><span>interviews</span></article>
      <article><strong>{state.progress.timeSavedH}h</strong><span>time saved</span></article>
    </footer>
  );
}
