import type { ReactNode } from "react";
import { Logo } from "../Logo";

/** Sidebar destinations — a superset of the Chronicle tabs plus the setup tools that used to hide
 *  inside an overlay drawer. Kept as plain strings so the shell stays decoupled from App's View. */
export type ShellView =
  | "matches" | "automation" | "oneclick" | "applied"
  | "profile" | "resume" | "targets" | "generate" | "insights"
  | "rules" | "logins" | "settings" | "help";

export interface ShellStatus { running: boolean; label: string }

const TITLES: Record<ShellView, { eyebrow: string; title: string }> = {
  matches: { eyebrow: "Command center", title: "Dashboard" },
  automation: { eyebrow: "Automation", title: "Automation runs" },
  oneclick: { eyebrow: "Needs your review", title: "Review queue" },
  applied: { eyebrow: "Pipeline", title: "Applications" },
  profile: { eyebrow: "About you", title: "Profile" },
  resume: { eyebrow: "Source of truth", title: "Résumé & facts" },
  targets: { eyebrow: "Where to search", title: "Target companies" },
  generate: { eyebrow: "Tailored documents", title: "Document studio" },
  insights: { eyebrow: "Market signal", title: "Insights" },
  rules: { eyebrow: "Boundaries", title: "Automation rules" },
  logins: { eyebrow: "Saved on this device", title: "Logins" },
  settings: { eyebrow: "Workspace", title: "Settings" },
  help: { eyebrow: "Help & support", title: "Help & diagnostics" },
};

// — Inline icon set (self-contained so we don't touch the shared sprite or its type union). —
function I({ d, children }: { d?: string; children?: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d ? <path d={d} /> : children}
    </svg>
  );
}
const ICONS: Record<ShellView, ReactNode> = {
  matches: <I><rect x="3" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" /></I>,
  automation: <I><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></I>,
  oneclick: <I d="M9 12.5l2 2 4-4.5M12 3l7.5 3v5.5c0 4.6-3.2 7.3-7.5 8.5-4.3-1.2-7.5-3.9-7.5-8.5V6z" />,
  applied: <I><path d="M4 6h16M4 12h16M4 18h10" /></I>,
  profile: <I><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" /></I>,
  resume: <I><path d="M7 3h7l5 5v13a0 0 0 0 1 0 0H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></I>,
  targets: <I><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></I>,
  generate: <I><path d="M12 3v6M12 3l-3 3M12 3l3 3" /><rect x="4" y="9" width="16" height="12" rx="2" /><path d="M8 14h8M8 18h5" /></I>,
  insights: <I><path d="M4 19V5M4 19h16M8 16l3-4 3 2 4-6" /></I>,
  rules: <I><path d="M5 7h9M19 7h0M5 17h0M10 17h9" /><circle cx="16.5" cy="7" r="2.2" /><circle cx="7.5" cy="17" r="2.2" /></I>,
  logins: <I><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></I>,
  settings: <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 6.7 19a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.3 6.7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></I>,
  help: <I><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 0 1 4.6 1.3c0 1.7-2.2 2-2.2 3.6" /><path d="M12 17.5h0" /></I>,
};

interface NavGroup { label: string; items: ShellView[] }
const NAV_GROUPS: NavGroup[] = [
  { label: "Overview", items: ["matches"] },
  { label: "Pipeline", items: ["automation", "oneclick", "applied"] },
  { label: "Prepare", items: ["profile", "resume", "targets", "generate", "insights"] },
  { label: "Configure", items: ["rules", "logins", "settings", "help"] },
];

const AVATAR_BG = ["#e85d4c", "#0d9488", "#3b82f6", "#ca8a04", "#c2603f", "#5b8def"];
function avatarColor(seed: string): string {
  let n = 0;
  for (const c of seed) n += c.charCodeAt(0);
  return AVATAR_BG[n % AVATAR_BG.length]!;
}

