import type { HTMLAttributes, ReactNode } from "react";

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  eyebrow?: string;
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}

/** Design-system panel with optional heading. */
export function Panel({ eyebrow, title, action, className, children, ...rest }: PanelProps) {
  return (
    <div className={["ap-panel", "panel", className].filter(Boolean).join(" ")} {...rest}>
      {(eyebrow || title || action) && (
        <div className="panel-heading">
          <div>
            {eyebrow ? <p className="ap-eyebrow eyebrow">{eyebrow}</p> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
