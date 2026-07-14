// Turn the engine's internal audit events into language a job-seeker understands.
// The local audit log stores machine event keys (e.g. "automation.discovery.complete") and raw
// technical details ("Trace Id: …", "Discovery Ms: 270194"). The UI used to print those verbatim,
// which made a trustworthy local pipeline read like a developer console. These helpers map events to
// plain English and tuck genuinely technical fields behind an opt-in disclosure — without ever
// hiding what actually happened.

export type LogKind = "discovery" | "application" | "documents" | "review" | "account" | "schedule" | "system";

const KIND_LABEL: Record<LogKind, string> = {
  discovery: "Discovery",
  application: "Application",
  documents: "Documents",
  review: "Review",
  account: "Account",
  schedule: "Schedule",
  system: "Activity",
};

/** Classify a raw event key into a friendly kind + label, never showing the dotted key itself. */
export function humanizeAction(action?: string): { kind: LogKind; label: string } {
  const a = (action ?? "").toLowerCase();
  let kind: LogKind = "system";
  if (a.includes("discovery") || a.includes("search")) kind = "discovery";
  else if (a.startsWith("application") || a.includes("submit") || a.includes("apply")) kind = "application";
  else if (a.startsWith("documents") || a.includes("resume") || a.includes("cover")) kind = "documents";
  else if (a.startsWith("review") || a.includes("queue")) kind = "review";
  else if (a.startsWith("account") || a.includes("login")) kind = "account";
  else if (a.startsWith("schedule")) kind = "schedule";
  return { kind, label: KIND_LABEL[kind] };
}

const HUMAN_MS = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
};

const RELABEL: Record<string, string> = {
  discovery_ms: "Time taken",
  duration_ms: "Time taken",
  elapsed_ms: "Time taken",
  rescored_existing: "Re-scored",
  found: "Roles found",
  added: "Newly added",
  matches: "Matched profile",
  discovered: "Discovered",
  considered: "Considered",
  would_submit: "Ready to submit",
};

/** A single key/value detail row, or null when the field is pure plumbing the user shouldn't see. */
export function formatLogDetail(line: string): { label: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx === -1) return { label: "", value: line.trim() };
  const rawKey = line.slice(0, idx).trim();
  let value = line.slice(idx + 1).trim();
  const key = rawKey.toLowerCase().replace(/\s+/g, "_");

  // Hide opaque correlation handles — useful for support, not for the user's glance.
  if (/trace[_ ]?id|^id$|session|dedup|hash|uuid/.test(key)) return null;

  // Convert millisecond timings to readable durations.
  if (/_ms$|\bms$/.test(key)) {
    const n = Number(value.replace(/[^\d.]/g, ""));
    if (Number.isFinite(n)) value = HUMAN_MS(n);
  }
  const label = RELABEL[key] ?? rawKey.replace(/_/g, " ").replace(/\bms\b/gi, "").trim();
  return { label: label.charAt(0).toUpperCase() + label.slice(1), value };
}

/** Map the whole detail list to display rows, dropping the plumbing. */
export function humanizeDetails(details?: string[]): { label: string; value: string }[] {
  if (!details?.length) return [];
  return details.map(formatLogDetail).filter((d): d is { label: string; value: string } => d !== null);
}

const DOT_TO_TONE: Record<string, "success" | "warning" | "info" | "brand"> = {
  teal: "success",
  yellow: "warning",
  blue: "info",
  coral: "brand",
};

export function toneForDot(dot: string): "success" | "warning" | "info" | "brand" {
  return DOT_TO_TONE[dot] ?? "info";
}
