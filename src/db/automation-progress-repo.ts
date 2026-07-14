import { randomUUID } from "node:crypto";
import type { DB } from "./database";

export type AutomationProgressStatus =
  | "idle"
  | "queued"
  | "discovering"
  | "matching"
  | "preparing_packet"
  | "applying"
  | "completed"
  | "failed"
  | "paused"
  | "needs_review";

export interface AutomationProgress {
  jobId: string;
  userId: string;
  status: AutomationProgressStatus;
  currentStepLabel: string;
  totalItems: number;
  processedItems: number;
  qualifiedCount: number;
  oneClickCount: number;
  appliedCount: number;
  failedCount: number;
  skippedCount: number;
  percentComplete: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  recentEvents: string[];
}

interface ProgressRow {
  job_id: string;
  profile_id: string;
  status: string;
  current_step_label: string;
  total_items: number;
  processed_items: number;
  qualified_count: number;
  one_click_count: number;
  applied_count: number;
  failed_count: number;
  skipped_count: number;
  percent_complete: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  error_message: string | null;
  recent_events_json: string;
}

export interface AutomationProgressPatch {
  status?: AutomationProgressStatus;
  currentStepLabel?: string;
  totalItems?: number;
  processedItems?: number;
  qualifiedCount?: number;
  oneClickCount?: number;
  appliedCount?: number;
  failedCount?: number;
  skippedCount?: number;
  percentComplete?: number;
  completedAt?: string | null;
  errorMessage?: string | null;
  event?: string;
}

const EVENT_MAX = 30;

export class AutomationProgressRepo {
  constructor(private readonly db: DB) {}

  start(profileId: string, label = "Automation queued"): AutomationProgress {
    const now = new Date().toISOString();
    const jobId = randomUUID();
    const events = [sanitizeEvent(label)];
    this.db
      .prepare(
        `INSERT INTO automation_progress (
          job_id, profile_id, status, current_step_label, total_items, processed_items,
          qualified_count, one_click_count, applied_count, failed_count, skipped_count,
          percent_complete, started_at, updated_at, completed_at, error_message, recent_events_json
        ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, NULL, NULL, ?)`
      )
      .run(jobId, profileId, "queued", label, now, now, JSON.stringify(events));
    return this.get(jobId)!;
  }

