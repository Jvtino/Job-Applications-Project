// src/server/live-activity.ts
//
// Derives the dashboard "is the pipeline filling a form right now" indicator from REAL telemetry only:
//   1. an open in-app apply session (a real form is loaded + filled, paused at the review gate), or
//   2. an in-flight automation pass (automation_progress), or
//   3. a standalone discovery pass.
// Pure + side-effect free so it is unit-testable and can never fabricate an active state. This reads
// engine state; it does not touch the pipeline or submission path.

export type LiveActivityKind = "filling" | "tailoring" | "discovering" | "idle";
export type LiveActivitySource = "apply_session" | "automation_pass" | "discovery" | "none";

export interface LiveActivityDTO {
  active: boolean;
  kind: LiveActivityKind;
  stageLabel: string;
  detail: string | null;
  company: string | null;
  role: string | null;
  startedAt: string | null;
  percent: number | null;
  source: LiveActivitySource;
}

/** Snapshot of the currently-open apply session (review gate is paused, waiting on the user). */
export interface ApplySessionSnapshot {
  company: string | null;
  title: string | null;
  startedAt: string;
  needsInput: boolean;
  ready: boolean;
}

/** Subset of AutomationProgress needed to describe live state. */
export interface ProgressSnapshot {
  status: string;
  currentStepLabel: string;
  startedAt: string;
  percentComplete: number;
  completedAt: string | null;
}

export interface DiscoverySnapshot {
  running: boolean;
  message: string;
  startedAt: string | null;
}

const IDLE: LiveActivityDTO = {
  active: false,
  kind: "idle",
  stageLabel: "Pipeline idle",
  detail: null,
  company: null,
  role: null,
  startedAt: null,
  percent: null,
  source: "none",
};

const ACTIVE_PASS_STATUSES = new Set(["queued", "discovering", "matching", "preparing_packet", "applying"]);

/** Pull "<role> @ <company>" out of an automation progress label, if present. */
export function parseCurrentItem(label: string): { role: string | null; company: string | null } {
  if (!label) return { role: null, company: null };
  const m = /(?:tailoring documents for|filling|applying to|preparing)\s+(.+?)\s+@\s+(.+?)(?:\s*\(|…|\.\.\.|$)/i.exec(label);
  if (!m) return { role: null, company: null };
  const role = (m[1] ?? "").trim();
  const company = (m[2] ?? "").trim();
  return { role: role || null, company: company || null };
}

function pct(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function computeLiveActivity(input: {
  applySession?: ApplySessionSnapshot | null;
  progress?: ProgressSnapshot | null;
  discovery?: DiscoverySnapshot | null;
}): LiveActivityDTO {
  // 1. A real apply session is open: the form is loaded + filled and paused at the human gate.
  const a = input.applySession;
  if (a) {
    return {
      active: true,
      kind: "filling",
      stageLabel: a.needsInput ? "Needs your input" : a.ready ? "Ready for your review" : "Open for your review",
      detail: null,
      company: a.company,
      role: a.title,
      startedAt: a.startedAt,
      percent: null,
      source: "apply_session",
    };
  }

  // 2. An automation pass is mid-flight.
  const p = input.progress;
  if (p && !p.completedAt && ACTIVE_PASS_STATUSES.has(p.status)) {
    if (p.status === "applying" || p.status === "preparing_packet") {
      const tailoring = /tailoring/i.test(p.currentStepLabel) || p.status === "preparing_packet";
      const item = parseCurrentItem(p.currentStepLabel);
      return {
        active: true,
        kind: tailoring ? "tailoring" : "filling",
        stageLabel: tailoring ? "Tailoring documents" : "Filling application",
        detail: p.currentStepLabel || null,
        company: item.company,
        role: item.role,
        startedAt: p.startedAt,
        percent: pct(p.percentComplete),
        source: "automation_pass",
      };
    }
    return {
      active: true,
      kind: "discovering",
      stageLabel: p.status === "matching" ? "Scoring matches" : "Searching company boards",
      detail: p.currentStepLabel || null,
      company: null,
      role: null,
      startedAt: p.startedAt,
      percent: pct(p.percentComplete),
      source: "automation_pass",
    };
  }

  // 3. A standalone discovery pass.
  const d = input.discovery;
  if (d?.running) {
    return {
      active: true,
      kind: "discovering",
      stageLabel: "Searching company boards",
      detail: d.message || null,
      company: null,
      role: null,
      startedAt: d.startedAt,
      percent: null,
      source: "discovery",
    };
  }

  return IDLE;
}

export { IDLE as IDLE_LIVE_ACTIVITY };
