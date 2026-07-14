import type { HTMLAttributes, ReactNode } from "react";

type Tone = "default" | "ok" | "live";

const TONE: Record<Tone, string> = {
  default: "ap-badge",
  ok: "ap-badge ap-badge--ok",
  live: "ap-badge ap-badge--live",
};

export function Badge({
  tone = "default",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; children: ReactNode }) {
  return (
    <span className={[TONE[tone], "score-badge", tone === "ok" ? "ok" : "", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </span>
  );
}
