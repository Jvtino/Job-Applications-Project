import type { ReactNode } from "react";

export type MetricTone = "brand" | "teal" | "blue" | "amber";

/** A single headline metric. When `onClick` is set it renders as a keyboard-accessible button that
 *  opens the relevant detail; `active` marks the currently-filtered metric. */
export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = "brand",
  onClick,
  active,
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: MetricTone;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}) {
  const inner = (
    <>
      <div className="apx-metric-top">
        <span className="apx-metric-label">{label}</span>
        {icon ? <span className={`apx-metric-icon ${tone}`}>{icon}</span> : null}
      </div>
      <span className="apx-metric-value">{value}</span>
      {sub ? <span className="apx-metric-sub">{sub}</span> : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={`apx-card apx-metric is-interactive${active ? " is-active" : ""}`}
        onClick={onClick}
        title={title}
        aria-pressed={active}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={`apx-card apx-metric${active ? " is-active" : ""}`} title={title}>
      {inner}
    </div>
  );
}
