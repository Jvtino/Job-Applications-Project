import { useElapsed } from "./format";

/** Normalized live-activity payload. Built by deriveLiveActivity() from real engine telemetry only
 *  (automation progress + the active apply session). Never fabricate an `active: true` here. */
export interface LiveActivityData {
  active: boolean;
  kind: "filling" | "tailoring" | "discovering" | "idle";
  /** Short stage label, e.g. "Filling application". */
  stageLabel: string;
  /** Longer detail line from the engine (currentStepLabel / message). */
  detail?: string;
  company?: string;
  role?: string;
  startedAt?: string | null;
  /** 0..100 when the engine reports progress, else null. */
  percent?: number | null;
  /** Shown when idle, e.g. "Last run finished 9:42 PM". */
  idleHint?: string;
}

export const IDLE_ACTIVITY: LiveActivityData = { active: false, kind: "idle", stageLabel: "Pipeline idle" };

function KindIcon({ kind }: { kind: LiveActivityData["kind"] }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "filling")
    return (
      <svg {...common}>
        <path d="M5 4h9l5 5v11a0 0 0 0 1 0 0H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
        <path d="M14 4v5h5M8 13h6M8 17h4" />
      </svg>
    );
  if (kind === "tailoring")
    return (
      <svg {...common}>
        <path d="M12 3v6M12 3l-3 3M12 3l3 3" />
        <rect x="4" y="9" width="16" height="12" rx="2" />
        <path d="M8 14h8" />
      </svg>
    );
  if (kind === "discovering")
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9v6M15 9v6" />
    </svg>
  );
}

/**
 * Shared "is the pipeline filling a form right now" indicator. The SAME component renders on the
 * Dashboard (variant="full") and the Review Queue (variant="inline"); there is no second variant.
 * It only reflects real telemetry passed in; it never triggers anything.
 */
export function LiveActivity({
  data,
  variant = "full",
  onClick,
}: {
  data: LiveActivityData;
  variant?: "full" | "inline";
  onClick?: () => void;
}) {
  const elapsed = useElapsed(data.active ? data.startedAt : null);

  if (!data.active) {
    return (
      <div className={`apx-live is-idle is-${variant}`}>
        <span className="apx-live-dot is-idle" aria-hidden="true" />
        <div className="apx-live-main">
          <strong className="apx-live-stage">Nothing filling right now</strong>
          {data.idleHint ? <span className="apx-live-detail">{data.idleHint}</span> : null}
        </div>
      </div>
    );
  }

  const who = [data.role, data.company].filter(Boolean).join(" at ");
  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`apx-live is-active is-${variant} kind-${data.kind}${onClick ? " is-clickable" : ""}`}
      onClick={onClick}
    >
      <span className="apx-live-icon" aria-hidden="true">
        <KindIcon kind={data.kind} />
        <span className="apx-live-dot" />
      </span>
      <div className="apx-live-main">
        <div className="apx-live-top">
          <strong className="apx-live-stage">{data.stageLabel}</strong>
          {elapsed ? <span className="apx-live-elapsed">{elapsed}</span> : null}
        </div>
        {who ? <span className="apx-live-who">{who}</span> : null}
        {data.detail && variant === "full" ? <span className="apx-live-detail">{data.detail}</span> : null}
        {typeof data.percent === "number" && data.percent > 0 ? (
          <div className="apx-meter thin" style={{ marginTop: 8 }}>
            <span style={{ width: `${Math.min(100, Math.max(0, data.percent))}%` }} />
          </div>
        ) : null}
      </div>
    </Tag>
  );
}
