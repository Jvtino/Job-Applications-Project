import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./components/Icon";
import { Button, Drawer, StatCard, StatusPill, statusMeta, EmptyState, relativeTime } from "./components/ui";
import { Logo } from "./components/Logo";
import { ChronicleDashboard, type ChronicleTab, type ChronicleUi } from "./ChronicleDashboard";
import { AppShell, type ShellView } from "./components/shell/AppShell";
import { EMPTY_FORM, useApplications, useDashboardData, useDiscoveredJobs, type ApplicationDetail, type BulletWarning, type DashboardState, type DiscoveredJobRow, type GenerateDocSummary, type GenerateResult, type LedgerData, type LedgerFact, type ProfileForm, type ResumeImportPreview, type SkillGapReport, type TargetCompany } from "./data";
import { API_AUTH_REQUIRED_EVENT, apiFetch, apiJson, clearStoredApiToken, downloadApiFile, getStoredApiToken, setStoredApiToken, type ApiDownload } from "./api";
import { LiveUnavailableState } from "./components/LiveUnavailableState";
import { HelpDiagnosticsView } from "./components/HelpDiagnosticsView";
import { LoginsView } from "./components/LoginsView";
import { buildSettingsPayload } from "./lib/settings-payload";
import { EDITABLE_FACT_TYPES } from "./lib/resume-facts";

type View = "landing" | "welcome" | "matches" | "automation" | "oneclick" | "applied" | "blocked" | "rules" | "profile" | "resume" | "targets" | "generate" | "insights" | "logins" | "settings" | "help";
type Theme = "light" | "dark";

/** The saved theme, else the OS preference, else light. */
function readTheme(): Theme {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem("applypilot-theme") : null;
  if (saved === "light" || saved === "dark") return saved;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Apply the theme to <html> at module load — before React's first paint — so a saved dark theme
// doesn't flash the default light UI for a frame (FOUC). useTheme keeps it in sync after that.
if (typeof document !== "undefined") document.documentElement.setAttribute("data-theme", readTheme());

/** Light/dark theme with persistence + system default. Sets data-theme on <html> for theme.css. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("applypilot-theme", theme); } catch { /* storage blocked */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const toLight = theme === "dark";
  return (
    <button className="theme-toggle" type="button" onClick={onToggle} title="Toggle light / dark" aria-label={`Switch to ${toLight ? "light" : "dark"} mode`}>
      {toLight ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.4M12 19.1v2.4M4.4 4.4l1.7 1.7M17.9 17.9l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.4 19.6l1.7-1.7M17.9 6.1l1.7-1.7" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 13.4A8.3 8.3 0 1 1 10.6 3.5a6.5 6.5 0 0 0 9.9 9.9z" /></svg>
      )}
    </button>
  );
}


