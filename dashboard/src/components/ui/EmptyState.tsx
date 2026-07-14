import type { ReactNode } from "react";

/** Calm empty state. Always give a real reason + (where possible) a next action, never a blank panel. */
export function EmptyState({
  icon,
  title,
  message,
  action,
  inline,
}: {
  icon?: ReactNode;
  title: string;
  message?: ReactNode;
  action?: ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={`apx-empty${inline ? " is-inline" : ""}`}>
      {icon ? <div className="apx-empty-icon">{icon}</div> : null}
      <h3>{title}</h3>
      {message ? <p>{message}</p> : null}
      {action}
    </div>
  );
}

/** Inline error surface (network/API failure), styled distinct from an empty state. */
export function ErrorState({ title, message }: { title: string; message?: ReactNode }) {
  return (
    <div className="apx-error" role="alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.01" />
      </svg>
      <div>
        <strong>{title}</strong>
        {message ? <p>{message}</p> : null}
      </div>
    </div>
  );
}
