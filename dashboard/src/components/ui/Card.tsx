import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  eyebrow?: string;
  sub?: ReactNode;
  actions?: ReactNode;
  /** Wrap children in a div with this class (handy for scroll bodies / grids). */
  bodyClassName?: string;
  children: ReactNode;
}

/** Standard surface. Header is optional; pass `actions` for a right-aligned control cluster. */
export function Card({ title, eyebrow, sub, actions, className, bodyClassName, children, ...rest }: CardProps) {
  return (
    <section className={["apx-card", className].filter(Boolean).join(" ")} {...rest}>
      {(title || eyebrow || actions) && (
        <header className="apx-card-head">
          <div>
            {eyebrow ? <p className="apx-eyebrow">{eyebrow}</p> : null}
            {title ? <h2 className="apx-card-title">{title}</h2> : null}
            {sub ? <p className="apx-card-sub">{sub}</p> : null}
          </div>
          {actions ? <div className="apx-row">{actions}</div> : null}
        </header>
      )}
      {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
    </section>
  );
}
