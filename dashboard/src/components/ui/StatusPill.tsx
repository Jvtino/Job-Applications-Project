import type { ReactNode } from "react";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";

const BADGE: Record<StatusTone, string> = {
  neutral: "apx-badge--neutral",
  info: "apx-badge--info",
  success: "apx-badge--success",
  warning: "apx-badge--warning",
  danger: "apx-badge--danger",
  brand: "apx-badge--brand",
};

/** Semantic status pill built on the apx-badge primitive. `pulse` animates the leading dot. */
export function StatusPill({
  tone = "neutral",
  pulse,
  children,
  className,
  title,
}: {
  tone?: StatusTone;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={["apx-badge", BADGE[tone], pulse ? "is-pulsing" : "", className].filter(Boolean).join(" ")}
      title={title}
    >
      {children}
    </span>
  );
}

export interface StatusMeta {
  tone: StatusTone;
  label: string;
  pulse?: boolean;
}

/** Map a raw engine status (application/run/stage) to a tone + readable label. Single source of truth
 *  so every tab shows the same color + wording for the same state. */
export function statusMeta(status: string): StatusMeta {
  const s = (status || "").toLowerCase();
  switch (s) {
    case "submitted":
      return { tone: "success", label: "Submitted" };
    case "completed":
    case "done":
      return { tone: "success", label: "Completed" };
    case "offer":
      return { tone: "success", label: "Offer" };
    case "needs_review":
    case "needs-review":
    case "queued":
      return { tone: "warning", label: "Needs review" };
    case "challenge":
    case "paused":
      return { tone: "warning", label: "Paused" };
    case "account_required":
      return { tone: "warning", label: "Login needed" };
    case "applying":
    case "filling":
      return { tone: "info", label: "Filling form", pulse: true };
    case "tailoring":
    case "preparing_packet":
      return { tone: "info", label: "Tailoring", pulse: true };
    case "discovering":
    case "matching":
    case "running":
    case "in_progress":
      return { tone: "info", label: status === "matching" ? "Scoring" : "Searching", pulse: true };
    case "failed":
    case "error":
      return { tone: "danger", label: "Failed" };
    case "rejected":
      return { tone: "danger", label: "Rejected" };
    case "skipped":
      return { tone: "neutral", label: "Skipped" };
    case "saved":
      return { tone: "neutral", label: "Saved" };
    case "idle":
      return { tone: "neutral", label: "Idle" };
    case "applied":
      return { tone: "info", label: "Applied" };
    case "interviewing":
    case "interview":
      return { tone: "brand", label: "Interviewing" };
    default: {
      const t = s.replace(/[_-]+/g, " ").trim();
      return { tone: "neutral", label: t ? t.charAt(0).toUpperCase() + t.slice(1) : "Unknown" };
    }
  }
}

/** Convenience: render a pill straight from a raw status string. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = statusMeta(status);
  return (
    <StatusPill tone={meta.tone} pulse={meta.pulse} className={className}>
      {meta.label}
    </StatusPill>
  );
}