  update(jobId: string, patch: AutomationProgressPatch): AutomationProgress | null {
    const current = this.get(jobId);
    if (!current) return null;
    const next = { ...current };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.currentStepLabel !== undefined) next.currentStepLabel = patch.currentStepLabel;
    if (patch.totalItems !== undefined) next.totalItems = Math.max(0, Math.trunc(patch.totalItems));
    if (patch.processedItems !== undefined) next.processedItems = Math.max(0, Math.trunc(patch.processedItems));
    if (patch.qualifiedCount !== undefined) next.qualifiedCount = Math.max(0, Math.trunc(patch.qualifiedCount));
    if (patch.oneClickCount !== undefined) next.oneClickCount = Math.max(0, Math.trunc(patch.oneClickCount));
    if (patch.appliedCount !== undefined) next.appliedCount = Math.max(0, Math.trunc(patch.appliedCount));
    if (patch.failedCount !== undefined) next.failedCount = Math.max(0, Math.trunc(patch.failedCount));
    if (patch.skippedCount !== undefined) next.skippedCount = Math.max(0, Math.trunc(patch.skippedCount));
    if (patch.completedAt !== undefined) next.completedAt = patch.completedAt;
    if (patch.errorMessage !== undefined) next.errorMessage = patch.errorMessage ? sanitizeEvent(patch.errorMessage) : null;
    next.updatedAt = new Date().toISOString();
    next.percentComplete = patch.percentComplete !== undefined
      ? clampPercent(patch.percentComplete)
      : calculatePercent(next.status, next.totalItems, next.processedItems);
    if (patch.event) {
      const clean = sanitizeEvent(patch.event);
      next.recentEvents = [clean, ...next.recentEvents.filter((m) => m !== clean)].slice(0, EVENT_MAX);
    }
    this.write(next);
    return next;
  }

  increment(jobId: string, patch: Omit<AutomationProgressPatch, "processedItems" | "qualifiedCount" | "oneClickCount" | "appliedCount" | "failedCount" | "skippedCount"> & {
    processedItems?: number;
    qualifiedCount?: number;
    oneClickCount?: number;
    appliedCount?: number;
    failedCount?: number;
    skippedCount?: number;
  }): AutomationProgress | null {
    const current = this.get(jobId);
    if (!current) return null;
    return this.update(jobId, {
      ...patch,
      processedItems: current.processedItems + (patch.processedItems ?? 0),
      qualifiedCount: current.qualifiedCount + (patch.qualifiedCount ?? 0),
      oneClickCount: current.oneClickCount + (patch.oneClickCount ?? 0),
      appliedCount: current.appliedCount + (patch.appliedCount ?? 0),
      failedCount: current.failedCount + (patch.failedCount ?? 0),
      skippedCount: current.skippedCount + (patch.skippedCount ?? 0),
    });
  }

  complete(jobId: string, patch: Omit<AutomationProgressPatch, "status" | "completedAt" | "percentComplete"> = {}): AutomationProgress | null {
    const current = this.get(jobId);
    const status: AutomationProgressStatus = current && current.oneClickCount > 0 ? "needs_review" : "completed";
    return this.update(jobId, {
      ...patch,
      status,
      currentStepLabel: patch.currentStepLabel ?? (status === "needs_review" ? "Automation completed; review required" : "Automation completed"),
      completedAt: new Date().toISOString(),
      percentComplete: 100,
      event: patch.event ?? "Automation completed",
    });
  }

  fail(jobId: string, error: unknown): AutomationProgress | null {
    const message = safeErrorMessage(error);
    return this.update(jobId, {
      status: "failed",
      currentStepLabel: "Automation failed",
      completedAt: new Date().toISOString(),
      errorMessage: message,
      event: `Automation failed: ${message}`,
    });
  }

  get(jobId: string): AutomationProgress | null {
    const row = this.db.prepare("SELECT * FROM automation_progress WHERE job_id = ?").get(jobId) as ProgressRow | undefined;
    return row ? toProgress(row) : null;
  }

  getLatest(profileId: string): AutomationProgress | null {
    const row = this.db
      .prepare("SELECT * FROM automation_progress WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(profileId) as ProgressRow | undefined;
    return row ? toProgress(row) : null;
  }

  /** Past automation passes, newest first (one row per pass). Read-only run history. */
  list(profileId: string, limit = 50): AutomationProgress[] {
    const rows = this.db
      .prepare("SELECT * FROM automation_progress WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(profileId, Math.max(1, Math.min(200, Math.trunc(limit)))) as ProgressRow[];
    return rows.map(toProgress);
  }

  idle(profileId: string): AutomationProgress {
    const now = new Date().toISOString();
    return {
      jobId: "",
      userId: profileId,
      status: "idle",
      currentStepLabel: "Automation is idle",
      totalItems: 0,
      processedItems: 0,
      qualifiedCount: 0,
      oneClickCount: 0,
      appliedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      percentComplete: 0,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      errorMessage: null,
      recentEvents: [],
    };
  }

  private write(progress: AutomationProgress): void {
    this.db
      .prepare(
        `UPDATE automation_progress SET
          status = @status,
          current_step_label = @current_step_label,
          total_items = @total_items,
          processed_items = @processed_items,
          qualified_count = @qualified_count,
          one_click_count = @one_click_count,
          applied_count = @applied_count,
          failed_count = @failed_count,
          skipped_count = @skipped_count,
          percent_complete = @percent_complete,
          updated_at = @updated_at,
          completed_at = @completed_at,
          error_message = @error_message,
          recent_events_json = @recent_events_json
         WHERE job_id = @job_id`
      )
      .run({
        job_id: progress.jobId,
        status: progress.status,
        current_step_label: progress.currentStepLabel,
        total_items: progress.totalItems,
        processed_items: progress.processedItems,
        qualified_count: progress.qualifiedCount,
        one_click_count: progress.oneClickCount,
        applied_count: progress.appliedCount,
        failed_count: progress.failedCount,
        skipped_count: progress.skippedCount,
        percent_complete: progress.percentComplete,
        updated_at: progress.updatedAt,
        completed_at: progress.completedAt,
        error_message: progress.errorMessage,
        recent_events_json: JSON.stringify(progress.recentEvents),
      });
  }
}

function toProgress(row: ProgressRow): AutomationProgress {
  return {
    jobId: row.job_id,
    userId: row.profile_id,
    status: row.status as AutomationProgressStatus,
    currentStepLabel: row.current_step_label,
    totalItems: row.total_items,
    processedItems: row.processed_items,
    qualifiedCount: row.qualified_count,
    oneClickCount: row.one_click_count,
    appliedCount: row.applied_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    percentComplete: row.percent_complete,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    recentEvents: parseEvents(row.recent_events_json),
  };
}

function parseEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function calculatePercent(status: AutomationProgressStatus, total: number, processed: number): number {
  if (status === "completed" || status === "needs_review") return 100;
  if (status === "failed" || status === "paused") return total > 0 ? clampPercent((processed / total) * 100) : 0;
  if (total <= 0) return 0;
  return clampPercent((processed / total) * 100);
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function sanitizeEvent(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeEvent(message || "unknown error");
}
