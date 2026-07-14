import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform, release } from "node:os";

export type ErrorSource = "api" | "frontend" | "process" | "automation" | "apply" | "schedule" | "unknown";
export type ErrorSeverity = "info" | "warning" | "error" | "fatal";

export interface ErrorReportInput {
  source: ErrorSource;
  severity?: ErrorSeverity;
  message: string;
  name?: string;
  stack?: string;
  context?: Record<string, unknown>;
  tags?: string[];
}

export interface ErrorReport extends ErrorReportInput {
  id: string;
  createdAt: string;
  app: "ApplyPilot";
  runtime: {
    node: string;
    platform: string;
    release: string;
    pid: number;
  };
  context?: Record<string, unknown>;
}

const SECRET_KEY_RE = /(token|secret|password|api[_-]?key|authorization|cookie|session|credential)/i;
const MAX_STRING = 8_000;
const STACK_MAX = 16_000;

/**
 * Ordered PII/secret scrubbers applied to every free-text field an error report persists (message,
 * name, stack, and context string values). Error messages and stacks routinely embed the failing
 * value (emails, phones), the OS username (`/Users/<name>/…`, `/home/<name>/…`), or a Bearer/sk- token
 * — none of which the old key-based redaction caught. Every pattern here is linear-time (fixed-count
 * quantifiers or negated character classes, no nesting/backtracking) so scanning attacker-influenced
 * text cannot ReDoS. Best-effort by design: it can miss unlabeled names or novel formats, which is why
 * any future crash-report UPLOAD must be opt-in and show the user the scrubbed payload first (M7).
 */
const SCRUBBERS: { re: RegExp; to: string }[] = [
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, to: "Bearer [redacted]" },
  { re: /sk-[A-Za-z0-9_-]{12,}/g, to: "sk-[redacted]" },
  { re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g, to: "[email]" },
  { re: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, to: "[phone]" },
  { re: /(\/Users\/)[^/\s]+/g, to: "$1[user]" },
  { re: /(\/home\/)[^/\s]+/g, to: "$1[user]" },
  { re: /([A-Za-z]:\\Users\\)[^\\/\s]+/g, to: "$1[user]" },
];

/** Strip emails / phones / home-dir usernames / bearer & sk- tokens from a free-text string. */
export function scrubText(value: string): string {
  let out = value;
  for (const { re, to } of SCRUBBERS) out = out.replace(re, to);
  return out;
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 90);
}

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const scrubbed = scrubText(value);
    return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}... [truncated]` : scrubbed;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redact(item));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    out[k] = redact(v, k);
  }
  return out;
}

function reportFromError(source: ErrorSource, err: unknown, context?: Record<string, unknown>): ErrorReportInput {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    source,
    severity: source === "process" ? "fatal" : "error",
    name: e.name,
    message: e.message,
    stack: e.stack,
    ...(context ? { context } : {}),
  };
}

export class ErrorReporter {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  record(input: ErrorReportInput): ErrorReport {
    mkdirSync(this.dir, { recursive: true });
    const createdAt = new Date().toISOString();
    const id = `${createdAt.replace(/[:.]/g, "-")}-${safeIdPart(randomUUID().slice(0, 8))}`;
    const report: ErrorReport = {
      id,
      createdAt,
      app: "ApplyPilot",
      source: input.source,
      severity: input.severity ?? "error",
      // message/name/stack are stored raw by every caller; scrub PII here at record time so the on-disk
      // report (and any future export/upload) is sanitized by construction, and cap the stack (M7).
      message: scrubText(String(input.message || "Unknown error")),
      ...(input.name ? { name: scrubText(String(input.name)) } : {}),
      ...(input.stack ? { stack: scrubText(String(input.stack)).slice(0, STACK_MAX) } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.context ? { context: redact(input.context) as Record<string, unknown> } : {}),
      runtime: {
        node: process.version,
        platform: platform(),
        release: release(),
        pid: process.pid,
      },
    };

    const folder = join(this.dir, safeIdPart(id));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(this.dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  recordError(source: ErrorSource, err: unknown, context?: Record<string, unknown>): ErrorReport {
    return this.record(reportFromError(source, err, context));
  }

  list(limit = 20): ErrorReport[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => {
        try { return statSync(join(this.dir, name)).isDirectory(); } catch { return false; }
      })
      .sort()
      .reverse()
      .slice(0, Math.max(1, Math.min(200, limit)))
      .flatMap((name) => {
        try {
          return [JSON.parse(readFileSync(join(this.dir, name, "report.json"), "utf8")) as ErrorReport];
        } catch {
          return [];
        }
      });
  }

  export(limit = 50): { path: string; reports: ErrorReport[]; instructions: string } {
    const reports = this.list(limit);
    const outPath = join(this.dir, "export.json");
    const payload = {
      generatedAt: new Date().toISOString(),
      instructions: "This file was scrubbed of personal details. Review it, then share it with ApplyPilot support so we can help.",
      reports,
    };
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    return { path: outPath, reports, instructions: payload.instructions };
  }


}

let processHooksInstalled = false;
export function installProcessErrorHandlers(reporter: ErrorReporter): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  process.on("unhandledRejection", (reason) => {
    reporter.recordError("process", reason, { kind: "unhandledRejection" });
  });
  process.on("uncaughtExceptionMonitor", (err) => {
    reporter.recordError("process", err, { kind: "uncaughtException" });
  });
}
