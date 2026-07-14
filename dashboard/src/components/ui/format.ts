// Small formatting + time helpers shared across the redesigned tabs. No em dashes in any output.
import { useEffect, useState } from "react";

/** Human duration from milliseconds: "8s", "1m 4s", "2h 5m", "3d 2h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** Live-updating elapsed string since an ISO timestamp. Returns "" for a missing/invalid start. */
export function useElapsed(startedAt: string | null | undefined, tickMs = 1000): string {
  const [, force] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => force((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [startedAt, tickMs]);
  if (!startedAt) return "";
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return "";
  return formatDuration(Date.now() - start);
}

/** Relative time like "just now", "4m ago", "3h ago", or a short date for older items. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const past = diff >= 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return past ? `${hrs}h ago` : `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 30) return past ? `${days}d ago` : `in ${days}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Short clock label for a timestamp, e.g. "9:42 PM". Passes through already-short labels. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // already a display string like "9:42 PM"
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Title-case a snake/kebab status token for display. */
export function humanizeToken(s: string): string {
  const t = (s || "").replace(/[_-]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}
