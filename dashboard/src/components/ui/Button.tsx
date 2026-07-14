import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "compact";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  children: ReactNode;
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "ap-btn ap-btn--primary",
  secondary: "ap-btn ap-btn--secondary",
  ghost: "ap-btn ap-btn--ghost",
  danger: "ap-btn ap-btn--danger",
  compact: "ap-btn ap-btn--compact",
};

/** Design-system button primitive. */
export function Button({ variant = "primary", loading, className, children, disabled, ...rest }: ButtonProps) {
  const cls = [VARIANT_CLASS[variant], loading ? "is-loading" : "", className].filter(Boolean).join(" ");
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="ap-spinner" aria-hidden="true" /> : null}
      <span className="btn-label">{children}</span>
    </button>
  );
}
