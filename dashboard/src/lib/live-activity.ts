// Adapts the server's real LiveActivityDTO (state.liveActivity) into the presentational LiveActivityData
// the shared <LiveActivity> component renders. No fabrication: when the server says inactive, we show
// an idle state (with an honest "last run" hint when available).
import type { DashboardState } from "../data";
import { IDLE_ACTIVITY, type LiveActivityData } from "../components/ui/LiveActivity";

function lastRunHint(state: DashboardState): string | undefined {
  const r = state.lastRun;
  if (!r) return undefined;
  return `Last run ${r.at}: ${r.queued} queued, ${r.submitted} submitted.`;
}

export function liveActivityFromState(state: DashboardState): LiveActivityData {
  const a = state.liveActivity;
  if (!a || !a.active) {
    return { ...IDLE_ACTIVITY, ...(lastRunHint(state) ? { idleHint: lastRunHint(state) } : {}) };
  }
  return {
    active: true,
    kind: a.kind,
    stageLabel: a.stageLabel,
    ...(a.detail ? { detail: a.detail } : {}),
    ...(a.company ? { company: a.company } : {}),
    ...(a.role ? { role: a.role } : {}),
    startedAt: a.startedAt,
    percent: a.percent,
  };
}