function readMinFit(fallback = 70): number {
  try {
    const v = localStorage.getItem("applypilot.minFit");
    if (v) {
      const n = Number(v);
      if (n >= 70 && n <= 100) return n;
    }
  } catch { /* storage blocked */ }
  return fallback;
}
function formatClockHour(hour: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:00 ${suffix}`;
}

/** A live wall clock for the shell topbar (updates each minute). */
function useClock(): string {
  const fmt = () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const [now, setNow] = useState(fmt);
  useEffect(() => {
    const id = window.setInterval(() => setNow(fmt()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useIsMobile(breakpoint = 640): boolean {
  const query = `(max-width: ${breakpoint}px)`;
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return isMobile;
}

export function App() {
  const { state, configured, loading, error, authRequired, usingSample, reload: reloadDashboard } = useDashboardData();

  const [view, setView] = useState<View>("landing");
  const [minFit, setMinFit] = useState(() => readMinFit());
  const [jobsRefresh, setJobsRefresh] = useState(0);
  const [theme, toggleTheme] = useTheme();
  const [authLocked, setAuthLocked] = useState(authRequired);
  const [profileRefreshKey, setProfileRefreshKey] = useState(0);
  const [resumePreview, setResumePreview] = useState<ResumeImportPreview | null>(null);
  // Daily-run schedule. Persisted server-side and fired by the engine (commercial M9-C); lifted here
  // so the shell topbar label and the Rules controls share one source of truth. `nextRunAt` is the
  // engine-computed next-run (ISO) — the truthful value, not a client guess. Default OFF until the
  // engine reports the persisted setting on mount (an unattended trigger is opt-in).
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleHour, setScheduleHour] = useState(7);
  const [scheduleNextRunAt, setScheduleNextRunAt] = useState<string | null>(null);
  // The real review-queue count is derived inside ChronicleDashboard (strict apply-ready filter);
  // it reports back up so the sidebar badge matches the queue page instead of a looser engine metric.
  const [pendingCount, setPendingCount] = useState(0);
  const clock = useClock();
  const isMobile = useIsMobile();
  const welcomedRef = useRef(false);
  // Track whether data has loaded at least once so subsequent reloads don't flash the skeleton.
  const hasLoadedOnce = useRef(false);
  if (!loading) hasLoadedOnce.current = true;

  const scheduleLabel = scheduleEnabled ? `Daily ${formatClockHour(scheduleHour)}` : "No schedule";

  const reload = useCallback(() => {
    reloadDashboard();
    setProfileRefreshKey((k) => k + 1);
    setJobsRefresh((n) => n + 1);
  }, [reloadDashboard]);

  useEffect(() => setAuthLocked(authRequired), [authRequired]);

  useEffect(() => {
    const onAuthRequired = () => setAuthLocked(true);
    window.addEventListener(API_AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(API_AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  const unlockApi = useCallback(async (token: string) => {
    setStoredApiToken(token);
    await apiJson<{ ok: boolean }>("/api/health");
    setAuthLocked(false);
    reload();
  }, [reload]);

  const clearApiToken = useCallback(() => {
    clearStoredApiToken();
    setAuthLocked(true);
  }, []);

  // First run (no profile yet): open the Welcome screen as a drawer over the command center.
  useEffect(() => {
    if (view !== "landing" && !loading && !configured && !authLocked && !error && !welcomedRef.current) {
      welcomedRef.current = true;
      setView("welcome");
    }
  }, [loading, configured, authLocked, error, view]);

  // --- UI interaction state (ports shared.js: toast) ---
  const [toast, setToast] = useState<string | null>(null);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] = useState({ message: "", log: [] as string[] });
  const [applying, setApplying] = useState(false);
  const [stopping, setStopping] = useState(false);

  const taskActive = discovering || applying;
  const taskLabel = discovering
    ? (discoveryProgress.message || "Discovering roles from your résumé")
    : applying
      ? (state.automationProgress.currentStepLabel || "Running automation")
      : "";


  // Poll discovery progress while a pass is running.
  useEffect(() => {
    if (!discovering || usingSample) return;
    const poll = () => {
      void apiFetch("/api/discover/status")
        .then((r) => r.json() as Promise<{ message?: string; log?: string[] }>)
        .then((s) => {
          setDiscoveryProgress({
            message: s.message ?? "Searching…",
            log: Array.isArray(s.log) ? s.log : [],
          });
        })
        .catch(() => undefined);
    };
    poll();
    const id = setInterval(poll, 1200);
    return () => clearInterval(id);
  }, [discovering, usingSample]);

  useEffect(() => {
    if (!applying || usingSample) return;
    const id = setInterval(() => reload(), 1200);
    return () => clearInterval(id);
  }, [applying, reload, usingSample]);

  const persistMinFit = (n: number) => {
    setMinFit(n);
    try { localStorage.setItem("applypilot.minFit", String(n)); } catch { /* storage blocked */ }
  };

  // Keep min-fit in sync when server state loads (first visit uses rules default).
  useEffect(() => {
    if (state.rules?.minFit && !localStorage.getItem("applypilot.minFit")) {
      setMinFit(state.rules.minFit);
    }
  }, [state.rules?.minFit]);

  const showToast = (msg: string) => setToast(msg);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), taskActive ? 3200 : 2400);
    return () => clearTimeout(t);
  }, [toast, taskActive]);

  // Schedule is engine-owned (commercial M9-C). A monotonic request id makes the LATEST read/write win,
  // so a slow mount GET can't clobber a newer save (and vice-versa). Applied only if still current.
  type SchedulePayload = { enabled: boolean; hour: number; nextRunAt: string | null };
  const scheduleReqRef = useRef(0);
  const applyScheduleSnapshot = useCallback((reqId: number, s: SchedulePayload) => {
    if (reqId !== scheduleReqRef.current) return; // superseded by a newer read/write
    setScheduleEnabled(Boolean(s.enabled));
    if (typeof s.hour === "number") setScheduleHour(s.hour);
    setScheduleNextRunAt(s.nextRunAt ?? null);
  }, []);
  const loadSchedule = useCallback(() => {
    const reqId = ++scheduleReqRef.current;
    apiFetch("/api/schedule", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<SchedulePayload>)
      .then((s) => applyScheduleSnapshot(reqId, s))
      .catch(() => { /* engine down: keep last-known values (topbar shows the local label only) */ });
  }, [applyScheduleSnapshot]);
  // Load on mount, then re-poll so the engine-computed "Next run" doesn't show a past time after the
  // engine fires and re-arms it to the next day.
  useEffect(() => {
    loadSchedule();
    const t = setInterval(loadSchedule, 60_000);
    return () => clearInterval(t);
  }, [loadSchedule]);

  // Persist a schedule change and re-arm the engine timer. Optimistic locally, then reconcile with the
  // engine's persisted state + truthful next-run. On failure, REVERT to the last known-good values so
  // the UI never claims a daily run the engine didn't actually persist/arm.
  const saveSchedule = useCallback((enabled: boolean, hour: number) => {
    const prev = { enabled: scheduleEnabled, hour: scheduleHour, nextRunAt: scheduleNextRunAt };
    const reqId = ++scheduleReqRef.current;
    setScheduleEnabled(enabled);
    setScheduleHour(hour);
    apiFetch("/api/schedule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, hour }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<SchedulePayload>) : Promise.reject(new Error(String(r.status)))))
      .then((s) => applyScheduleSnapshot(reqId, s))
      .catch(() => {
        if (reqId === scheduleReqRef.current) {
          setScheduleEnabled(prev.enabled);
          setScheduleHour(prev.hour);
          setScheduleNextRunAt(prev.nextRunAt);
        }
        showToast("ApplyPilot isn't running yet — open the app and try again.");
      });
  }, [applyScheduleSnapshot, scheduleEnabled, scheduleHour, scheduleNextRunAt]);
  const toggleSchedule = useCallback(() => saveSchedule(!scheduleEnabled, scheduleHour), [saveSchedule, scheduleEnabled, scheduleHour]);
  const shiftScheduleHour = useCallback((delta: number) => saveSchedule(scheduleEnabled, (scheduleHour + delta + 24) % 24), [saveSchedule, scheduleEnabled, scheduleHour]);

  const stopAllTasks = async () => {
    if (!taskActive) return;
    setStopping(true);
    try {
      await apiFetch("/api/tasks/stop", { method: "POST" });
      setDiscovering(false);
      showToast("Stopping after the current step…");
      reload();
    } catch (e) {
      showToast(`Stop failed: ${String((e as Error).message ?? e)}`);
    } finally {
      setStopping(false);
    }
  };

  const runDiscovery = async () => {
    if (usingSample) {
      showToast("ApplyPilot isn't running yet — open the app and try again.");
      return;
    }
    if (taskActive && !discovering) {
      showToast("Another task is running — use Stop first.");
      return;
    }
    setDiscovering(true);
    setDiscoveryProgress({ message: "Starting discovery…", log: ["Starting discovery…"] });
    showToast("Searching company boards in the background — progress shows on Matches.");
    try {
      const r = await apiFetch("/api/discover", { method: "POST" });
      const d = (await r.json()) as {
        error?: string;
        found?: number;
        matches?: number;
        targetsAdded?: string[];
        usedUnapprovedFacts?: boolean;
        stopped?: boolean;
      };
      if (!r.ok) throw new Error(d.error ?? `API ${r.status}`);
      const added = d.targetsAdded?.length ? ` Added ${d.targetsAdded.length} target(s).` : "";
      const approveHint = d.usedUnapprovedFacts ? " Approve facts in Résumé for tighter matching." : "";
      const stopNote = d.stopped ? " Stopped early." : "";
      showToast(`${d.stopped ? "Discovery stopped" : "Discovery done"} — ${d.found ?? 0} roles found, ${d.matches ?? 0} match your profile.${added}${approveHint}${stopNote}`);
      reload();
    } catch (e) {
      showToast(`Discovery failed: ${String((e as Error).message ?? e)}`);
    } finally {
      setDiscovering(false);
      setDiscoveryProgress({ message: "", log: [] });
    }
  };

  const runAutomation = async () => {
    if (usingSample) {
      showToast("ApplyPilot isn't running yet — open the app and try again.");
      return;
    }
    if (taskActive && !applying) {
      showToast("Another task is running — use Stop first.");
      return;
    }
    setApplying(true);
    showToast("Automation started — preparing real review packets.");
    try {
      const r = await apiFetch("/api/autopilot", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as {
        error?: string;
        run?: { submitted?: number; wouldSubmit?: number; queued?: number; skipped?: number; results?: unknown[] };
      };
      if (!r.ok) throw new Error(d.error ?? `API ${r.status}`);
      const queued = (d.run?.queued ?? 0) + (d.run?.wouldSubmit ?? 0);
      const submitted = d.run?.submitted ?? 0;
      const skipped = d.run?.skipped ?? 0;
      showToast(`Automation finished — ${queued} ready for review, ${submitted} submitted, ${skipped} skipped.`);
      reload();
    } catch (e) {
      showToast(`Automation failed: ${String((e as Error).message ?? e)}`);
      reload();
    } finally {
      setApplying(false);
    }
  };

  // The full in-app apply (visible prefill on the REAL employer page -> your review -> YOUR submit
  // click) lives in the Ready queue (Chronicle). These secondary "Prepare" buttons just take the
  // user there so there is one consistent place to review — and never an orphaned session.
  const applyJob = async (item: { jobUrl: string; company: string; role: string }) => {
    if (usingSample) {
      showToast("ApplyPilot isn't running yet — open the app and try again.");
      return;
    }
    setView("oneclick");
    showToast(`Open ${item.company} in your Ready queue — ApplyPilot prefills the real page where you can see it, and you click Submit.`);
  };

  useEffect(() => {
    document.body.classList.toggle("ap-task-active", taskActive);
    return () => document.body.classList.remove("ap-task-active");
  }, [taskActive]);

  const overlayOpen = coverageOpen;
  useEffect(() => {
    document.body.classList.toggle("overlay-open", overlayOpen);
  }, [overlayOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCoverageOpen(false);
        setView("matches");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const ui: Ui = {
    showToast,
    openCoverage: () => setCoverageOpen(true),
    applyJob,
    stopAll: stopAllTasks,
    runDiscovery,
    runAutomation,
    taskActive,
    discovering,
    discoveryProgress,
    applying,
    stopping,
  };
  const isChronicleTab = (view === "matches" || view === "automation" || view === "oneclick" || view === "applied" || view === "blocked" || view === "profile" || view === "rules");
  const liveUnavailable = Boolean(error && !authLocked && !usingSample);
  // When the engine is unreachable, show the engine-down state — it offers an in-app restart inside
  // the desktop shell and a retry in plain-browser dev. `reload` re-runs the data hooks.
  const unavailableView = <LiveUnavailableState onRetry={reload} />;

  if (view === "landing") {
    return (
      <>
        <LandingPage
          state={state}
          configured={configured}
          loading={loading}
          theme={theme}
          onToggleTheme={toggleTheme}
          onNavigate={setView}
          onRunDiscovery={() => {
            setView("matches");
            void runDiscovery();
          }}
        />
        <div className={`toast ap-toast${toast ? " is-visible" : ""}`} aria-live="polite">
          {toast}
        </div>
        <AuthUnlockOverlay open={authLocked} error={error} onUnlock={unlockApi} onClear={clearApiToken} />
      </>
    );
  }

  // On a phone, ApplyPilot is a MONITOR: watch what the automation is doing. The heavy review/apply
  // controls (and any submit affordance) stay on desktop — you never fire an application from mobile.
  if (isMobile) {
    return (
      <>
        {liveUnavailable && !loading ? (
          <main className="mobile-monitor">
            {unavailableView}
          </main>
        ) : (
          <MobileMonitor state={state} loading={loading} configured={configured} usingSample={usingSample} onReload={reload} />
        )}
        <AuthUnlockOverlay open={authLocked} error={error} onUnlock={unlockApi} onClear={clearApiToken} />
      </>
    );
  }

  // First-run onboarding is a focused, full-screen wizard — no shell chrome to distract from setup.
  if (view === "welcome") {
    return (
      <>
        <main className="apx apx-focus">
          <WelcomeView onToast={showToast} onReload={reload} onNavigate={setView} usingSample={usingSample} onResumePreview={setResumePreview} />
        </main>
        <div className={`toast ap-toast${toast ? " is-visible" : ""}`} aria-live="polite">{toast}</div>
        <AuthUnlockOverlay open={authLocked} error={error} onUnlock={unlockApi} onClear={clearApiToken} />
      </>
    );
  }

  const shellContent = (loading && !hasLoadedOnce.current) ? (
    <div className="apx-grid apx-grid-4" aria-busy="true" aria-label="Loading workspace">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="apx-card apx-skel-card"><div className="apx-skel line sm" /><div className="apx-skel block" /></div>
      ))}
    </div>
  ) : liveUnavailable ? (
    unavailableView
  ) : isChronicleTab ? (
    <ChronicleDashboard
      state={state}
      activeTab={view as ChronicleTab}
      onNavigate={(tab) => setView(tab)}
      ui={ui as ChronicleUi}
      minFit={minFit}
      onMinFit={persistMinFit}
      jobsRefresh={jobsRefresh}
      usingSample={usingSample}
      onReload={reload}
      hideChrome
      scheduleEnabled={scheduleEnabled}
      scheduleHour={scheduleHour}
      onToggleSchedule={toggleSchedule}
      onShiftScheduleHour={shiftScheduleHour}
      scheduleNextRunAt={scheduleNextRunAt}
      onPendingCount={setPendingCount}
    />
  ) : view === "settings" ? (
    <SettingsView onToast={showToast} onReload={reload} onNavigate={setView} />
  ) : view === "resume" ? (
    <ResumeLedgerView onToast={showToast} onReload={reload} usingSample={usingSample} pendingPreview={resumePreview} onResumePreview={setResumePreview} />
  ) : view === "targets" ? (
    <TargetsView onToast={showToast} onReload={reload} usingSample={usingSample} ui={ui} />
  ) : view === "generate" ? (
    <GenerateView onToast={showToast} />
  ) : view === "insights" ? (
    <InsightsView onToast={showToast} />
  ) : view === "logins" ? (
    <LoginsView onToast={showToast} />
  ) : view === "help" ? (
    <HelpDiagnosticsView onToast={showToast} />
  ) : null;

  return (
    <>
      <AppShell
        view={view as ShellView}
        onNavigate={(v) => setView(v)}
        pendingCount={pendingCount}
        profileName={state.pilot.name}
        profileInitials={state.pilot.initials}
        theme={theme}
        onToggleTheme={toggleTheme}
        status={{ running: taskActive || Boolean(state.runner?.running), label: taskActive ? "Pilot running" : state.hero.live ? "Automation live" : "Automation ready" }}
        scheduleLabel={scheduleLabel}
        clock={clock}
        taskActive={taskActive}
        stopping={stopping}
        onRun={() => void runAutomation()}
        onStop={stopAllTasks}
        hasNotifications={state.log.length > 0}
      >
        {shellContent}
      </AppShell>

      <CoverageModal open={coverageOpen} coverage={state.coverage} onClose={() => setCoverageOpen(false)} />

      <div className={`toast ap-toast${toast ? " is-visible" : ""}`} aria-live="polite">
        {toast}
      </div>

      <GlobalStopBar
        visible={taskActive}
        label={taskLabel}
        stopping={stopping}
        onStop={stopAllTasks}
      />
      <AuthUnlockOverlay open={authLocked} error={error} onUnlock={unlockApi} onClear={clearApiToken} />
    </>
  );
}

function LandingPage({
  state,
  configured,
  loading,
  theme,
  onToggleTheme,
  onNavigate,
  onRunDiscovery,
}: {
  state: DashboardState;
  configured: boolean;
  loading: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  onNavigate: (view: View) => void;
  onRunDiscovery: () => void;
}) {
  const metrics = [
    { label: "Qualified roles", value: state.hero.metrics.qualified || state.rail.readyToClick || 0 },
    { label: "Application drafts", value: state.hero.metrics.needOneClick || state.oneClick.length || 0 },
    { label: "Tracked progress", value: state.applied.summary.sent || state.hero.metrics.appliedTotal || 0 },
  ];
  const status = loading ? "Connecting" : configured ? "Local workspace ready" : "Profile needed";
  return (
    <main className="saas-landing" aria-label="ApplyPilot landing page">
      <nav className="landing-nav">
        <button className="landing-brand" type="button" onClick={() => onNavigate("matches")} aria-label="Open ApplyPilot">
          <Logo size={34} tile />
          <span>ApplyPilot</span>
        </button>
        <div className="landing-nav-actions">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button className="button compact secondary" type="button" onClick={() => onNavigate("settings")}>
            <Icon name="settings" /> Settings
          </button>
          <button className="button compact primary" type="button" onClick={() => onNavigate(configured ? "matches" : "welcome")}>
            <Icon name="board" /> Dashboard
          </button>
        </div>
      </nav>

      <section className="landing-hero">
        <div className="landing-hero-shade" />
        <div className="landing-hero-copy">
          <p className="eyebrow">{status}</p>
          <h1>ApplyPilot</h1>
          <p>Resume to matched jobs, tailored packets, and application drafts that wait for your review before anything is submitted.</p>
          <div className="landing-hero-actions">
            <button className="button primary" type="button" onClick={() => onNavigate(configured ? "matches" : "welcome")}>
              <Icon name="spark" /> Open dashboard
            </button>
            <button className="button secondary" type="button" onClick={() => onNavigate("resume")}>
              <Icon name="upload" /> Upload resume
            </button>
            <button className="button ghost" type="button" onClick={onRunDiscovery}>
              <Icon name="search" /> Run discovery
            </button>
          </div>
        </div>
        <div className="landing-command-strip" aria-label="Workspace summary">
          {metrics.map((metric) => (
            <article key={metric.label}>
              <strong>{metric.value}</strong>
              <span>{metric.label}</span>
            </article>
          ))}
          <article>
            <strong>{state.rules.minFit || 70}%</strong>
            <span>Fit threshold</span>
          </article>
        </div>
      </section>

      <section className="landing-workflow" aria-label="ApplyPilot workflow">
        <article>
          <Icon name="file" />
          <h2>Profile intelligence</h2>
          <p>Parsed resume facts, career preferences, custom answers, and avoid lists become the source of truth.</p>
        </article>
        <article>
          <Icon name="search" />
          <h2>Job matching</h2>
          <p>Roles are ranked with match reasons, weak qualifications, salary and location signals, and apply links.</p>
        </article>
        <article>
          <Icon name="shield" />
          <h2>Review gate</h2>
          <p>Cover letters, resume summaries, and form answers are prepared as drafts until the user approves.</p>
        </article>
      </section>

      <section className="landing-product-band">
        <div>
          <p className="eyebrow">Local-first workspace</p>
          <h2>One command center for the job search.</h2>
          <p>Track saved, applied, interviewing, rejected, and offer stages while keeping automation accountable.</p>
        </div>
        <div className="landing-stage-list">
          {(["Saved", "Applied", "Interviewing", "Offer"] as const).map((label, index) => (
            <span key={label}><b>{index + 1}</b>{label}</span>
          ))}
        </div>
      </section>
    </main>
  );
}

function AuthUnlockOverlay({
  open,
  error,
  onUnlock,
  onClear,
}: {
  open: boolean;
  error: string | null;
  onUnlock: (token: string) => Promise<void>;
  onClear: () => void;
}) {
  const [token, setToken] = useState(getStoredApiToken());
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (open) setToken(getStoredApiToken());
  }, [open]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setChecking(true);
    setMessage(null);
    try {
      await onUnlock(token);
    } catch (e) {
      setMessage(String((e as Error).message ?? e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="auth-lock" role="dialog" aria-modal="true" aria-label="Unlock ApplyPilot">
      <form className="auth-lock-panel" onSubmit={submit}>
        <span className="brand-mark"><Logo size={34} /></span>
        <p className="eyebrow">Private web access</p>
        <h2>Enter your access token</h2>
        <p>
          This ApplyPilot is set up for remote access, so it needs your access token. It's kept only in this browser and never leaves your devices.
        </p>
        <label className="settings-field">
          <span>Access token</span>
          <input
            type="password"
            value={token}
            autoFocus
            autoComplete="off"
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your access token"
          />
        </label>
        {(message || error) && <p className="auth-lock-error">{message ?? error}</p>}
        <div className="auth-lock-actions">
          <button className="button primary" type="submit" disabled={checking || !token.trim()}>
            {checking ? "Checking..." : "Unlock"}
          </button>
          <button className="button secondary" type="button" disabled={checking} onClick={() => { onClear(); setToken(""); }}>
            Clear saved token
          </button>
        </div>
      </form>
    </div>
  );
}

function GlobalStopBar({
  visible,
  label,
  stopping,
  onStop,
}: {
  visible: boolean;
  label: string;
  stopping: boolean;
  onStop: () => void;
}) {
  return (
    <div className={`global-stop-bar ap-stopbar${visible ? " is-visible" : ""}`} role="status" aria-live="polite">
      <span className="stop-bar-pulse ap-stopbar__pulse" aria-hidden="true" />
      <div className="stop-bar-copy ap-stopbar__copy">
        <strong>{stopping ? "Stopping…" : "Working"}</strong>
        <small>{label || "ApplyPilot is running a browser task"}</small>
      </div>
      <Button variant="danger" className="compact" disabled={stopping} loading={stopping} onClick={onStop}>
        Stop
      </Button>
    </div>
  );
}

/* ----------------------------- Mobile monitor (read-only) ----------------------------- */

function MobileMonitor({
  state,
  loading,
  configured,
  usingSample,
  onReload,
}: {
  state: DashboardState;
  loading: boolean;
  configured: boolean;
  usingSample: boolean;
  onReload: () => void;
}) {
  const { pilot, hero, accounts, lastRun, oneClick, rail, log } = state;
  return (
    <main className="mobile-monitor" aria-label="ApplyPilot mobile monitor">
      <header className="mm-top">
        <div className="mm-brand"><span className="brand-mark"><Logo size={24} /></span> ApplyPilot</div>
        <div className="mm-mode">
          <span className="status-dot live" />
          Matches · Monitor
        </div>
      </header>

      {usingSample && <div className="mm-banner">Showing sample data — your local API isn’t running.</div>}

      {loading ? (
        <div className="mm-card"><h2>Loading…</h2><p className="mm-sub">Reading your local pipeline.</p></div>
      ) : !configured ? (
        <div className="mm-card">
          <h2>Set up on desktop</h2>
          <p className="mm-sub">Run setup, ingest, and discover on your computer, then monitor progress here.</p>
        </div>
      ) : (
        <>
          <section className="mm-card mm-hero">
            <p className="eyebrow">{pilot.name}</p>
            <h1>{hero.metrics.qualified} matching roles</h1>
            <p className="mm-sub">ApplyPilot finds US roles on company career pages, ranks them, and prepares applications for your review.</p>
          </section>

          <section className="mm-metrics" aria-label="Today’s numbers">
            <article><strong>{hero.metrics.qualified}</strong><span>matches</span></article>
            <article><strong>{hero.metrics.needOneClick}</strong><span>ready to apply</span></article>
            <article><strong>{hero.metrics.autoApplied}</strong><span>submitted</span></article>
            <article><strong>{hero.metrics.appliedTotal}</strong><span>in pipeline</span></article>
          </section>

          <section className="mm-card mm-queue">
            <div className="mm-row-head">
              <h3>Ready to apply</h3>
              <span className="score-badge">{rail.readyToClick}</span>
            </div>
            <p className="mm-sub">{oneClick.length ? "Scored roles waiting for you on desktop." : "Run discovery on desktop to find roles."}</p>
            <p className="mm-note">
              <Icon name="shield" />
              Prepare application and Submit happen on desktop — mobile is monitor-only.
            </p>
          </section>

          <section className="mm-card">
            <h3>Sessions</h3>
            <div className="mm-sessions">
              <span><strong>{accounts.loggedIn}</strong> logged in</span>
              <span><strong>{accounts.needsLogin}</strong> need login</span>
            </div>
            {lastRun && (
              <p className="mm-sub">Last activity {lastRun.at}: {lastRun.queued} queued, {lastRun.submitted} submitted.</p>
            )}
          </section>

          <section className="mm-card mm-activity">
            <h3>Recent activity</h3>
            <div className="mm-log">
              {log.length === 0 ? (
                <p className="mm-sub">No activity yet.</p>
              ) : (
                log.slice(0, 6).map((l, i) => (
                  <article key={i}>
                    <span className={`activity-dot ${l.dot}`} />
                    <div><strong>{l.time}</strong><p>{l.text}</p></div>
                  </article>
                ))
              )}
            </div>
          </section>

          <button className="mm-refresh" type="button" onClick={onReload}><Icon name="clock" /> Refresh</button>
          <p className="mm-foot">
            <Icon name="shield" />
            Discovery runs on company ATS boards only. Full controls live on desktop.
          </p>
        </>
      )}
    </main>
  );
}

interface Ui {
  showToast: (m: string) => void;
  openCoverage: () => void;
  applyJob: (item: { jobUrl: string; company: string; role: string }) => void;
  stopAll: () => void;
  runDiscovery: () => Promise<void>;
  runAutomation: () => Promise<void>;
  taskActive: boolean;
  discovering: boolean;
  discoveryProgress: { message: string; log: string[] };
  applying: boolean;
  stopping: boolean;
}



/* ----------------------------- Welcome / first-run onboarding ----------------------------- */

function WelcomeView({
  onToast,
  onReload,
  onNavigate,
  usingSample,
  onResumePreview,
}: {
  onToast: (m: string) => void;
  onReload: () => void;
  onNavigate: (v: View) => void;
  usingSample: boolean;
  onResumePreview: (preview: ResumeImportPreview | null) => void;
}) {
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [savingInfo, setSavingInfo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [resumeName, setResumeName] = useState<string | null>(null);
  const [llmConfigured, setLlmConfigured] = useState(true);
  const [companyUrl, setCompanyUrl] = useState("");
  const [addingCompany, setAddingCompany] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch("/api/profile", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<{ form: ProfileForm }>)
      .then((d) => setForm(d.form))
      .catch(() => setForm(EMPTY_FORM));
    apiFetch("/api/settings", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<{ llmConfigured: boolean }>)
      .then((s) => setLlmConfigured(s.llmConfigured))
      .catch(() => { /* offline: leave defaults */ });
  }, []);

  const set = (k: keyof ProfileForm, v: string) => setForm((f) => (f ? ({ ...f, [k]: v } as ProfileForm) : f));

  // Basics POST the full form; blank fields are left untouched server-side (no fabrication/downgrade).
  const saveInfo = async () => {
    if (!form) return;
    setSavingInfo(true);
    try {
      const r = await apiFetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      if (!r.ok) { const e = (await r.json().catch(() => ({}))) as { error?: string }; throw new Error(e.error ?? `API ${r.status}`); }
      onToast("Saved your basic info.");
      onReload();
    } catch (e) { onToast(`Couldn’t save: ${String((e as Error).message ?? e)}`); }
    finally { setSavingInfo(false); }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (usingSample) {
      onToast("ApplyPilot isn't running yet — open the app and try again.");
      return;
    }
    setUploading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const r = await apiFetch("/api/resume/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: file.name, contentBase64 }) });
      const d = await r.json() as ResumeImportPreview & { error?: string };
      if (!r.ok) throw new Error(d.error ?? `API ${r.status}`);
      setResumeName(file.name);
      if (d.form) setForm(d.form as ProfileForm);
      onResumePreview(d);
      const filled = typeof d.profileFieldsFilled === "number" ? d.profileFieldsFilled : 0;
      onToast(
        filled > 0
          ? `Parsed ${file.name} and mapped ${filled} profile field${filled === 1 ? "" : "s"} — review before import.`
          : `Parsed ${file.name} — review ${d.facts?.length ?? 0} fact(s) before import.`
      );
      onNavigate("resume");
    } catch (e) { onToast(`Upload failed: ${String((e as Error).message ?? e)}`); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };


  const addCompany = async () => {
    const u = companyUrl.trim();
    if (!u) return;
    setAddingCompany(true);
    onToast(/lever\.co|greenhouse|ashbyhq|workdayjobs|smartrecruiters|jobvite|icims|linkedin\.com\/jobs|indeed|glassdoor|ziprecruiter|monster|dice|wellfound|angel\.co/.test(u) ? "Adding source…" : "Browsing the company site to find its job source…");
    try {
      const r = await apiFetch("/api/companies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: u }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `API ${r.status}`);
      onToast(`Added ${d.company.name} [${d.company.atsType}].`);
      setCompanyUrl("");
      onReload();
    } catch (e) { onToast(String((e as Error).message ?? e)); }
    finally { setAddingCompany(false); }
  };

  if (!form) return <div className="focused-view narrow"><div className="panel"><h2>Loading…</h2></div></div>;

  return (
    <div className="focused-view narrow">
      <div className="panel welcome-panel">
        <p className="eyebrow">Welcome to ApplyPilot</p>
        <h2>Let’s get you set up</h2>
        <p className="welcome-intro">
          ApplyPilot finds roles on career pages, ATS boards, and supported job-search sources, then fills applications for you — but you stay in control. Your data stays <strong>on this machine by default</strong>, it <strong>never invents</strong> anything that isn’t in your résumé, and it <strong>never submits</strong> an application without your review.
        </p>

        <section className="welcome-step">
          <h3 className="profile-section">1 · Your basics</h3>
          <div className="profile-grid">
            <FormText label="Legal first name" required value={form.legalFirstName} onChange={(v) => set("legalFirstName", v)} />
            <FormText label="Legal last name" required value={form.legalLastName} onChange={(v) => set("legalLastName", v)} />
            <FormText label="Email" type="email" required value={form.email} onChange={(v) => set("email", v)} />
            <FormText label="Phone" required value={form.phone} onChange={(v) => set("phone", v)} />
            <FormText label="City" value={form.city} onChange={(v) => set("city", v)} />
            <FormText label="State (e.g. NY)" value={form.state} onChange={(v) => set("state", v)} />
            <FormSelect label="Authorized to work in the US?" value={form.authorizedToWorkInUS} onChange={(v) => set("authorizedToWorkInUS", v)} options={YESNO_OPTS} />
            <FormText label="LinkedIn URL" value={form.linkedin} onChange={(v) => set("linkedin", v)} />
            <FormText label="Portfolio URL" value={form.portfolio} onChange={(v) => set("portfolio", v)} />
          </div>
          <button className="button primary" type="button" onClick={saveInfo} disabled={savingInfo}>
            <Icon name="check" /> {savingInfo ? "Saving…" : "Save basics"}
          </button>
        </section>

        <section className="welcome-step">
          <h3 className="profile-section">2 · Upload your résumé</h3>
          <p className="settings-hint">We&apos;ll parse your résumé into facts <strong>and</strong> auto-fill your profile (name, email, phone, links, location).</p>
          <p className="settings-hint">PDF, DOCX, TXT, or MD. We extract facts for you to review and approve — nothing is used in an application until you approve it.</p>
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          <div className="welcome-upload">
            <button className="button secondary" type="button" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" /> {uploading ? "Uploading…" : "Choose résumé file"}
            </button>
            {resumeName && <span className="welcome-file">✓ {resumeName} uploaded</span>}
          </div>
        </section>

        <section className="welcome-step">
          <h3 className="profile-section">3 · Private AI <small>(built in)</small></h3>
          <p className="settings-hint">
            ApplyPilot's AI is <strong>built in</strong> — it runs on this machine, free, with nothing to install and no account needed. The model downloads once from Settings (about 1&nbsp;GB); until then, matching and documents use the fast rule-based engine.
            {llmConfigured ? <> <em>AI is configured.</em></> : <> Open Settings to download the model or choose another provider.</>}
          </p>
        </section>

        <section className="welcome-step">
          <h3 className="profile-section">4 · Add a target company <small>(optional)</small></h3>
          <p className="settings-hint">Paste a company careers homepage, an ATS board, or a supported job-search URL such as LinkedIn or Indeed.</p>
          <div className="welcome-inline">
            <input type="url" placeholder="https://company.com  —or—  https://www.linkedin.com/jobs/search/..." value={companyUrl} onChange={(e) => setCompanyUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addCompany(); }} />
            <button className="button secondary" type="button" disabled={addingCompany || !companyUrl.trim()} onClick={addCompany}>{addingCompany ? "Adding…" : "Add"}</button>
          </div>
        </section>

        <div className="welcome-footer">
          <button className="button primary" type="button" onClick={() => onNavigate("matches")}>
            <Icon name="play" /> Go to the dashboard
          </button>
          <button className="button secondary" type="button" onClick={() => onNavigate("profile")}>Open full profile →</button>
        </div>
        <p className="safety-note">
          <Icon name="shield" />
          Your details and résumé stay on this machine. ApplyPilot fills applications but pauses for your review — it never submits on its own.
        </p>
      </div>
    </div>
  );
}

interface SettingsState {
  hasKey: boolean;
  keyHint: string | null;
  model: string;
  llmProvider: string;
  llmBaseUrl: string | null;
  llmConfigured: boolean;
  qualityMode: boolean;
  maxAgeDays: number;
  /** Commercial source policy — env-configured (APPLYPILOT_SOURCE_POLICY), read-only in the UI. */
  sourcePolicy?: "defensible" | "gray" | "all";
  adzunaConfigured: boolean;
  adzunaAppIdHint: string | null;
  adzunaAppKeyHint: string | null;
  joobleConfigured: boolean;
  joobleKeyHint: string | null;
  usajobsConfigured: boolean;
  usajobsKeyHint: string | null;
  usajobsEmailHint: string | null;
}

type LlmProviderOption = "embedded" | "ollama" | "openai-compatible" | "anthropic";

interface LlmModelStatus {
  id: string;
  kind: "chat" | "embedding";
  present: boolean;
  downloading: boolean;
  progress: number | null;
  error: string | null;
  approxBytes: number;
  license: string;
}
interface LlmStatus {
  provider: string;
  mode: string;
  model: string;
  models: LlmModelStatus[];
  chat: { ok: boolean; error: string | null; latencyMs: number | null } | null;
  embedding: { ok: boolean; error: string | null; latencyMs: number | null } | null;
}

function SettingsView({ onToast, onReload, onNavigate }: { onToast: (m: string) => void; onReload: () => void; onNavigate: (v: View) => void }) {
  const [hasKey, setHasKey] = useState(false);
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [llmProvider, setLlmProvider] = useState<LlmProviderOption>("embedded");
  const [llmBaseUrl, setLlmBaseUrl] = useState("http://localhost:11434/v1");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [model, setModel] = useState("qwen2.5-1.5b-instruct");
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [probing, setProbing] = useState(false);
  const [qualityMode, setQualityMode] = useState(false);
  const [maxAgeDays, setMaxAgeDays] = useState(7);
  const [sourcePolicy, setSourcePolicy] = useState<"defensible" | "gray" | "all">("defensible");
  const [adzunaConfigured, setAdzunaConfigured] = useState(false);
  const [adzunaAppIdHint, setAdzunaAppIdHint] = useState<string | null>(null);
  const [adzunaAppKeyHint, setAdzunaAppKeyHint] = useState<string | null>(null);
  const [adzunaAppId, setAdzunaAppId] = useState("");
  const [adzunaAppKey, setAdzunaAppKey] = useState("");
  const [joobleConfigured, setJoobleConfigured] = useState(false);
  const [joobleKeyHint, setJoobleKeyHint] = useState<string | null>(null);
  const [joobleKey, setJoobleKey] = useState("");
  const [usajobsConfigured, setUsajobsConfigured] = useState(false);
  const [usajobsKeyHint, setUsajobsKeyHint] = useState<string | null>(null);
  const [usajobsEmailHint, setUsajobsEmailHint] = useState<string | null>(null);
  const [usajobsKey, setUsajobsKey] = useState("");
  const [usajobsEmail, setUsajobsEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const llmNeedsKey = llmProvider === "anthropic";
  const llmIsBundled = llmProvider === "embedded";
  const llmDefaultUrl =
    llmProvider === "ollama"
      ? "http://localhost:11434/v1"
      : llmProvider === "openai-compatible"
        ? "http://localhost:8080/v1"
        : "";

  const refreshLlmStatus = useCallback(async (probe = false) => {
    try {
      const r = await apiFetch(`/api/llm/status${probe ? "?probe=1" : ""}`, { headers: { accept: "application/json" } });
      if (r.ok) setLlmStatus((await r.json()) as LlmStatus);
    } catch {
      /* engine down — the page-level fallbacks cover this */
    }
  }, []);

  useEffect(() => {
    void refreshLlmStatus();
  }, [refreshLlmStatus]);

  // While a model download runs, poll status so the progress bar moves.
  const downloadsActive = Boolean(llmStatus?.models.some((m) => m.downloading));
  useEffect(() => {
    if (!downloadsActive) return;
    const t = window.setInterval(() => void refreshLlmStatus(), 1500);
    return () => window.clearInterval(t);
  }, [downloadsActive, refreshLlmStatus]);

  const startModelDownload = async () => {
    try {
      const r = await apiFetch("/api/llm/models/download", { method: "POST" });
      if (!r.ok) throw new Error(`API ${r.status}`);
      onToast("Model download started.");
      await refreshLlmStatus();
    } catch (e) {
      onToast(`Could not start the download: ${String((e as Error).message ?? e)}`);
    }
  };

  // Browser engine (Playwright Chromium) — downloaded on first run to this machine, needed for Find jobs
  // and Apply (commercial M8). Mirrors the model-download status/install flow above.
  const [browserEngine, setBrowserEngine] = useState<{ present: boolean; installing: boolean; error?: string } | null>(null);
  const refreshBrowserEngine = useCallback(async () => {
    try {
      const r = await apiFetch("/api/browser/status", { headers: { accept: "application/json" } });
      if (r.ok) setBrowserEngine((await r.json()) as { present: boolean; installing: boolean; error?: string });
    } catch {
      /* engine down — page-level fallbacks cover this */
    }
  }, []);
  useEffect(() => {
    void refreshBrowserEngine();
  }, [refreshBrowserEngine]);
  const browserInstalling = Boolean(browserEngine?.installing);
  useEffect(() => {
    if (!browserInstalling) return;
    const t = window.setInterval(() => void refreshBrowserEngine(), 1500);
    return () => window.clearInterval(t);
  }, [browserInstalling, refreshBrowserEngine]);
  const startBrowserInstall = async () => {
    try {
      const r = await apiFetch("/api/browser/install", { method: "POST" });
      if (!r.ok) throw new Error(`API ${r.status}`);
      onToast("Browser engine download started.");
      await refreshBrowserEngine();
    } catch (e) {
      onToast(`Could not start the browser download: ${String((e as Error).message ?? e)}`);
    }
  };

  const testAi = async () => {
    setProbing(true);
    try {
      await refreshLlmStatus(true);
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    apiFetch("/api/settings", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<SettingsState>)
      .then((s) => {
        setHasKey(s.hasKey);
        setKeyHint(s.keyHint);
        setLlmConfigured(s.llmConfigured);
        if (s.llmProvider) setLlmProvider(s.llmProvider as LlmProviderOption);
        if (s.llmBaseUrl) setLlmBaseUrl(s.llmBaseUrl);
        setModel(s.model || "qwen2.5-1.5b-instruct");
        setQualityMode(Boolean(s.qualityMode));
        if (typeof s.maxAgeDays === "number") setMaxAgeDays(s.maxAgeDays);
        setSourcePolicy(s.sourcePolicy ?? "defensible");
        setAdzunaConfigured(Boolean(s.adzunaConfigured));
        setAdzunaAppIdHint(s.adzunaAppIdHint ?? null);
        setAdzunaAppKeyHint(s.adzunaAppKeyHint ?? null);
        setJoobleConfigured(Boolean(s.joobleConfigured));
        setJoobleKeyHint(s.joobleKeyHint ?? null);
        setUsajobsConfigured(Boolean(s.usajobsConfigured));
        setUsajobsKeyHint(s.usajobsKeyHint ?? null);
        setUsajobsEmailHint(s.usajobsEmailHint ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiFetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildSettingsPayload({
            llmProvider,
            llmModel: model,
            llmBaseUrl,
            llmApiKey,
            maxAgeDays,
            adzunaAppId,
            adzunaAppKey,
            joobleKey,
            usajobsKey,
            usajobsEmail,
          })
        ),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      const s = (await r.json()) as SettingsState;
      setHasKey(s.hasKey);
      setKeyHint(s.keyHint);
      setLlmConfigured(s.llmConfigured);
      setModel(s.model);
      if (typeof s.maxAgeDays === "number") setMaxAgeDays(s.maxAgeDays);
      setSourcePolicy(s.sourcePolicy ?? "defensible");
      setLlmApiKey("");
      setAdzunaConfigured(Boolean(s.adzunaConfigured));
      setAdzunaAppIdHint(s.adzunaAppIdHint ?? null);
      setAdzunaAppKeyHint(s.adzunaAppKeyHint ?? null);
      setAdzunaAppId(""); setAdzunaAppKey("");
      setJoobleConfigured(Boolean(s.joobleConfigured));
      setJoobleKeyHint(s.joobleKeyHint ?? null);
      setJoobleKey("");
      setUsajobsConfigured(Boolean(s.usajobsConfigured));
      setUsajobsKeyHint(s.usajobsKeyHint ?? null);
      setUsajobsEmailHint(s.usajobsEmailHint ?? null);
      setUsajobsKey(""); setUsajobsEmail("");
      onToast("Settings saved.");
      onReload();
    } catch (e) {
      onToast(`Couldn’t save settings: ${String((e as Error).message ?? e)}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleQualityMode = async (next: boolean) => {
    setQualityMode(next); // optimistic
    try {
      const r = await apiFetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qualityMode: next }),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      const s = (await r.json()) as SettingsState;
      setQualityMode(Boolean(s.qualityMode));
      onToast(next ? "Quality mode on — passes stay tight and selective." : "Quality mode off — standard volume.");
    } catch (e) {
      setQualityMode(!next); // rollback
      onToast(`Couldn’t update quality mode: ${String((e as Error).message ?? e)}`);
    }
  };

  return (
    <div className="focused-view narrow">
      <div className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AI model</p>
            <h2>LLM provider</h2>
          </div>
          <span className={`score-badge${llmConfigured ? " ok" : ""}`}>{llmConfigured ? "Configured" : "Not set"}</span>
        </div>
        <p className="settings-hint">
          Powers résumé parsing, matching, and tailored documents. The default is the <b>bundled model</b> — built in, free, runs entirely on this machine. Power users can point ApplyPilot at their own local server or a Claude API key instead.
        </p>
        <label className="settings-field">
          <span>Provider</span>
          <select
            value={llmProvider}
            onChange={(e) => {
              const p = e.target.value as LlmProviderOption;
              setLlmProvider(p);
              if (p === "embedded") {
                setModel("qwen2.5-1.5b-instruct");
              } else if (p === "ollama") {
                setLlmBaseUrl("http://localhost:11434/v1");
                setModel("gemma4:e4b");
              } else if (p === "openai-compatible") {
                setLlmBaseUrl("http://localhost:8080/v1");
                setModel("local-model");
              } else {
                setModel("claude-sonnet-4-6");
              }
            }}
          >
            <option value="embedded">Bundled (recommended — built-in, no setup)</option>
            <option value="ollama">Ollama (local, open source)</option>
            <option value="openai-compatible">OpenAI-compatible (LocalAI, vLLM, LM Studio)</option>
            <option value="anthropic">Anthropic Claude (cloud, paid)</option>
          </select>
        </label>
        {!llmIsBundled && llmProvider !== "anthropic" ? (
          <label className="settings-field">
            <span>Local API URL {llmDefaultUrl ? <em>(default {llmDefaultUrl})</em> : null}</span>
            <input type="url" spellCheck={false} value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} />
          </label>
        ) : null}
        {!llmIsBundled ? (
          <label className="settings-field">
            <span>Model name</span>
            {llmProvider === "anthropic" ? (
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="claude-opus-4-8">claude-opus-4-8</option>
                <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
              </select>
            ) : (
              <input
                type="text"
                spellCheck={false}
                placeholder={llmProvider === "ollama" ? "gemma4:e4b" : "model id"}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </label>
        ) : null}
        {llmNeedsKey ? (
          <label className="settings-field">
            <span>Anthropic API key {keyHint ? <em>(current {keyHint})</em> : null}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={llmApiKey}
              onChange={(e) => setLlmApiKey(e.target.value)}
            />
          </label>
        ) : (
          <p className="settings-hint">No API key needed — everything runs on your machine.</p>
        )}

        {llmIsBundled ? (
          <div className="settings-subpanel">
            {(llmStatus?.models ?? []).map((m) => (
              <p className="settings-hint" key={m.id}>
                <b>{m.kind === "chat" ? "Writing model" : "Matching model"}</b> ({m.id}, {m.license}):{" "}
                {m.present
                  ? "ready"
                  : m.downloading
                    ? `downloading… ${Math.round((m.progress ?? 0) * 100)}%`
                    : m.error
                      ? `download failed — ${m.error}`
                      : `not downloaded (~${Math.round(m.approxBytes / 1e6)} MB)`}
              </p>
            ))}
            {llmStatus && llmStatus.models.some((m) => !m.present) ? (
              <button className="button secondary" type="button" onClick={() => void startModelDownload()} disabled={downloadsActive}>
                {downloadsActive ? "Downloading…" : "Download AI models"}
              </button>
            ) : null}
          </div>
        ) : null}

        {browserEngine ? (
          <div className="settings-subpanel">
            <p className="settings-hint">
              <b>Browser engine</b>:{" "}
              {browserEngine.present
                ? "ready"
                : browserEngine.installing
                  ? "downloading…"
                  : browserEngine.error
                    ? `install failed — ${browserEngine.error}`
                    : "not installed — needed for Find jobs and Apply"}
            </p>
            {!browserEngine.present ? (
              <button
                className="button secondary"
                type="button"
                onClick={() => void startBrowserInstall()}
                disabled={browserEngine.installing}
              >
                {browserEngine.installing ? "Downloading…" : "Install browser engine"}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="settings-actions">
          <button className="button primary" type="button" onClick={save} disabled={saving || !loaded}>
            <Icon name="check" /> {saving ? "Saving…" : "Save settings"}
          </button>
          <button className="button secondary" type="button" onClick={() => void testAi()} disabled={probing}>
            {probing ? "Testing…" : "Test AI"}
          </button>
        </div>
        {llmStatus?.chat ? (
          <p className="settings-hint">
            Writing: {llmStatus.chat.ok ? `working (${llmStatus.chat.latencyMs} ms)` : `not responding — ${llmStatus.chat.error}`}
            {llmStatus.embedding ? <> · Matching: {llmStatus.embedding.ok ? `working (${llmStatus.embedding.latencyMs} ms)` : `not responding — ${llmStatus.embedding.error}`}</> : null}
          </p>
        ) : null}

        <p className="safety-note">
          <Icon name="shield" />
          Local models never leave your machine. Cloud keys are stored only on this machine.
        </p>
      </div>

      <div className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Application strategy</p>
            <h2>Quality over volume</h2>
          </div>
          <span className={`score-badge${qualityMode ? " ok" : ""}`}>{qualityMode ? "On" : "Off"}</span>
        </div>
        <p className="settings-hint">
          When on, an automated pass only tailors and queues your <b>strongest</b> matches (fit ≥ 70%) and stops after a handful — a few sharp, tailored applications instead of a flood. This is the "20 tailored beats 100 mass" lever.
        </p>
        <label className="profile-check">
          <input type="checkbox" checked={qualityMode} disabled={!loaded} onChange={(e) => void toggleQualityMode(e.target.checked)} />
          Only pursue high-fit roles (raise the bar, cap each pass)
        </label>
      </div>

      <div className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Job discovery</p>
            <h2>Discovery filters</h2>
          </div>
        </div>
        <p className="settings-hint">
          Controls which postings are considered during each discovery run. Changes take effect on the next run.
        </p>
        <label className="settings-field">
          <span>Freshness window (days)</span>
          <input
            type="number"
            min={1}
            max={90}
            value={maxAgeDays}
            disabled={!loaded}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v) && v >= 1) setMaxAgeDays(v);
            }}
          />
        </label>
        <p className="settings-hint" style={{ marginTop: 0 }}>
          Postings older than this are skipped. Postings with no date are always kept. Default is 7 days.
        </p>
        <p className="settings-hint">
          {sourcePolicy === "defensible"
            ? "Job sources: employer ATS boards (Greenhouse, Lever, Ashby, Workday, and more) plus official job APIs. Third-party job-board scraping is off — employer boards are more reliable and respectful of each site's terms."
            : "Job sources: extended mode is on, which also searches third-party job boards. Automated searching paces like a person and respects each site's rules."}
        </p>
        <div className="settings-actions">
          <button className="button primary" type="button" onClick={save} disabled={saving || !loaded}>
            <Icon name="check" /> {saving ? "Saving…" : "Save discovery settings"}
          </button>
        </div>
      </div>

      <div className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Job search APIs</p>
            <h2>API sources</h2>
          </div>
          <span className={`score-badge${adzunaConfigured || joobleConfigured || usajobsConfigured ? " ok" : ""}`}>
            {adzunaConfigured || joobleConfigured || usajobsConfigured ? "Active" : "Not set"}
          </span>
        </div>
        <p className="settings-hint">
          Official REST APIs — no browser scraping, immune to bot-blocking. Each requires a free key.
          Results flow into the same discovery pool and are ranked alongside scraped results.
        </p>

        <p className="eyebrow" style={{ marginTop: "1rem" }}>Adzuna</p>
        <p className="settings-hint" style={{ marginTop: 0 }}>
          250 free req/day. Register at <b>developer.adzuna.com</b> — you'll get an App ID and App Key.
        </p>
        <label className="settings-field">
          <span>App ID {adzunaAppIdHint ? <em>(current {adzunaAppIdHint})</em> : null}</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={adzunaConfigured ? "Enter a new ID to replace it" : "adzuna-app-id"}
            value={adzunaAppId}
            onChange={(e) => setAdzunaAppId(e.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>App Key {adzunaAppKeyHint ? <em>(current {adzunaAppKeyHint})</em> : null}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={adzunaConfigured ? "Enter a new key to replace it" : "adzuna-app-key"}
            value={adzunaAppKey}
            onChange={(e) => setAdzunaAppKey(e.target.value)}
          />
        </label>

        <p className="eyebrow" style={{ marginTop: "1rem" }}>Jooble</p>
        <p className="settings-hint" style={{ marginTop: 0 }}>
          Free tier. Register at <b>developer.jooble.org</b> — you'll get a single partner key.
        </p>
        <label className="settings-field">
          <span>Partner key {joobleKeyHint ? <em>(current {joobleKeyHint})</em> : null}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={joobleConfigured ? "Enter a new key to replace it" : "jooble-partner-key"}
            value={joobleKey}
            onChange={(e) => setJoobleKey(e.target.value)}
          />
        </label>

        <p className="eyebrow" style={{ marginTop: "1rem" }}>USAJOBS (US federal jobs)</p>
        <p className="settings-hint" style={{ marginTop: 0 }}>
          Free. Register at <b>developer.usajobs.gov</b> with your email — you'll get an API key.
        </p>
        <label className="settings-field">
          <span>API key {usajobsKeyHint ? <em>(current {usajobsKeyHint})</em> : null}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={usajobsConfigured ? "Enter a new key to replace it" : "usajobs-api-key"}
            value={usajobsKey}
            onChange={(e) => setUsajobsKey(e.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>Registered email {usajobsEmailHint ? <em>(current {usajobsEmailHint})</em> : null}</span>
          <input
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="you@example.com"
            value={usajobsEmail}
            onChange={(e) => setUsajobsEmail(e.target.value)}
          />
        </label>

        <div className="settings-actions">
          <button className="button primary" type="button" onClick={save} disabled={saving || !loaded}>
            <Icon name="check" /> {saving ? "Saving…" : "Save API keys"}
          </button>
        </div>
        <p className="safety-note">
          <Icon name="shield" />
          Keys are stored only on this Mac (in a private, permission-locked file) and never leave your machine.
        </p>
      </div>

      <div className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Onboarding</p>
            <h2>First-time setup</h2>
          </div>
        </div>
        <p className="settings-hint">The guided welcome screen runs automatically the first time. Re-open it any time to add your basics, résumé, LLM settings, or a target company in one place.</p>
        <div className="settings-actions">
          <button className="button secondary" type="button" onClick={() => onNavigate("welcome")}>
            <Icon name="star" /> Re-run guided setup
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Profile setup (write) ----------------------------- */

type Opt = readonly [string, string];
const YESNO_OPTS: Opt[] = [["", "—"], ["yes", "Yes"], ["no", "No"]];

function FormText({ label, value, onChange, type = "text", required }: { label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean }) {
  return (
    <label className="settings-field">
      <span>{label}{required ? " *" : ""}</span>
      <input type={type} value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function FormSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Opt[] }) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}


/* ----------------------------- Résumé ingest + facts ledger ----------------------------- */

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read the file."));
    r.readAsDataURL(file);
  });
}

function ResumeLedgerView({
  onToast,
  onReload,
  usingSample,
  pendingPreview,
  onResumePreview,
}: {
  onToast: (m: string) => void;
  onReload: () => void;
  usingSample: boolean;
  pendingPreview: ResumeImportPreview | null;
  onResumePreview: (preview: ResumeImportPreview | null) => void;
}) {
  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  // Checked = "AI parsing when available" (omit the flag; the engine's capability resolver
  // decides). Unchecked = force the offline heuristic parser.
  const [preferLlm, setPreferLlm] = useState(true);
  const [pastedText, setPastedText] = useState("");
  const [reviewForm, setReviewForm] = useState<ProfileForm | null>(null);
  const [includedFactIds, setIncludedFactIds] = useState<Set<string>>(new Set());
  const [reviewValidationErrors, setReviewValidationErrors] = useState<{ field: string; label: string; message: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch("/api/ledger", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<LedgerData>)
      .then(setLedger)
      .catch(() => setLedger(null));
  }, []);

  useEffect(() => {
    if (!pendingPreview) {
      setReviewForm(null);
      setIncludedFactIds(new Set());
      setReviewValidationErrors([]);
      return;
    }
    setReviewForm(pendingPreview.form);
    setIncludedFactIds(new Set(pendingPreview.facts.map((f) => f.id)));
    setReviewValidationErrors(pendingPreview.mapping.validationErrors);
  }, [pendingPreview?.previewId]);

  const previewResume = async (body: object, label: string) => {
    if (usingSample) {
      onToast("ApplyPilot isn't running yet — open the app and try again.");
      return;
    }
    setUploading(true);
    try {
      const r = await apiFetch("/api/resume/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, ...(preferLlm ? {} : { preferLlm: false }) }),
      });
      const d = await r.json() as ResumeImportPreview & { error?: string };
      if (!r.ok) throw new Error(d.error ?? `API ${r.status}`);
      onResumePreview(d);
      const filled = d.profileFieldsFilled ?? 0;
      onToast(`Parsed ${label}: ${d.facts.length} fact(s), ${filled} mapped profile field${filled === 1 ? "" : "s"}. Review before import.`);
    } catch (e) {
      onToast(`Resume preview failed: ${String((e as Error).message ?? e)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const contentBase64 = await fileToBase64(file);
    await previewResume({ filename: file.name, contentBase64 }, file.name);
  };

  const onPastePreview = async () => {
    const text = pastedText.trim();
    if (text.length < 20) {
      onToast("Paste the full resume text before previewing.");
      return;
    }
    await previewResume({ filename: "pasted-resume.txt", text }, "pasted text");
  };

  const setReview = (k: keyof ProfileForm, v: string | boolean | string[]) => {
    setReviewValidationErrors([]);
    setReviewForm((f) => (f ? ({ ...f, [k]: v } as ProfileForm) : f));
  };

  const togglePendingFact = (id: string) => {
    setIncludedFactIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirmImport = async () => {
    if (!pendingPreview || !reviewForm) return;
    setImporting(true);
    try {
      const r = await apiFetch("/api/resume/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          previewId: pendingPreview.previewId,
          mappedData: reviewForm,
          includedFactIds: Array.from(includedFactIds),
        }),
      });
      const d = await r.json() as LedgerData & { error?: string; validationErrors?: { field: string; label: string; message: string }[] };
      if (!r.ok) {
        if (d.validationErrors?.length) setReviewValidationErrors(d.validationErrors);
        throw new Error(d.error ?? `API ${r.status}`);
      }
      setLedger(d as LedgerData);
      onResumePreview(null);
      onReload();
      onToast(`Imported ${includedFactIds.size} resume fact${includedFactIds.size === 1 ? "" : "s"} for review.`);
    } catch (e) {
      onToast(`Import failed: ${String((e as Error).message ?? e)}`);
    } finally {
      setImporting(false);
    }
  };

  const post = async (body: object, msg?: string) => {
    try {
      const r = await apiFetch("/api/ledger", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `API ${r.status}`);
      setLedger(d as LedgerData);
      if (msg) onToast(msg);
      onReload();
    } catch (e) {
      onToast(`Update failed: ${String((e as Error).message ?? e)}`);
    }
  };

  const facts = ledger?.facts ?? [];
  const total = ledger?.summary.total ?? 0;
  const approved = ledger?.summary.approved ?? 0;
  const pending = pendingPreview;
  const pendingFacts = pending?.facts ?? [];
  const pendingMissing = pending?.mapping.missingFields ?? [];
  const pendingUncertain = pending?.mapping.uncertainFields ?? [];
  const pendingErrors = reviewValidationErrors;
  const toggle = (f: LedgerFact) => post({ setApproved: [{ id: f.id, approved: !f.approved }] });
  const remove = (id: string) => post({ remove: [id] });
  const editFact = (id: string, statement: string) => post({ edit: { id, statement } }, "Fact updated. Re-approve it to use it in a document.");
  const SECTIONS: { key: string; label: string; types: string[]; chips?: boolean }[] = [
    { key: "experience", label: "Experience", types: ["employment"] },
    { key: "skills", label: "Skills", types: ["skill"], chips: true },
    { key: "education", label: "Education", types: ["education"] },
    { key: "certs", label: "Certifications", types: ["certification"] },
    { key: "languages", label: "Languages", types: ["language"], chips: true },
    { key: "highlights", label: "Highlights", types: ["summary_point", "achievement", "metric"] },
    { key: "contact", label: "Contact", types: ["contact"] },
  ];

  return (
    <div className="focused-view">
      <div className="panel resume-hub">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Résumé</p>
            <h2>Your parsed résumé</h2>
          </div>
          <span className={`score-badge${approved > 0 ? " ok" : ""}`}>{approved}/{total} approved</span>
        </div>
        <p className="settings-hint">
          Upload your résumé and ApplyPilot breaks it into facts, grouped below. <strong>Only facts you approve</strong> can appear in a generated document — the anti-fabrication verifier blocks everything else.
        </p>

        <div className="resume-dropzone">
          <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          <div className="resume-dropzone-main">
            <span className="resume-dropzone-icon"><Icon name="upload" /></span>
            <div className="resume-dropzone-copy">
              <strong>{uploading ? "Parsing your résumé…" : pending ? "Preview another résumé" : facts.length ? "Re-upload to re-parse" : "Upload your résumé"}</strong>
              <small>PDF, DOCX, TXT, or MD — previewed before anything is saved.</small>
            </div>
            <button className="button primary" type="button" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <Icon name="upload" /> Choose file
            </button>
          </div>
          <label className="resume-ai-toggle">
            <input type="checkbox" checked={preferLlm} onChange={(e) => setPreferLlm(e.target.checked)} /> Use AI parsing for richer extraction <em>(when the AI model is available)</em>
          </label>
          <div className="resume-paste-box">
            <textarea value={pastedText} onChange={(e) => setPastedText(e.target.value)} placeholder="Paste resume text here" rows={5} />
            <button className="button secondary" type="button" disabled={uploading || pastedText.trim().length < 20} onClick={onPastePreview}>
              <Icon name="file" /> Preview pasted text
            </button>
          </div>
        </div>

        {pending && reviewForm ? (
          <section className="resume-import-review">
            <div className="resume-import-head">
              <div>
                <p className="eyebrow">Review import</p>
                <h3>{pending.filename}</h3>
              </div>
              <span className={`score-badge${pending.method === "llm" ? " ok" : ""}`}>{pending.method === "llm" ? "AI parsed" : "Local parsed"}</span>
            </div>
            <p className="settings-hint">
              Edit the mapped fields and remove any facts you do not want to import. Saving creates an unapproved facts ledger; approve facts below before using them in generated documents.
            </p>

            {pending.warnings.length ? <ResumeIssueList title="Warnings" tone="warn" items={pending.warnings.map((message) => ({ field: "warning", label: "Parser", message }))} /> : null}
            {pendingErrors.length ? <ResumeIssueList title="Needs attention" tone="error" items={pendingErrors} /> : null}
            {pendingUncertain.length ? <ResumeIssueList title="Check these" tone="warn" items={pendingUncertain.slice(0, 8)} /> : null}

            <h3 className="profile-section">Mapped profile fields</h3>
            <div className="profile-grid">
              <FormText label="Legal first name" required value={reviewForm.legalFirstName} onChange={(v) => setReview("legalFirstName", v)} />
              <FormText label="Legal last name" required value={reviewForm.legalLastName} onChange={(v) => setReview("legalLastName", v)} />
              <FormText label="Preferred name" value={reviewForm.preferredName} onChange={(v) => setReview("preferredName", v)} />
              <FormText label="Email" type="email" required value={reviewForm.email} onChange={(v) => setReview("email", v)} />
              <FormText label="Phone" required value={reviewForm.phone} onChange={(v) => setReview("phone", v)} />
              <FormText label="City" value={reviewForm.city} onChange={(v) => setReview("city", v)} />
              <FormText label="State" value={reviewForm.state} onChange={(v) => setReview("state", v)} />
              <FormText label="LinkedIn URL" value={reviewForm.linkedin} onChange={(v) => setReview("linkedin", v)} />
              <FormText label="GitHub URL" value={reviewForm.github} onChange={(v) => setReview("github", v)} />
              <FormText label="Portfolio URL" value={reviewForm.portfolio} onChange={(v) => setReview("portfolio", v)} />
              <FormText label="Target roles" value={reviewForm.targetRoles} onChange={(v) => setReview("targetRoles", v)} />
              <FormText label="Positioning summary" value={reviewForm.positioningWhatIDo} onChange={(v) => setReview("positioningWhatIDo", v)} />
            </div>

            {pendingMissing.length ? (
              <details className="resume-missing-fields">
                <summary>{pendingMissing.length} profile field{pendingMissing.length === 1 ? "" : "s"} still blank</summary>
                <ul>{pendingMissing.slice(0, 18).map((m) => <li key={`${m.field}-${m.label}`}><strong>{m.label}</strong>: {m.message}</li>)}</ul>
              </details>
            ) : null}

            <div className="resume-toolbar">
              <span>{includedFactIds.size}/{pendingFacts.length} parsed facts selected for import</span>
              <div className="resume-review-actions">
                <button className="button secondary" type="button" onClick={() => setIncludedFactIds(new Set(pendingFacts.map((f) => f.id)))}>Select all</button>
                <button className="button secondary" type="button" onClick={() => setIncludedFactIds(new Set())}>Remove all</button>
              </div>
            </div>
            <div className="resume-cards">
              {pendingFacts.map((f) => {
                const included = includedFactIds.has(f.id);
                return (
                  <article key={f.id} className={`resume-card${included ? " on" : ""}`}>
                    <label className="resume-check" aria-label={included ? "Included" : "Excluded"}>
                      <input type="checkbox" checked={included} onChange={() => togglePendingFact(f.id)} />
                    </label>
                    <p className="resume-card-text">{f.display}</p>
                  </article>
                );
              })}
            </div>

            <div className="settings-actions resume-import-actions">
              <button className="button primary" type="button" disabled={importing || !reviewForm.legalFirstName.trim() || !reviewForm.legalLastName.trim() || !reviewForm.email.trim() || !reviewForm.phone.trim()} onClick={confirmImport}>
                <Icon name="check" /> {importing ? "Importing…" : "Import reviewed résumé"}
              </button>
              <button className="button secondary" type="button" disabled={importing} onClick={() => onResumePreview(null)}>Cancel preview</button>
            </div>
          </section>
        ) : facts.length === 0 ? (
          <div className="resume-empty">
            <p>Nothing parsed yet.</p>
            <small>Upload a résumé above and your experience, skills, and education appear here as reviewable sections.</small>
          </div>
        ) : (
          <>
            <div className="apx-spread" style={{ marginBottom: "var(--ap-space-3)" }}>
              <span className="apx-metric-sub">{total} facts across {SECTIONS.filter((s) => facts.some((f) => s.types.includes(f.type))).length} sections</span>
              <button className="apx-btn apx-btn--secondary apx-btn--sm" type="button" onClick={() => post({ approveAll: true }, "Approved all facts.")}>
                <Icon name="check" /> Approve all
              </button>
            </div>

            <div className="apx-stack" style={{ gap: "var(--ap-space-4)" }}>
              {SECTIONS.map((sec) => {
                const items = facts.filter((f) => sec.types.includes(f.type));
                if (!items.length) return null;
                return (
                  <section className="apx-card" key={sec.key}>
                    <div className="apx-card-head">
                      <div><p className="apx-eyebrow">{sec.label}</p></div>
                      <span className="apx-badge apx-badge--neutral">{items.filter((i) => i.approved).length}/{items.length} approved</span>
                    </div>
                    {sec.chips ? (
                      <div className="apx-pill-row">
                        {items.map((f) => (
                          <span key={f.id} className={`apx-pill${f.approved ? " ok" : ""}`} style={{ paddingRight: 6 }}>
                            <button type="button" onClick={() => toggle(f)} style={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }} title={f.approved ? "Approved, click to unapprove" : "Click to approve"}>
                              {f.approved ? <Icon name="check" /> : null}{f.display}
                            </button>
                            <button type="button" aria-label={`Remove ${f.display}`} onClick={() => remove(f.id)} style={{ all: "unset", cursor: "pointer", color: "var(--ap-text-tertiary)", paddingLeft: 4 }}>✕</button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="apx-stack" style={{ gap: 8 }}>
                        {items.map((f) => (
                          <LedgerFactRow key={f.id} fact={f} editable={EDITABLE_FACT_TYPES.has(f.type)} onToggle={() => toggle(f)} onRemove={() => remove(f.id)} onEdit={(text) => editFact(f.id, text)} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            <div className="apx-safenote" style={{ marginTop: "var(--ap-space-4)" }}>
              <Icon name="shield" />
              <span>Generated résumés and cover letters can only restate facts you have approved here, never anything beyond them.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ResumeIssueList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "warn" | "error";
  items: { field: string; label: string; message: string }[];
}) {
  if (!items.length) return null;
  return (
    <div className={`resume-import-issues ${tone}`}>
      <strong>{title}</strong>
      <ul>
        {items.map((item, i) => (
          <li key={`${item.field}-${i}`}>
            <span>{item.label}</span>
            {item.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function factStatementValue(fact: LedgerFact): string {
  const s = fact.details?.statement;
  if (typeof s === "string" && s.trim()) return s;
  return fact.display.replace(/^\[[^\]]+\]\s*/, "");
}

/** One editable ledger fact: approve toggle, the parsed text (inline-editable for statement facts),
 *  and remove. Editing a fact re-marks it unapproved server-side so you re-confirm the correction. */
function LedgerFactRow({ fact, editable, onToggle, onRemove, onEdit }: {
  fact: LedgerFact;
  editable: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onEdit: (text: string) => void;
}) {
  const initial = factStatementValue(fact);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (!editing) setText(initial);
  }, [initial, editing]);
  return (
    <div className="apx-answer" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <input type="checkbox" checked={fact.approved} onChange={onToggle} style={{ marginTop: 3, accentColor: "var(--ap-brand)", flex: "none" }} aria-label={fact.approved ? "Approved" : "Approve"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <>
            <textarea className="apx-textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <div className="apx-row" style={{ gap: 6, marginTop: 6 }}>
              <button className="apx-btn apx-btn--primary apx-btn--sm" type="button" disabled={!text.trim()} onClick={() => { onEdit(text.trim()); setEditing(false); }}>Save</button>
              <button className="apx-btn apx-btn--ghost apx-btn--sm" type="button" onClick={() => { setText(initial); setEditing(false); }}>Cancel</button>
            </div>
          </>
        ) : (
          <p className="apx-answer-a" style={{ margin: 0 }}>{fact.display}</p>
        )}
      </div>
      {!editing ? (
        <div className="apx-row" style={{ gap: 4, flex: "none" }}>
          {editable ? <button className="apx-link-btn" type="button" onClick={() => setEditing(true)}>Edit</button> : null}
          <button className="apx-link-btn" type="button" style={{ color: "var(--ap-text-tertiary)" }} onClick={onRemove}>Remove</button>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------- Target companies + discovery ----------------------------- */

const ATS_DOT: Record<string, string> = {
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

function TargetsView({ onToast, onReload, usingSample, ui }: { onToast: (m: string) => void; onReload: () => void; usingSample: boolean; ui: Ui }) {
  const [companies, setCompanies] = useState<TargetCompany[] | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<TargetCompany | null>(null);
  const { jobs } = useDiscoveredJobs(0, 0);
  const { applications } = useApplications(0, !usingSample);
  const discovering = ui.discovering;
  const discoveryProgress = ui.discoveryProgress;

  const load = () =>
    apiFetch("/api/companies", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<{ companies: TargetCompany[] }>)
      .then((d) => setCompanies(d.companies))
      .catch(() => setCompanies([]));
  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    const u = url.trim();
    if (!u) return;
    setAdding(true);
    onToast(/lever\.co|greenhouse|ashbyhq|workdayjobs|smartrecruiters|jobvite|icims|linkedin\.com\/jobs|indeed|glassdoor|ziprecruiter|monster|dice|wellfound|angel\.co/.test(u) ? "Adding source…" : "Finding the company careers page in the background…");
    try {
      const r = await apiFetch("/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: u, ...(name.trim() ? { name: name.trim() } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `API ${r.status}`);
      onToast(`Added ${d.company.name} [${d.company.atsType}]${d.via !== "direct" ? ` (resolved via ${d.via})` : ""}.`);
      setUrl("");
      setName("");
      await load();
      onReload();
    } catch (e) {
      onToast(String((e as Error).message ?? e));
    } finally {
      setAdding(false);
    }
  };

  const action = async (id: string, act: string, msg: string) => {
    try {
      await apiFetch("/api/companies/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action: act }) });
      await load();
      onReload();
      onToast(msg);
    } catch (e) {
      onToast(`Action failed: ${String((e as Error).message ?? e)}`);
    }
  };

  const discover = () => void ui.runDiscovery();

  const list = companies ?? [];
  const jobsFor = (cName: string) => jobs.filter((j) => j.company.toLowerCase() === cName.toLowerCase());
  const appsFor = (cName: string) => applications.filter((a) => (a.company ?? "").toLowerCase() === cName.toLowerCase());
  const lastActivityFor = (c: TargetCompany): string | null => {
    const times = [...jobsFor(c.name).map((j) => j.discoveredAt), ...appsFor(c.name).map((a) => a.createdAt), c.createdAt].filter(Boolean) as string[];
    return times.sort().at(-1) ?? null;
  };
  const enabledCount = list.filter((c) => c.enabled).length;
  const totalRoles = list.reduce((s, c) => s + (c.found ?? 0), 0);
  const appliedCompanies = list.filter((c) => appsFor(c.name).length > 0).length;

  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">Where to search</p>
          <h1>Target companies</h1>
          <p>Employers ApplyPilot searches for roles that fit your résumé. Click a company for its roles, scores, and application status.</p>
        </div>
        <div className="apx-page-actions">
          {discovering ? (
            <button className="apx-btn apx-btn--danger" type="button" disabled={ui.stopping} onClick={() => ui.stopAll()}><Icon name="stop" /> Stop</button>
          ) : (
            <button className="apx-btn apx-btn--primary" type="button" disabled={ui.taskActive} onClick={discover}><Icon name="spark" /> Run discovery</button>
          )}
        </div>
      </div>

      <div className="apx-grid apx-grid-4">
        <StatCard label="Companies" value={list.length} sub={`${enabledCount} active`} icon={<Icon name="board" />} tone="brand" />
        <StatCard label="Roles found" value={totalRoles} sub="across all targets" icon={<Icon name="search" />} tone="blue" />
        <StatCard label="Applied to" value={appliedCompanies} sub="companies with an application" icon={<Icon name="send" />} tone="teal" />
        <StatCard label="ATS types" value={new Set(list.map((c) => c.atsType)).size} sub="distinct boards" icon={<Icon name="file" />} tone="amber" />
      </div>

      {discovering ? (
        <div className="apx-live is-active kind-discovering is-full" role="status" aria-live="polite">
          <span className="apx-live-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg><span className="apx-live-dot" /></span>
          <div className="apx-live-main"><strong className="apx-live-stage">{discoveryProgress.message || "Searching company boards…"}</strong>{discoveryProgress.log[0] ? <span className="apx-live-detail">{discoveryProgress.log[0]}</span> : null}</div>
        </div>
      ) : null}

      <section className="apx-card">
        <div className="apx-card-head"><div><p className="apx-eyebrow">Add a target</p></div></div>
        <div className="apx-field-grid">
          <label className="apx-field is-wide"><span>Company homepage or board URL</span><input className="apx-input" type="url" placeholder="https://company.com or an ATS board URL" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} /></label>
          <label className="apx-field"><span>Name <em style={{ fontWeight: 400, fontStyle: "normal", color: "var(--ap-text-tertiary)" }}>(optional)</em></span><input className="apx-input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <div style={{ marginTop: 12 }}><button className="apx-btn apx-btn--secondary apx-btn--sm" type="button" disabled={adding || !url.trim()} onClick={add}>{adding ? "Adding…" : "Add company"}</button></div>
      </section>

      {list.length === 0 ? (
        <EmptyState icon={<Icon name="board" />} title="No target companies yet" message="Run discovery to auto-pick employers from your résumé, or add one above." />
      ) : (
        <section className="apx-card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="apx-applist">
            {list.map((c) => {
              const roles = jobsFor(c.name);
              const apps = appsFor(c.name);
              const la = lastActivityFor(c);
              return (
                <button key={c.id} type="button" className="apx-app-row" onClick={() => setSelected(c)}>
                  <span className="apx-avatar sm" style={{ background: atsColor(c.atsType) }}>{(c.name[0] ?? "?").toUpperCase()}</span>
                  <div className="apx-app-main">
                    <div className="apx-app-line"><strong>{c.name}</strong>{!c.enabled ? <span className="apx-tag">paused</span> : null}</div>
                    <span className="apx-app-meta">{capWord(c.atsType)} · {roles.length} role{roles.length === 1 ? "" : "s"} · {apps.length} application{apps.length === 1 ? "" : "s"}{la ? ` · ${relativeTime(la)}` : ""}</span>
                  </div>
                  <div className="apx-app-actions">{roles.length ? <span className="apx-badge apx-badge--neutral">{roles.length}</span> : null}<Icon name="arrow-right" /></div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="apx-safenote">
        <Icon name="shield" />
        <span>Discovery reads ATS boards and supported job-search sources. Review matches in the Review queue, then prepare each application yourself.</span>
      </div>

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        eyebrow="Target company"
        title={selected?.name ?? ""}
        subtitle={selected?.boardUrl}
        actions={selected ? (
          <>
            <button className="apx-btn apx-btn--secondary apx-btn--sm" type="button" onClick={() => { const c = selected; action(c.id, c.enabled ? "disable" : "enable", c.enabled ? "Paused" : "Enabled"); setSelected({ ...c, enabled: !c.enabled }); }}>{selected.enabled ? "Pause" : "Enable"}</button>
            <button className="apx-btn apx-btn--ghost apx-btn--sm" type="button" onClick={() => { action(selected.id, "remove", "Removed"); setSelected(null); }}>Remove</button>
          </>
        ) : null}
      >
        {selected ? <CompanyDetailBody company={selected} roles={jobsFor(selected.name)} apps={appsFor(selected.name)} lastActivity={lastActivityFor(selected)} /> : null}
      </Drawer>
    </div>
  );
}

const ATS_COLOR: Record<string, string> = { greenhouse: "var(--ap-success)", lever: "var(--ap-brand)", ashby: "var(--ap-info)", workday: "var(--ap-warning)", smartrecruiters: "var(--ap-success)", icims: "var(--ap-info)" };
function atsColor(ats: string): string {
  return ATS_COLOR[ats] ?? "var(--ap-success)";
}
function capWord(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function CompanyDetailBody({ company, roles, apps, lastActivity }: { company: TargetCompany; roles: DiscoveredJobRow[]; apps: ApplicationDetail[]; lastActivity: string | null }) {
  const topScore = roles.length ? Math.max(...roles.map((r) => r.fitPct ?? Math.round((r.score ?? 0) * 100))) : null;
  const appliedCount = apps.filter((a) => a.submitted).length;
  return (
    <>
      <dl className="apx-kv">
        <div><dt>Status</dt><dd>{company.enabled ? "Active (searched)" : "Paused"}</dd></div>
        <div><dt>Employer ATS</dt><dd>{capWord(company.atsType)}</dd></div>
        <div><dt>Board</dt><dd className="is-mono"><a href={company.boardUrl} target="_blank" rel="noreferrer">{company.boardUrl.replace(/^https?:\/\//, "")}</a></dd></div>
        <div><dt>Roles found</dt><dd>{roles.length}{topScore != null ? `, best fit ${topScore}%` : ""}</dd></div>
        <div><dt>Applications</dt><dd>{apps.length}{appliedCount ? `, ${appliedCount} submitted` : ""}</dd></div>
        <div><dt>Last activity</dt><dd className={lastActivity ? "" : "is-empty"}>{lastActivity ? relativeTime(lastActivity) : "none yet"}</dd></div>
      </dl>

      <div>
        <p className="apx-section-title">Roles targeted ({roles.length})</p>
        {roles.length ? (
          <div className="apx-stack" style={{ gap: 8 }}>
            {roles.slice(0, 20).map((r) => {
              const fit = r.fitPct ?? Math.round((r.score ?? 0) * 100);
              return (
                <div className="apx-answer" key={r.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="apx-answer-a" style={{ margin: 0, fontWeight: 600 }}>{r.title}</p>
                    {r.location ? <span className="apx-answer-note">{r.location}</span> : null}
                  </div>
                  {r.applied ? <span className="apx-badge apx-badge--success">applied</span> : null}
                  <span className="apx-badge apx-badge--brand">{fit}%</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="apx-metric-sub">No roles discovered here yet. Run discovery to scan this board.</p>
        )}
      </div>

      {apps.length ? (
        <div>
          <p className="apx-section-title">Applications ({apps.length})</p>
          <div className="apx-stack" style={{ gap: 8 }}>
            {apps.map((a) => (
              <div className="apx-answer" key={a.dedupKey} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: 1, minWidth: 0 }} className="apx-answer-a">{a.title ?? "Role"}</span>
                <StatusPill tone={a.submitted ? "success" : statusMeta(a.status).tone} pulse={statusMeta(a.status).pulse}>{a.submitted ? "Submitted" : statusMeta(a.status).label}</StatusPill>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ----------------------------- Document generation ----------------------------- */

/** ATS keyword-coverage donut. Color encodes strength but the % and counts always carry the meaning. */
function AtsRing({ percent }: { percent: number }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const tone = pct >= 70 ? "var(--ap-success)" : pct >= 40 ? "var(--ap-warning)" : "var(--ap-danger)";
  return (
    <div className="apx-ring" style={{ ["--size" as string]: "124px" }}>
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <circle className="apx-ring-track" cx="64" cy="64" r={r} strokeWidth="11" />
        <circle className="apx-ring-fill" cx="64" cy="64" r={r} strokeWidth="11" stroke={tone} strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <div className="apx-ring-center"><strong>{pct}%</strong><span>covered</span></div>
    </div>
  );
}

/** One generated document's verifier verdict — the anti-fabrication output is shown verbatim. */
function DocStatus({ label, doc }: { label: string; doc: GenerateDocSummary }) {
  if (doc.skipped) {
    return (
      <div className="apx-card apx-docstatus">
        <div className="apx-docstatus-head"><strong>{label}</strong><span className="apx-badge apx-badge--neutral">Skipped</span></div>
        {doc.skipReason ? <p className="apx-docstatus-meta">{doc.skipReason}</p> : null}
      </div>
    );
  }
  const ok = doc.eligible;
  return (
    <div className={`apx-card apx-docstatus ${ok ? "is-ok" : "is-blocked"}`}>
      <div className="apx-docstatus-head">
        <strong>{label}</strong>
        <span className={`apx-badge apx-badge--${ok ? "success" : "danger"}`}>{ok ? "Verified" : "Blocked"}</span>
      </div>
      <p className="apx-docstatus-meta">{doc.claims} claim{doc.claims === 1 ? "" : "s"} checked{doc.unsupported.length ? ` · ${doc.unsupported.length} blocked` : " · all trace to your ledger"}</p>
      {doc.unsupported.map((u, i) => (
        <div key={i} className="apx-blocked-claim">
          <span className="apx-eyebrow">Blocked — not in your ledger</span>
          <p>“{u.text}”</p>
          <em>{u.reason}</em>
        </div>
      ))}
    </div>
  );
}

function BulletStrength({ warnings }: { warnings: BulletWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="apx-card">
      <div className="apx-card-head">
        <div><p className="apx-eyebrow">Polish</p><h2 className="apx-card-title">Bullet strength</h2></div>
        <span className="apx-badge apx-badge--warning">{warnings.length} to improve</span>
      </div>
      <div className="apx-bullets">
        {warnings.map((w, i) => (
          <div key={i} className="apx-bullet">
            <span className={`apx-tag ${w.issue === "weak_opener" ? "draft" : "oneclick"}`}>{w.issue === "weak_opener" ? "Weak opener" : "No metric"}</span>
            <p className="apx-bullet-text">“{w.bullet}”</p>
            <p className="apx-bullet-fix"><Icon name="spark" /> {w.suggestion}</p>
          </div>
        ))}
      </div>
    </div>
  );
}


function GenerateView({ onToast }: { onToast: (m: string) => void }) {
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [posting, setPosting] = useState("");
  const [useLlm, setUseLlm] = useState(false);
  const [tier, setTier] = useState<"" | "A" | "B" | "C">("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);

  const generate = async () => {
    setBusy(true);
    setResult(null);
    onToast("Generating from your approved facts…");
    try {
      const r = await apiFetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company, title, location, postingText: posting, useLlm, ...(tier ? { tier } : {}) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `API ${r.status}`);
      setResult(d as GenerateResult);
      onToast(d.allEligible ? "Generated — documents pass the anti-fabrication check." : "Generated, but a claim was blocked — see below.");
    } catch (e) {
      onToast(`Generate failed: ${String((e as Error).message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  const download = async (file: ApiDownload) => {
    try {
      await downloadApiFile(file);
      onToast(`Downloaded ${file.name}.`);
    } catch (e) {
      onToast(`Download failed: ${String((e as Error).message ?? e)}`);
    }
  };

  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">Tailored documents</p>
          <h1>Document studio</h1>
          <p>Résumés and cover letters built from your <strong>approved facts only</strong>, gated by the anti-fabrication verifier — it can reorder and rephrase, but never claim anything outside your ledger.</p>
        </div>
      </div>

      <div className="apx-grid apx-grid-12">
        {/* Config */}
        <section className="apx-card col-5 apx-genform">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Target role</p><h2 className="apx-card-title">What are we tailoring to?</h2></div></div>
          <div className="apx-field-grid">
            <label className="apx-field"><span>Company</span><input className="apx-input" value={company} onChange={(e) => setCompany(e.target.value)} /></label>
            <label className="apx-field"><span>Title</span><input className="apx-input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label className="apx-field is-wide"><span>Location</span><input className="apx-input" value={location} onChange={(e) => setLocation(e.target.value)} /></label>
            <label className="apx-field is-wide"><span>Job posting</span><textarea className="apx-textarea" rows={8} value={posting} onChange={(e) => setPosting(e.target.value)} placeholder="Paste the job description here…" /></label>
            <label className="apx-field is-wide"><span>Strategy tier</span>
              <select className="apx-select apx-select-wide" value={tier} onChange={(e) => setTier(e.target.value as "" | "A" | "B" | "C")}>
                <option value="">— unset —</option>
                <option value="A">A — dream role (tailored, find a contact)</option>
                <option value="B">B — strong fit (tailored docs, apply now)</option>
                <option value="C">C — volume (skip cover letter)</option>
              </select>
            </label>
          </div>
          <label className="apx-check">
            <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} />
            <span>Use AI generation <em>(needs a configured LLM; otherwise the truthful template is used)</em></span>
          </label>
          <button className="apx-btn apx-btn--primary apx-btn--lg apx-btn--block" type="button" disabled={busy || !posting.trim()} onClick={generate}>
            {busy ? <><span className="apx-spin" /> Generating…</> : <><Icon name="spark" /> Generate documents</>}
          </button>
          <div className="apx-safenote">
            <Icon name="shield" />
            <span>A document is never submission-eligible if it states anything the verifier can't trace to an approved fact.</span>
          </div>
        </section>

        {/* Results */}
        <section className="col-7">
          {busy ? (
            <div className="apx-stack">
              <div className="apx-card apx-skel-card"><div className="apx-skel line sm" /><div className="apx-skel block" /></div>
              <div className="apx-card apx-skel-card"><div className="apx-skel line sm" /><div className="apx-skel line" /><div className="apx-skel line" /></div>
            </div>
          ) : !result ? (
            <div className="apx-card" style={{ height: "100%" }}>
              <div className="apx-empty">
                <span className="apx-empty-icon"><Icon name="file" /></span>
                <h3>Your tailored documents will appear here</h3>
                <p>Paste a job posting and generate. You'll see the submission-eligibility verdict, ATS keyword coverage, and any claims the verifier blocks.</p>
              </div>
            </div>
          ) : (
            <div className="apx-stack">
              <div className={`apx-card apx-eligible ${result.allEligible ? "is-ok" : "is-blocked"}`}>
                <span className="apx-eligible-icon"><Icon name={result.allEligible ? "check" : "shield"} /></span>
                <div>
                  <h3>{result.allEligible ? "Submission-eligible" : "A claim was blocked"}</h3>
                  <p>{result.allEligible
                    ? "Every statement traces to an approved fact in your ledger."
                    : "Approve the source fact or remove the flagged claim before this is safe to send."}</p>
                </div>
              </div>

              {result.atsGap ? (
                <div className="apx-card">
                  <div className="apx-card-head"><div><p className="apx-eyebrow">ATS keyword coverage</p><h2 className="apx-card-title">Match against the posting</h2></div></div>
                  <div className="apx-ats">
                    <AtsRing percent={result.atsGap.coveragePercent} />
                    <div className="apx-ats-body">
                      <p className="apx-metric-sub">{result.atsGap.coveredTerms.length} of {result.atsGap.requiredTerms.length} key terms matched.</p>
                      {result.atsGap.missingTerms.length > 0 ? (
                        <>
                          <span className="apx-eyebrow">Missing terms</span>
                          <div className="apx-pill-row">{result.atsGap.missingTerms.map((t) => <span key={t} className="apx-tag">{t}</span>)}</div>
                        </>
                      ) : <p className="apx-metric-sub">No required terms missing — strong keyword alignment.</p>}
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="apx-grid apx-grid-2">
                <DocStatus label="Résumé" doc={result.resume} />
                <DocStatus label="Cover letter" doc={result.coverLetter} />
              </div>

              {result.bulletWarnings && result.bulletWarnings.length > 0 ? <BulletStrength warnings={result.bulletWarnings} /> : null}

              <div className="apx-card">
                <div className="apx-card-head"><div><p className="apx-eyebrow">Output</p><h2 className="apx-card-title">Files &amp; tracker</h2></div></div>
                {result.draft ? (
                  <div className="apx-draftcard">
                    <span className="apx-badge apx-badge--success">Saved to tracker</span>
                    <div><strong>{result.draft.company || result.company}</strong><span>{result.draft.title || result.title}</span></div>
                    <p>{result.draft.applicationAnswers.length} custom answer{result.draft.applicationAnswers.length === 1 ? "" : "s"} attached for your review.</p>
                  </div>
                ) : null}
                {result.downloads?.length ? (
                  <div className="apx-downloads">
                    {result.downloads.map((file) => (
                      <button key={file.url} className="apx-btn apx-btn--secondary apx-btn--sm" type="button" onClick={() => void download(file)}>
                        <Icon name="file" /> {file.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="apx-metric-sub">Saved: {result.files.map((f) => f.split("/").pop()).join(", ")}</p>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const BAND_METER: Record<string, string> = { strong: "teal", good: "teal", stretch: "blue", weak: "amber", reject: "amber" };

function InsightsView({ onToast }: { onToast: (m: string) => void }) {
  const [report, setReport] = useState<SkillGapReport | null>(null);
  const [loading, setLoading] = useState(true);
  const { jobs } = useDiscoveredJobs(0, 0);
  const { applications } = useApplications(0, true);

  const load = () => {
    setLoading(true);
    apiFetch("/api/insights", { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<SkillGapReport>)
      .then((d) => setReport(d))
      .catch((e) => onToast(`Couldn’t load insights: ${String((e as Error).message ?? e)}`))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const maxGap = report?.topGaps[0]?.jobCount ?? 1;
  const fitOf = (j: DiscoveredJobRow) => j.fitPct ?? Math.round((j.score ?? 0) * 100);

  // Pipeline funnel, from real discovered jobs + applications.
  const sourced = jobs.length;
  const scored = jobs.filter((j) => Boolean(j.fit) || fitOf(j) > 0).length;
  const qualified = jobs.filter((j) => fitOf(j) >= 70 && j.knockouts.length === 0).length;
  const prepared = applications.length;
  const submittedCount = applications.filter((a) => a.submitted).length;
  const funnel = [
    { label: "Sourced", value: sourced },
    { label: "Scored", value: scored },
    { label: "Qualified", value: qualified },
    { label: "Prepared", value: prepared },
    { label: "Submitted", value: submittedCount },
  ];
  const funnelMax = Math.max(1, sourced, prepared);

  // Fit-score distribution.
  const bandOf = (j: DiscoveredJobRow) => { const p = fitOf(j); return p >= 85 ? "strong" : p >= 70 ? "good" : p >= 55 ? "stretch" : p >= 40 ? "weak" : "reject"; };
  const dist = (["strong", "good", "stretch", "weak", "reject"] as const).map((b) => ({ band: b, count: jobs.filter((j) => bandOf(j) === b).length }));
  const distMax = Math.max(1, ...dist.map((d) => d.count));

  // Where applications stand / stall.
  const stalls = [
    { label: "Submitted", count: applications.filter((a) => a.submitted).length },
    { label: "Awaiting review", count: applications.filter((a) => !a.submitted && /needs_review/i.test(a.status)).length },
    { label: "Paused", count: applications.filter((a) => !a.submitted && /challenge|account|paus/i.test(a.status)).length },
    { label: "Saved drafts", count: applications.filter((a) => a.source === "draft" && !a.submitted).length },
  ];

  return (
    <div className="apx-stack">
      <div className="apx-page-head">
        <div>
          <p className="apx-eyebrow">Market signal</p>
          <h1>Insights</h1>
          <p>How your pipeline performs, from sourced roles to submitted applications. Read-only, real data only.</p>
        </div>
        <div className="apx-page-actions">
          <button className="apx-btn apx-btn--secondary apx-btn--sm" type="button" onClick={load} disabled={loading}><Icon name="spark" /> {loading ? "Reading…" : "Refresh"}</button>
        </div>
      </div>

      <div className="apx-grid apx-grid-2">
        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Pipeline funnel</p><h2 className="apx-card-title">Sourced to submitted</h2></div></div>
          {sourced === 0 && prepared === 0 ? (
            <EmptyState inline icon={<Icon name="search" />} title="No pipeline yet" message="Run discovery to populate the funnel." />
          ) : (
            <div className="apx-funnel">
              {funnel.map((f) => (
                <div className="apx-funnel-row" key={f.label}>
                  <span className="apx-funnel-label">{f.label}</span>
                  <span className="apx-meter"><span style={{ width: `${Math.round((f.value / funnelMax) * 100)}%` }} /></span>
                  <b>{f.value}</b>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="apx-card">
          <div className="apx-card-head"><div><p className="apx-eyebrow">Fit quality</p><h2 className="apx-card-title">Score distribution</h2></div></div>
          {sourced === 0 ? (
            <EmptyState inline icon={<Icon name="star" />} title="No scored roles" message="Discovered roles get a fit score here." />
          ) : (
            <div className="apx-funnel">
              {dist.map((d) => (
                <div className="apx-funnel-row" key={d.band}>
                  <span className="apx-funnel-label" style={{ textTransform: "capitalize" }}>{d.band}</span>
                  <span className={`apx-meter ${BAND_METER[d.band]}`}><span style={{ width: `${Math.round((d.count / distMax) * 100)}%` }} /></span>
                  <b>{d.count}</b>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="apx-card">
        <div className="apx-card-head"><div><p className="apx-eyebrow">Where things stand</p><h2 className="apx-card-title">Application status</h2></div></div>
        {applications.length === 0 ? (
          <p className="apx-metric-sub">No applications yet. Prepared and submitted applications break down here.</p>
        ) : (
          <div className="apx-stat-strip">
            {stalls.map((s) => (<div key={s.label}><strong>{s.count}</strong><span>{s.label}</span></div>))}
          </div>
        )}
      </section>

      <section className="apx-card">
        <div className="apx-card-head"><div><p className="apx-eyebrow">Market signal</p><h2 className="apx-card-title">Skill-gap map</h2></div></div>
        <p className="apx-card-sub" style={{ margin: "0 0 14px" }}>Keywords your matched roles ask for, checked against your approved ledger.</p>
        {loading && !report ? (
          <p className="apx-metric-sub">Reading your matched roles…</p>
        ) : !report || report.jobsAnalyzed === 0 ? (
          <p className="apx-metric-sub">No roles with a full job description captured yet. Run discovery so postings carry their requirement text.</p>
        ) : (
          <>
            <p className="apx-metric-sub" style={{ marginBottom: 12 }}>Analyzed {report.jobsAnalyzed} role{report.jobsAnalyzed !== 1 ? "s" : ""} with a full description.</p>
            {report.topGaps.length === 0 ? (
              <p className="apx-metric-sub">No gaps. Your ledger covers what these roles ask for.</p>
            ) : (
              <div className="apx-stack" style={{ gap: 7 }}>
                {report.topGaps.map((g) => (
                  <div key={g.term} style={{ display: "grid", gridTemplateColumns: "minmax(90px,160px) 1fr 28px", alignItems: "center", gap: 10 }}>
                    <span className="apx-td-ellipsis" style={{ fontSize: "var(--ap-text-sm)" }} title={g.term}>{g.term}</span>
                    <span className="apx-meter amber"><span style={{ width: `${Math.round((g.jobCount / maxGap) * 100)}%` }} /></span>
                    <b style={{ fontVariantNumeric: "tabular-nums", textAlign: "right", fontSize: "var(--ap-text-sm)" }}>{g.jobCount}</b>
                  </div>
                ))}
              </div>
            )}
            {report.topMatched.length > 0 ? (
              <>
                <p className="apx-section-title" style={{ marginTop: 16 }}>Working for you</p>
                <div className="apx-pill-row">{report.topMatched.map((m) => <span key={m.term} className="apx-pill ok">{m.term}<em style={{ fontStyle: "normal", marginLeft: 5, opacity: 0.7 }}>{m.jobCount}</em></span>)}</div>
              </>
            ) : null}
          </>
        )}
      </section>

      <div className="apx-safenote">
        <Icon name="shield" />
        <span>Read-only. Insights never change a fact or a document, they just show you where to aim.</span>
      </div>
    </div>
  );
}


const VIA_DOT: Record<string, string> = {
  Greenhouse: "teal",
  Lever: "coral",
  Ashby: "blue",
  Workday: "yellow",
  Smartrecruiters: "teal",
  Jobvite: "coral",
  Icims: "blue",
  Linkedin: "blue",
  Indeed: "teal",
  Glassdoor: "yellow",
  Ziprecruiter: "coral",
  Monster: "yellow",
  Dice: "blue",
  Wellfound: "teal",
  Angellist: "coral",
  Referral: "yellow",
};

function CoverageModal({
  open,
  coverage,
  onClose,
}: {
  open: boolean;
  coverage: DashboardState["coverage"];
  onClose: () => void;
}) {
  const searched = coverage.sources.filter((s) => s.status === "searched").length;
  return (
    <div className={`review-modal${open ? " is-open" : ""}`} aria-hidden={!open} role="dialog" aria-label="Search coverage">
      <div className="modal-scrim" onClick={onClose} />
      <section className="modal-panel coverage-modal">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Automation coverage</p>
            <h2>Where ApplyPilot searched</h2>
            <span>Career pages, ATS boards, and supported job-search sources.</span>
          </div>
          <button className="icon-button" type="button" aria-label="Close search coverage" onClick={onClose}>
            <Icon name="arrow-right" />
          </button>
        </header>

        <div className="coverage-summary">
          <article><strong>{coverage.sources.length}</strong><span>sources checked</span></article>
          <article><strong>{searched}</strong><span>searched</span></article>
          <article><strong>{coverage.sources.reduce((n, s) => n + s.found, 0)}</strong><span>roles found</span></article>
        </div>

        <div className="coverage-list">
          {coverage.sources.map((s) => (
            <article key={s.name + (s.url ?? "")} className={`coverage-source${s.status === "blocked" ? " is-blocked" : ""}`}>
              <span className={`company-dot ${VIA_DOT[s.via] ?? "teal"}`} />
              <div className="coverage-source-main">
                <strong>{s.name}</strong>
                <small>{s.url ?? "Personal network"}</small>
              </div>
              <span className="coverage-via">{s.via}</span>
              <span className={`coverage-status ${s.status}`}>
                {s.status === "blocked" ? "blocked" : s.status === "queued" ? "queued" : `${s.found} found`}
              </span>
              <span className="coverage-time">{s.lastChecked}</span>
            </article>
          ))}
        </div>

        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