function SunIcon() { return <I><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.4M12 19.1v2.4M4.4 4.4l1.7 1.7M17.9 17.9l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.4 19.6l1.7-1.7M17.9 6.1l1.7-1.7" /></I>; }
function MoonIcon() { return <I d="M20.5 13.4A8.3 8.3 0 1 1 10.6 3.5a6.5 6.5 0 0 0 9.9 9.9z" />; }
function BellIcon() { return <I d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 7H4c0-1 2-2 2-7zM10.5 21a2 2 0 0 0 3 0" />; }
function PlayIcon() { return <I d="M7 5.5v13l11-6.5z" />; }
function StopIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" /></svg>; }
function ClockIcon() { return <I><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></I>; }

export function AppShell({
  view, onNavigate, pendingCount, profileName, profileInitials,
  theme, onToggleTheme, status, scheduleLabel, clock,
  taskActive, stopping, onRun, onStop, hasNotifications, children,
}: {
  view: ShellView;
  onNavigate: (view: ShellView) => void;
  pendingCount: number;
  profileName: string;
  profileInitials: string;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  status: ShellStatus;
  scheduleLabel: string;
  clock: string;
  taskActive: boolean;
  stopping: boolean;
  onRun: () => void;
  onStop: () => void;
  hasNotifications?: boolean;
  children: ReactNode;
}) {
  const titles = TITLES[view] ?? { eyebrow: "Workspace", title: "ApplyPilot" };
  return (
    <div className="apx">
      <div className="apx-shell">
        <aside className="apx-sidebar">
          <button className="apx-brand" type="button" onClick={() => onNavigate("matches")} aria-label="ApplyPilot home">
            <span className="apx-brand-mark"><Logo size={34} tile /></span>
            <span>ApplyPilot<small>Local job co-pilot</small></span>
          </button>

          <nav className="apx-nav" aria-label="Primary">
            {NAV_GROUPS.map((group) => (
              <div className="apx-nav-group" key={group.label}>
                <p className="apx-nav-group-label">{group.label}</p>
                {group.items.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`apx-nav-item${view === key ? " is-active" : ""}`}
                    aria-current={view === key ? "page" : undefined}
                    onClick={() => onNavigate(key)}
                  >
                    {ICONS[key]}
                    <span>{TITLES[key].title}</span>
                    {key === "oneclick" && pendingCount > 0 ? <span className="apx-nav-badge">{pendingCount}</span> : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="apx-sidebar-foot">
            <div className="apx-privacy-row">
              <I d="M9 12.5l2 2 4-4.5M12 3l7.5 3v5.5c0 4.6-3.2 7.3-7.5 8.5-4.3-1.2-7.5-3.9-7.5-8.5V6z" />
              <span>Private by default — your data stays on this Mac</span>
            </div>
            <div className="apx-profile-chip">
              <span className="apx-avatar" style={{ background: avatarColor(profileInitials) }}>{profileInitials}</span>
              <div>
                <strong>{profileName}</strong>
                <span>Applicant profile</span>
              </div>
            </div>
          </div>
        </aside>

        <div className="apx-main">
          <header className="apx-topbar">
            <div className="apx-topbar-titles">
              <p className="apx-topbar-eyebrow">{titles.eyebrow}</p>
              <h1 className="apx-topbar-title">{titles.title}</h1>
            </div>
            <div className="apx-topbar-actions">
              <span className={`apx-status${status.running ? " is-running" : ""}`}><i />{status.label}</span>
              <button className="apx-chip-btn" type="button" onClick={() => onNavigate("rules")} title="Scheduled automation">
                <ClockIcon /> {scheduleLabel}
              </button>
              <span className="apx-clock" aria-hidden="true">{clock}</span>
              <button className="apx-chip-btn icon-only" type="button" aria-label="Notifications" onClick={() => onNavigate("automation")}>
                <BellIcon />{hasNotifications ? <span className="apx-dot" /> : null}
              </button>
              <button className="apx-chip-btn icon-only" type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={onToggleTheme}>
                {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              </button>
              <button
                className={`apx-btn ${taskActive ? "apx-btn--danger" : "apx-btn--primary"}`}
                type="button"
                onClick={taskActive ? onStop : onRun}
                disabled={stopping}
              >
                {taskActive ? <StopIcon /> : <PlayIcon />}
                {taskActive ? (stopping ? "Stopping…" : "Stop") : "Run automation"}
              </button>
            </div>
          </header>

          <main className="apx-content" key={view}>
            <div className="apx-fade">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
