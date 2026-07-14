// src/server/api.ts
//
// The local app API. Binds to 127.0.0.1 ONLY by default, so the profile/PII/secrets it handles never
// leave this machine. Exposure to the user's Tailscale network is strictly opt-in and config-gated
// (APPLYPILOT_BIND_HOST=tailscale) with a token-ready auth seam — see ./access.ts for the bind/auth/
// CORS layer and its threat model. Reads: GET /api/state, /api/health, /api/settings. Writes: POST /api/settings (Anthropic
// key + model — the key is a secret, never returned in full), POST /api/discover for board search,
// GET /api/discovered-jobs for scored matches, and POST /api/apply for assisted fill (semi_auto only;
// never submits). The legacy continuous runner is removed from the product surface.
//
// Front-door policy (applied once, before any handler runs): routing is EXACT-PATH via the `routes`
// map below, so no endpoint can shadow another regardless of declaration order. Request bodies are
// size-capped (413) and JSON-checked (malformed -> 400); write routes validate their shape with zod.
// Unexpected failures return a generic 500 — the real error is logged server-side, never sent to the
// client (so internal detail can't leak once the tailnet seam is on).

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config";
import { getDatabase, recordAudit, type DB } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { CompaniesRepo } from "../db/companies-repo";
import { DiscoveredJobsRepo } from "../db/discovered-jobs-repo";
import { DiscoveryAuditRepo } from "../db/discovery-audit-repo";
import { AutomationProgressRepo, type AutomationProgressPatch } from "../db/automation-progress-repo";
import { ApplicationsRepo, dedupKeyForUrl } from "../db/applications-repo";
import { CredentialsVault } from "../db/credentials-vault";
import { ApplicationDraftsRepo, type ApplicationDraftStatus } from "../db/application-drafts-repo";
import { FillSnapshotsRepo } from "../db/fill-snapshots-repo";
import { createBlankProfile } from "../profile/factory";
import { resolveActiveProfile } from "../profile/active-profile";
import { approveAll, describeFact, editFactStatement, finalizeApproval, removeFact, setApproved, summarizeLedger } from "../ingestion/ledger-ops";
import { computeResumeInsights } from "../ingestion/resume-insights";
import { ResumeInsightsRepo } from "../db/resume-insights-repo";
import { normalizeBoard } from "../jobs/board-detect";
import type { DiscoveryRun } from "../finder/pipeline/discovery-run-types";
import type { ApplicantProfile } from "../types/applicant-profile";
import type { Fact, FactsLedger } from "../types/facts-ledger";
import { QUALITY_MODE_MIN_SCORE, QUALITY_MODE_MAX_TOTAL, type AutopilotRun } from "../orchestrator/autopilot";
import { inferTargetRoles } from "../jobs/role-focus";
import { computeSkillGap } from "../insights/skill-gap";
import { runSemiAutopilotPass, type SemiPassOptions } from "./autopilot-runner";
import { ingestResumeBuffer, prepareResumeImportDraft, persistResumeImportDraft, type ResumeImportDraft } from "./ingest-runner";
import { validateMappedResume } from "../ingestion/resume-mapper";
import { resolveCompanyViaBrowser, runDiscoveryPass, type CompanyResolution } from "./discovery-runner";
import { runGenerate } from "./generate-runner";
import { prepareApplicationDocs } from "../orchestrator/prepare-docs";
import {
  resolveJobSearchIntent,
  buildConfirmedIntent,
  withConfirmedIntent,
  INTENT_DYNAMIC_KEY,
  type IntentPatch,
} from "../jobs/job-search-intent";
import { intentPermissions } from "../types/job-search-intent";
import { ApplySession, resolveApplyDisplay, type ApplySessionHandle, type ApplySessionInput } from "../orchestrator/apply-session";
import {
  isActionableDiscoveredJob,
  isDisplayableDiscoveredJob,
  isBrowsableDiscoveredJob,
} from "../jobs/actionable-jobs";
import { classifyApplyCapability } from "../jobs/apply-capability";
import { buildLinkedInJobSearchUrl, buildIndeedJobSearchUrl } from "../finder/shared";
import { buildDiscoveredJobsPayload, applyCapabilityFields } from "./discovered-jobs-view";
import type { ReviewGate } from "../orchestrator/review-gate";
import { automationRunner } from "./automation-runner";
import { isDiscoveryAbortRequested, requestAllBrowserTasksStop, resetDiscoveryAbort } from "./browser-tasks";
import { wipeBrowserProfiles, browserProfileDir } from "../ats/browser";
import { browserStatus, installChromium } from "../ats/browser-provision";
import { finishDiscoveryTask, getDiscoveryTaskStatus, setDiscoveryProgress, startDiscoveryTask } from "./discovery-task";
import { readSettings, writeSettings } from "./config-store";
import { createDailyScheduler } from "./schedule";
import { getLlmClient, resetLlmClientCache } from "../llm/client";
import { getEmbeddingClient, resetEmbeddingClientCache } from "../llm/embeddings";
import { BUNDLED_MODELS, downloadModel, modelStatuses } from "../llm/model-store";
import { setLlmUsageSink } from "../llm/types";
import { aiEnabled } from "../llm/capabilities";
import { LlmCacheRepo, setDefaultLlmCache } from "../llm/cache";
import { LlmUsageRepo } from "../db/llm-usage-repo";
import { applyFormToProfile, coerceForm, profileToForm } from "./profile-form";
import { buildDashboardState } from "./dashboard-state";
import { computeLiveActivity } from "./live-activity";
import { buildRedactedSnapshot } from "./fill-snapshot";
import { ErrorReporter, installProcessErrorHandlers } from "./error-reporter";
import {
  loadAccessConfig,
  createAuthorizer,
  requiresAuth,
  corsHeadersFor,
  describeBind,
  type AccessConfig,
  type Authorizer,
} from "./access";

/** A handled error that carries the HTTP status the client should see. Thrown by validation/body
 *  helpers and mapped to its status by the single top-level catch — so the status is intentional and
 *  the message is safe to surface (unlike an unexpected throw, which becomes a generic 500). */
class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** One-line, client-safe summary of why a zod parse failed (path: message; …). No internals leaked. */
function zodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

/** Parse `raw` against `schema` at the request boundary — valid data flows inward as a typed object;
 *  anything else throws a 400 ApiError. "Parse, don't validate": handlers never re-check shapes. */
function validate<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, zodIssues(parsed.error));
  return parsed.data;
}

// Body schemas for the write routes (seed; the remaining routes still hand-check and are next to move
// over). Fields stay optional so the friendlier "X is required" messages below are preserved — zod
// guards the *types*, the explicit checks own the *required* wording.
const ApplyInput = z.object({
  url: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  /** "embedded" = fill inside the desktop app's review panel; "window" = a visible headed window. */
  display: z.enum(["embedded", "window"]).optional(),
});
const ApplyFieldInput = z.object({
  sessionId: z.string().optional(),
  ref: z.string().min(1),
  value: z.union([z.string(), z.array(z.string())]),
});
const ApplySessionRefInput = z.object({ sessionId: z.string().optional() });
const ApplyMarkSubmittedInput = z.object({
  sessionId: z.string().optional(),
  /** Fallback when the session already closed: record the manual submit for this job URL. */
  url: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  /** A10: explicit confirmation required to record a bare-URL submit on an unrecognized ATS. */
  confirm: z.boolean().optional(),
});
const ClientErrorInput = z.object({
  source: z.literal("frontend").optional(),
  severity: z.enum(["info", "warning", "error", "fatal"]).optional(),
  message: z.string().min(1),
  name: z.string().optional(),
  stack: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});
const IngestInput = z.object({
  filename: z.string().optional(),
  contentBase64: z.string().optional(),
  text: z.string().optional(),
  preferLlm: z.boolean().optional(),
});
const ResumeImportInput = z.object({
  previewId: z.string().optional(),
  mappedData: z.record(z.string(), z.unknown()).optional(),
  includedFactIds: z.array(z.string()).optional(),
});
const SettingsInput = z.object({
  apiKey: z.string().optional(),
  llmProvider: z.string().optional(),
  llmBaseUrl: z.string().optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().optional(),
  model: z.string().optional(),
  qualityMode: z.boolean().optional(),
  maxAgeDays: z.number().optional(),
  adzunaAppId: z.string().optional(),
  adzunaAppKey: z.string().optional(),
  joobleKey: z.string().optional(),
  usajobsKey: z.string().optional(),
  usajobsEmail: z.string().optional(),
});
// Daily-run schedule (commercial M9-C). Only the two fields the user controls; the pass itself is
// never configurable from the request (it is the same hard-locked semi pass as /api/autopilot).
const ScheduleInput = z.object({
  enabled: z.boolean().optional(),
  hour: z.number().int().min(0).max(23).optional(),
});
const CompaniesInput = z.object({
  url: z.string().optional(),
  name: z.string().optional(),
});
const CompanyActionInput = z.object({
  id: z.string().optional(),
  action: z.string().optional(),
  /** For the discovered-jobs "set-tier" action: "A" | "B" | "C", or "" / null to unassign. */
  tier: z.string().nullable().optional(),
});
const GenerateInput = z.object({
  company: z.string().optional(),
  title: z.string().optional(),
  location: z.string().optional(),
  postingText: z.string().optional(),
  useLlm: z.boolean().optional(),
  tier: z.string().optional(),
  postingUrl: z.string().optional(),
  jobId: z.string().optional(),
});
const ApplicationDraftActionInput = z.object({
  id: z.string().optional(),
  status: z.enum(["saved", "applied", "interviewing", "rejected", "offer"]).optional(),
});
const LedgerInput = z.object({
  approveAll: z.boolean().optional(),
  setApproved: z.array(z.object({ id: z.string().optional(), approved: z.boolean().optional() })).optional(),
  remove: z.array(z.string()).optional(),
  edit: z.object({ id: z.string(), statement: z.string() }).optional(),
});

/** Shared, UI-friendly ledger payload (facts + a one-line display + summary). */
function ledgerPayload(ledger: FactsLedger): unknown {
  return {
    approvedAt: ledger.approvedAt ?? null,
    summary: summarizeLedger(ledger),
    facts: ledger.facts.map((f) => ({
      id: f.id,
      type: f.type,
      approved: f.approved,
      display: describeFact(f),
      sourceText: f.sourceText ?? "",
      details: factDetails(f),
    })),
  };
}
const EMPTY_LEDGER = { approvedAt: null, summary: { total: 0, approved: 0, byType: {} }, facts: [] };

function factDetails(f: Fact): Record<string, unknown> {
  const details: Record<string, unknown> = { ...f };
  delete details.id;
  delete details.type;
  delete details.approved;
  delete details.sourceText;
  return details;
}

/** Per-job apply-capability fields (the discovery→apply contract), attached to every job payload so
 *  the UI can render the honest action: prefill (supported), open-manually, or unsupported. */
/** Flat counts/flags from a review gate (back-compat shape used by the apply-start response + tests). */
function flatGate(g: ReviewGate): Record<string, unknown> {
  return {
    ats: g.ats,
    accountRequired: Boolean(g.accountAction),
    challengeDetected: g.challengeDetected,
    filled: g.filled.length,
    flagged: g.flaggedForReview.length,
    needsConfirmation: g.needsConfirmation.length,
    submitControlFound: Boolean(g.submitControlRef),
    documents: g.attachedDocuments.map((d) => ({ kind: d.kind, attached: d.attached })),
  };
}

/** Full, UI-friendly serialization of the review gate — everything the in-app review screen renders. */
function serializeGate(g: ReviewGate): Record<string, unknown> {
  return {
    url: g.url,
    ats: g.ats,
    ...(g.company ? { company: g.company } : {}),
    ...(g.title ? { title: g.title } : {}),
    challengeDetected: g.challengeDetected,
    ...(g.accountAction ? { accountAction: { kind: g.accountAction.kind, domain: g.accountAction.domain } } : {}),
    filled: g.filled.map((m) => ({ label: m.field.label, value: m.resolvedValue })),
    flagged: g.flaggedForReview.map((m) => ({ label: m.field.label, value: m.resolvedValue, rationale: m.rationale })),
    // The fields the bot could NOT fill — each carries enough to render an input in the app.
    needsConfirmation: g.needsConfirmation.map((m) => ({
      ref: m.field.ref,
      label: m.field.label,
      controlType: m.field.controlType,
      required: m.field.required,
      options: m.field.options ?? [],
      risk: m.risk,
      rationale: m.rationale,
    })),
    documents: g.attachedDocuments.map((d) => ({ kind: d.kind, attached: d.attached })),
    ...(g.ledgerCheck ? { ledger: { checked: true, passed: g.ledgerCheck.passed } } : {}),
    submitControlFound: Boolean(g.submitControlRef),
    readyForOneClickSubmit: g.readyForOneClickSubmit,
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json",
  ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Serve the built dashboard (production/Electron mode). SPA fallback to index.html; no path escape. */
function serveStatic(res: ServerResponse, webRoot: string, rawUrl: string): boolean {
  const urlPath = decodeURIComponent((rawUrl.split("?")[0] || "/"));
  const candidate = resolve(webRoot, "." + (urlPath === "/" ? "/index.html" : urlPath));
  const filePath =
    candidate.startsWith(resolve(webRoot)) && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : resolve(webRoot, "index.html"); // SPA fallback (also the traversal guard)
  if (!existsSync(filePath)) return false;
  res.writeHead(200, { "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(filePath));
  return true;
}

// ~12 MB: headroom for a base64-encoded résumé upload (a few MB of PDF becomes ~1.33x as base64).
const MAX_BODY_BYTES = 12_000_000;

/** Collect + JSON-parse a request body. Empty body -> {}. Over the size cap -> 413; unparseable -> 400
 *  (both as ApiError, so the boundary fails fast instead of silently treating junk as an empty object). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        aborted = true;
        reject(new ApiError(413, "request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      if (!data) return resolveBody({});
      try {
        resolveBody(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new ApiError(400, "malformed JSON body"));
      }
    });
    req.on("error", () => {
      if (!aborted) reject(new ApiError(400, "error reading request body"));
    });
  });
}

// CORS is computed PER REQUEST from the Origin (see access.corsHeadersFor) and applied to the
// response up front via setHeader, so sendJson/serveStatic inherit it. No blanket "*": only an
// allowed origin (localhost, the tailnet, or an explicit allowlist) is reflected.
function applyCors(res: ServerResponse, headers: Record<string, string>): void {
  res.setHeader("vary", "Origin");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function downloadPayload(files: string[]): { name: string; url: string }[] {
  return files.map((file) => {
    const name = basename(file);
    return { name, url: `/api/generated?file=${encodeURIComponent(name)}` };
  });
}

function decodeResumeInput(input: z.infer<typeof IngestInput>): { filename: string; buffer: Buffer; preferLlm?: boolean } {
  const pasted = input.text?.trim();
  if (pasted) {
    return {
      filename: input.filename?.trim() || "pasted-resume.txt",
      buffer: Buffer.from(input.text ?? "", "utf8"),
      preferLlm: input.preferLlm,
    };
  }
  const filename = input.filename?.trim() ?? "";
  const contentBase64 = input.contentBase64?.trim() ?? "";
  if (!filename || !contentBase64) {
    throw new ApiError(400, "Provide a resume file or paste resume text.");
  }
  const base64 = contentBase64.includes(",") ? contentBase64.split(",").pop()! : contentBase64;
  return { filename, buffer: Buffer.from(base64, "base64"), preferLlm: input.preferLlm };
}

/** A route handler. Gets the raw url + method so handlers that branch on method (GET/POST) or read a
 *  query string keep working unchanged after the move off the prefix cascade. */
type Handler = (req: IncomingMessage, res: ServerResponse, url: string, method: string) => void | Promise<void>;

/** Path without the query string — the dispatch key. */
function pathnameOf(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

export interface ApiDeps {
  /** Override the datastore (tests inject a seeded temp DB). Defaults to the configured SQLite file. */
  db?: DB;
  encryptionKey?: Buffer;
  /** Path to the .env the Settings screen reads/writes (tests inject a temp file). */
  envPath?: string;
  /** Directory uploaded résumés are stored in (tests inject a temp dir). */
  resumesDir?: string;
  /** Injectable so tests can drive the endpoint without launching a real browser. */
  runAutopilotPass?: (db: DB, profile: ApplicantProfile, opts?: SemiPassOptions) => Promise<AutopilotRun>;
  /** Resolve a company homepage to its ATS board (tests inject a fake; real impl drives a browser). */
  resolveCompany?: (url: string, name?: string) => Promise<CompanyResolution>;
  /** Run a discovery pass (tests inject a fake; real impl drives a browser). */
  runDiscoveryFn?: (db: DB, profile: ApplicantProfile, approvedFacts: Fact[]) => Promise<DiscoveryRun>;
  /** Directory generated documents are written to (tests inject a temp dir). */
  generatedDir?: string;
  /** Directory where JSON error reports are written. Defaults beside the active SQLite DB. */
  errorsDir?: string;
  /** Start one in-app apply session (tests inject a fake; real impl opens a HEADLESS browser). */
  startApplySession?: (
    db: DB,
    profile: ApplicantProfile,
    input: ApplySessionInput
  ) => Promise<ApplySessionHandle>;
  /** Directory of the BUILT dashboard to serve at `/` (Electron/production). Dev leaves this unset. */
  webRoot?: string;
  /** Network access config (bind host(s), token, CORS allowlist). Defaults to loadAccessConfig(). */
  access?: AccessConfig;
  /** /api authorizer (tests inject; default derives from `access`). v1 allows all when no token. */
  authorize?: Authorizer;
  /** Allows the seeded demo profile to act as live state. Defaults to APPLYPILOT_DEMO_MODE. */
  demoMode?: boolean;
}

export function startApiServer(port = 5179, deps: ApiDeps = {}): Server {
  const cfg = loadConfig();
  // When a caller injects its own db (tests), it also owns the key choice — including "no key" —
  // so we don't fall back to a configured key the injected datastore wasn't written with.
  const usingInjectedDb = deps.db !== undefined;
  const db = deps.db ?? getDatabase(cfg.dbPath);
  const encryptionKey = usingInjectedDb ? deps.encryptionKey : cfg.encryptionKey;
  // `||` (not ??): a set-but-empty APPLYPILOT_ENV_PATH must fall back exactly like loadConfig does.
  const envPath = deps.envPath ?? (process.env.APPLYPILOT_ENV_PATH?.trim() || join(process.cwd(), ".env"));
  const resumesDir = deps.resumesDir ?? join(dirname(cfg.dbPath), "resumes");
  const generatedDir = deps.generatedDir ?? join(dirname(cfg.dbPath), "generated");
  const demoMode = deps.demoMode ?? cfg.demoMode;
  const defaultErrorsDir = usingInjectedDb ? join(dirname(resolve(db.name)), "errors") : join(dirname(cfg.dbPath), "errors");
  const errorsDir = deps.errorsDir ?? defaultErrorsDir;
  const errorReporter = new ErrorReporter(errorsDir);
  installProcessErrorHandlers(errorReporter);
  const activeProfile = (repo = new ProfileRepo(db, encryptionKey)): ApplicantProfile | undefined =>
    resolveActiveProfile(repo, { demoMode });
  const sendServerError = (res: ServerResponse, err: unknown, message: string, context: Record<string, unknown>): void => {
    const report = errorReporter.recordError("api", err, context);
    if (!res.headersSent) sendJson(res, 500, { error: message, errorId: report.id });
  };
  // Metering (commercial M3): providers report per-call usage events; persist them locally.
  // The sink is process-global — with multiple servers (tests) the most recent one records.
  const llmUsage = new LlmUsageRepo(db);
  setLlmUsageSink((event) => llmUsage.record(event));
  // Completion cache: expensive prompts (resume parse, generation, rerank) are content-addressed
  // in llm_cache; deep call sites reach it via the default registry. TTL-pruned at startup.
  const llmCache = new LlmCacheRepo(db);
  llmCache.prune();
  setDefaultLlmCache(llmCache);

  const automationProgress = new AutomationProgressRepo(db);
  const applyAutomationProgress = (jobId: string, patch: AutomationProgressPatch): void => {
    const countIncrement =
      (patch.processedItems ?? 0) > 0 ||
      (patch.oneClickCount ?? 0) > 0 ||
      (patch.appliedCount ?? 0) > 0 ||
      (patch.failedCount ?? 0) > 0 ||
      (patch.skippedCount ?? 0) > 0;
    const absoluteSizing = patch.totalItems !== undefined || patch.qualifiedCount !== undefined;
    if (countIncrement && !absoluteSizing) {
      automationProgress.increment(jobId, patch);
    } else {
      automationProgress.update(jobId, patch);
    }
  };
  const runPass = deps.runAutopilotPass ?? ((d, p, opts?: SemiPassOptions) => {
    // Quality mode tightens the pass to a few strong matches; it can only raise the bar, never lower it.
    const quality = readSettings(envPath).qualityMode;
    return runSemiAutopilotPass(d, p, {
      generatedDir,
      encryptionKey,
      ...(quality ? { minScore: QUALITY_MODE_MIN_SCORE, maxTotal: QUALITY_MODE_MAX_TOTAL } : {}),
      ...(opts ?? {}),
    });
  });
  const resolveCompany = deps.resolveCompany ?? ((url, name) => resolveCompanyViaBrowser(url, name, { headed: false }));
  const runDiscoveryFn = deps.runDiscoveryFn ?? ((d, p, f) => runDiscoveryPass(d, p, f, {}));
  const startApply = deps.startApplySession ?? ((d, p, input) => ApplySession.start(d, p, input));
  const webRoot = deps.webRoot ?? (process.env.APPLYPILOT_WEB_ROOT?.trim() || undefined);
  const access = deps.access ?? loadAccessConfig();
  const authorize = deps.authorize ?? createAuthorizer(access);
  const pendingResumeImports = new Map<string, { profileId: string; draft: ResumeImportDraft; createdAt: number }>();
  const RESUME_IMPORT_TTL_MS = 30 * 60_000;
  const pruneResumeImports = (): void => {
    const cutoff = Date.now() - RESUME_IMPORT_TTL_MS;
    for (const [id, pending] of pendingResumeImports) {
      if (pending.createdAt < cutoff) pendingResumeImports.delete(id);
    }
  };
  const resumePreviewPayload = (previewId: string, profileId: string, draft: ResumeImportDraft): Record<string, unknown> => ({
    ok: true,
    previewId,
    filename: draft.filename,
    format: draft.format,
    method: draft.method,
    warnings: draft.warnings,
    profileFieldsFilled: draft.profileFieldsFilled,
    form: draft.mapping.mappedData,
    mapping: draft.mapping,
    suggestedRoles: draft.suggestedRoles,
    parsedResume: draft.parsedResume,
    ...(ledgerPayload({ profileId, facts: draft.facts }) as object),
  });

  // One browser task at a time (autopilot pass, discovery, or homepage resolve). The browser session
  // is exclusive, so a second browser-driving request while one is in flight is rejected (409). A
  // lease watchdog auto-releases the flag if a task wedges, so a hung browser can't pin the app
  // forever (the timer is unref'd so it never keeps the process alive on its own).
  const BROWSER_LEASE_MS = 5 * 60_000;
  // A persistent in-app apply session holds the browser for as long as the human is answering
  // questions, so it is its OWN exclusive lock (not the short browserBusy lease). An idle TTL
  // auto-cancels it so a forgotten session can't pin the browser forever. 30 minutes: the user may
  // be working directly on the employer page (login, verification, long questions) without touching
  // the API — and closing the session never closes the visible page they're working in.
  const APPLY_TTL_MS = 30 * 60_000;
  let activeApply: { handle: ApplySessionHandle; timer: ReturnType<typeof setTimeout>; startedAt: string } | null = null;
  const closeApply = async (): Promise<void> => {
    const cur = activeApply;
    if (!cur) return;
    clearTimeout(cur.timer);
    activeApply = null;
    try {
      await cur.handle.cancel();
    } catch {
      // best-effort teardown
    }
  };
  const armApplyTtl = (handle: ApplySessionHandle): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => void closeApply(), APPLY_TTL_MS);
    timer.unref?.();
    return timer;
  };
  /** Reset the idle TTL on any session activity (a field answer, a blocked submit, …). */
  const touchApply = (): void => {
    if (!activeApply) return;
    clearTimeout(activeApply.timer);
    activeApply.timer = armApplyTtl(activeApply.handle);
  };
  /** Persist the redacted form-fill snapshot for the Applications tab. Best-effort: it never blocks or
   *  alters the apply flow, and buildRedactedSnapshot strips sensitive self-ID/work-auth values first. */
  const captureFillSnapshot = (profileId: string, gate: ReviewGate, submitted: boolean): void => {
    try {
      new FillSnapshotsRepo(db).upsert({
        profileId,
        dedupKey: dedupKeyForUrl(gate.url),
        company: gate.company ?? null,
        title: gate.title ?? null,
        url: gate.url,
        ats: gate.ats,
        submitted,
        snapshot: buildRedactedSnapshot(gate, { submitted }),
      });
    } catch (err) {
      console.error("[api] fill snapshot capture failed:", err);
    }
  };

  let browserBusy = false;
  let browserLease: ReturnType<typeof setTimeout> | undefined;
  const acquireBrowser = (): boolean => {
    if (browserBusy || activeApply) return false; // an open apply session also owns the browser
    browserBusy = true;
    browserLease = setTimeout(() => {
      browserBusy = false;
      browserLease = undefined;
    }, BROWSER_LEASE_MS);
    browserLease.unref?.();
    return true;
  };
  const releaseBrowser = (): void => {
    browserBusy = false;
    if (browserLease) {
      clearTimeout(browserLease);
      browserLease = undefined;
    }
  };

  // ── Route handlers ───────────────────────────────────────────────────────────────────────────────
  // Each owns one path. Bodies are unchanged from the previous prefix-cascade version; only dispatch
  // moved to the exact-path `routes` map. Method branching + 405s stay inside each handler.

  // Unified stop for runner + discovery.
  const handleTasksStop: Handler = (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/tasks/stop" });
      return;
    }
    req.resume();
    requestAllBrowserTasksStop();
    automationRunner.stop();
    sendJson(res, 200, {
      ok: true,
      runner: automationRunner.getStatus(),
      discoveryStopping: isDiscoveryAbortRequested(),
    });
  };

  // Continuous automation runner (legacy surface; start is now 410 Gone).
  const handleRunner: Handler = (req, res, url, method) => {
    const p = pathnameOf(url);
    if (p === "/api/runner/status" && method === "GET") {
      sendJson(res, 200, automationRunner.getStatus());
      return;
    }
    if (p === "/api/runner/stop" && method === "POST") {
      req.resume();
      automationRunner.stop();
      sendJson(res, 200, { ok: true, ...automationRunner.getStatus() });
      return;
    }
    if (p === "/api/runner/start" && method === "POST") {
      sendJson(res, 410, {
        error:
          "Continuous auto-runner removed. Run POST /api/discover, review matches in the dashboard, then POST /api/apply to prepare each application.",
      });
      return;
    }
    sendJson(res, 405, { error: "GET /api/runner/status, POST /api/runner/start or /api/runner/stop" });
  };

  // A SEMI-only autopilot pass (never submits). Shared by the manual POST /api/autopilot route and the
  // daily scheduler (commercial M9-C), so an unattended run is byte-identical to a hand-pressed one —
  // same profile check, same one-browser-at-a-time lease, same never-submit runPass. Returns a
  // discriminated result for the precondition cases (no profile / browser busy); THROWS only on a
  // genuine pass failure so each caller surfaces it its own way (HTTP 500 vs. logged + re-armed).
  type SemiPassResult =
    | { started: true; run: Awaited<ReturnType<typeof runPass>> }
    | { started: false; status: number; error: string };
  const runSemiPass = async (): Promise<SemiPassResult> => {
    const profile = activeProfile();
    if (!profile) return { started: false, status: 400, error: "No profile yet. Run `npm run setup` first." };
    if (!acquireBrowser()) return { started: false, status: 409, error: "A browser task is already running." };
    const progress = automationProgress.start(profile.id, "Automation queued");
    try {
      applyAutomationProgress(progress.jobId, {
        status: "discovering",
        currentStepLabel: "Automation Discovery: scanning job boards",
        event: "Automation Discovery started",
      });
      const run = await runPass(db, profile, {
        onProgressUpdate: (patch) => applyAutomationProgress(progress.jobId, patch),
      });
      const latest = automationProgress.get(progress.jobId);
      const fallbackTotal = run.results.length || run.submitted + run.wouldSubmit + run.queued + run.skipped;
      if (latest && latest.totalItems === 0 && fallbackTotal > 0) {
        automationProgress.update(progress.jobId, {
          totalItems: fallbackTotal,
          processedItems: fallbackTotal,
          qualifiedCount: fallbackTotal,
          oneClickCount: run.queued + run.wouldSubmit,
          appliedCount: run.submitted,
          failedCount: run.results.filter((r) => r.action === "error").length,
          skippedCount: run.skipped,
        });
      }
      if (!automationProgress.get(progress.jobId)?.completedAt) {
        automationProgress.complete(progress.jobId, {
          currentStepLabel: run.message ?? (run.queued || run.wouldSubmit ? "Automation completed; review required" : "Automation completed"),
          event: "Automation completed",
        });
      }
      return { started: true, run };
    } catch (err) {
      automationProgress.fail(progress.jobId, err);
      throw err;
    } finally {
      releaseBrowser();
    }
  };

  // The single manual state-changing route: a SEMI-only autopilot pass (never submits).
  const handleAutopilot: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "use POST to run a semi-auto pass" });
      return;
    }
    req.resume(); // drain any body; the pass is hard-locked to semi, so request input can't change it
    try {
      const outcome = await runSemiPass();
      if (!outcome.started) {
        sendJson(res, outcome.status, { error: outcome.error });
        return;
      }
      sendJson(res, 200, { ok: true, mode: "semi_auto", run: outcome.run });
    } catch (err) {
      console.error("[api] autopilot pass failed:", err);
      sendServerError(res, err, "autopilot pass failed", { method, url: "/api/autopilot" });
    }
  };

  // Daily-run scheduler (commercial M9-C). The engine owns the timer so the schedule survives dashboard
  // reloads and reports a truthful "Next run"; it re-arms from the persisted setting across restarts.
  // `fire` routes through the same never-submit runSemiPass — a skipped run (no profile / browser busy)
  // or a thrown pass is logged, never fatal, and the scheduler re-arms for the next day regardless.
  const scheduler = createDailyScheduler({
    fire: async () => {
      try {
        const outcome = await runSemiPass();
        console.log(outcome.started ? "[schedule] daily pass complete" : `[schedule] daily pass skipped: ${outcome.error}`);
      } catch (err) {
        errorReporter.recordError("schedule", err, { source: "daily-schedule" });
        console.error("[schedule] daily pass failed:", err);
      }
    },
    log: (message) => console.log(`[schedule] ${message}`),
  });

  // GET returns the persisted schedule + engine-computed next-run; POST persists enabled/hour and
  // re-arms the engine timer. The pass itself is never configurable here (see runSemiPass).
  const handleSchedule: Handler = async (req, res, _url, method) => {
    if (method === "GET") {
      const s = readSettings(envPath);
      sendJson(res, 200, { enabled: s.scheduleEnabled, hour: s.scheduleHour, nextRunAt: scheduler.nextRunAt()?.toISOString() ?? null });
      return;
    }
    if (method !== "POST") {
      sendJson(res, 405, { error: "GET or POST /api/schedule" });
      return;
    }
    // validate() throws ApiError(400) on a bad hour/type — kept outside the try so the dispatcher
    // returns 400, not a 500. Only the persist + re-arm below is a genuine server-error surface.
    const input = validate(ScheduleInput, await readJsonBody(req));
    try {
      const updated = writeSettings(envPath, {
        ...(input.enabled !== undefined ? { scheduleEnabled: input.enabled } : {}),
        ...(input.hour !== undefined ? { scheduleHour: input.hour } : {}),
      });
      scheduler.set({ enabled: updated.scheduleEnabled, hour: updated.scheduleHour });
      sendJson(res, 200, { enabled: updated.scheduleEnabled, hour: updated.scheduleHour, nextRunAt: scheduler.nextRunAt()?.toISOString() ?? null });
    } catch (err) {
      console.error("[api] schedule save failed:", err);
      sendServerError(res, err, "failed to save schedule", { method, url: "/api/schedule" });
    }
  };

  const handleAutomationProgress: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/automation/progress" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 200, { progress: null });
      return;
    }
    sendJson(res, 200, { progress: automationProgress.getLatest(profile.id) ?? automationProgress.idle(profile.id) });
  };

  // Read-only run history for the Automation Runs tab: one entry per automation pass, with its real
  // counts, timing, status, and recorded event timeline. Per-stage durations are NOT tracked by the
  // engine, so they are intentionally absent (we omit rather than invent).
  const handleRuns: Handler = (_req, res, url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/runs" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 200, { runs: [] });
      return;
    }
    const limit = Number(new URL(url, "http://local").searchParams.get("limit") ?? "50") || 50;
    const runs = automationProgress.list(profile.id, limit).map((r) => {
      const start = new Date(r.startedAt).getTime();
      const end = r.completedAt ? new Date(r.completedAt).getTime() : null;
      return {
        id: r.jobId,
        status: r.status,
        currentStepLabel: r.currentStepLabel,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        completedAt: r.completedAt,
        durationMs: end !== null && Number.isFinite(start) ? Math.max(0, end - start) : null,
        counts: {
          total: r.totalItems,
          processed: r.processedItems,
          qualified: r.qualifiedCount,
          oneClick: r.oneClickCount,
          applied: r.appliedCount,
          failed: r.failedCount,
          skipped: r.skippedCount,
        },
        errorMessage: r.errorMessage,
        events: r.recentEvents,
      };
    });
    sendJson(res, 200, { runs });
  };

  // App settings (Anthropic key + model). The key is a SECRET: GET never returns it in full.
  const handleSettings: Handler = async (req, res, _url, method) => {
    if (method === "GET") {
      sendJson(res, 200, readSettings(envPath));
      return;
    }
    if (method === "POST") {
      const input = validate(SettingsInput, await readJsonBody(req));
      try {
        const updated = writeSettings(envPath, {
          ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
          ...(input.llmProvider !== undefined ? { llmProvider: input.llmProvider } : {}),
          ...(input.llmBaseUrl !== undefined ? { llmBaseUrl: input.llmBaseUrl } : {}),
          ...(input.llmApiKey !== undefined ? { llmApiKey: input.llmApiKey } : {}),
          ...(input.llmModel !== undefined ? { llmModel: input.llmModel } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.qualityMode !== undefined ? { qualityMode: input.qualityMode } : {}),
          ...(input.maxAgeDays !== undefined ? { maxAgeDays: input.maxAgeDays } : {}),
          ...(input.adzunaAppId  !== undefined ? { adzunaAppId:  input.adzunaAppId  } : {}),
          ...(input.adzunaAppKey !== undefined ? { adzunaAppKey: input.adzunaAppKey } : {}),
          ...(input.joobleKey    !== undefined ? { joobleKey:    input.joobleKey    } : {}),
          ...(input.usajobsKey   !== undefined ? { usajobsKey:   input.usajobsKey   } : {}),
          ...(input.usajobsEmail !== undefined ? { usajobsEmail: input.usajobsEmail } : {}),
        });
        sendJson(res, 200, updated);
      } catch (err) {
        console.error("[api] settings save failed:", err);
        sendServerError(res, err, "failed to save settings", { method, url: "/api/settings" });
      }
      return;
    }
    sendJson(res, 405, { error: "GET or POST /api/settings" });
  };

  // Credential vault — the "Logins" tab. CRUD over the LOCAL, survives-app-deletion vault. GET returns
  // metadata only (never a password) plus `location` so the UI can tell the user where their logins
  // live on disk. Passwords are only ever read internally by the auto-fill path, never returned here.
  const handleLogins: Handler = async (req, res, url, method) => {
    const path = pathnameOf(url);
    try {
      const vault = new CredentialsVault();
      if (path === "/api/logins" && method === "GET") {
        return sendJson(res, 200, { location: vault.location(), logins: vault.list() });
      }
      if (path === "/api/logins" && method === "POST") {
        const body = await readJsonBody(req);
        const domain = String(body.domain ?? "").trim();
        const email = String(body.email ?? "").trim();
        if (!domain || !email) return sendJson(res, 400, { error: "domain and email are required" });
        const login = vault.set({
          domain,
          email,
          origin: "user",
          ...(body.password !== undefined ? { password: String(body.password) } : {}),
        });
        return sendJson(res, 200, { login, location: vault.location() });
      }
      if (path === "/api/logins/delete" && method === "POST") {
        const body = await readJsonBody(req);
        vault.delete(String(body.domain ?? ""));
        return sendJson(res, 200, { ok: true });
      }
      sendJson(res, 405, { error: "GET /api/logins, POST /api/logins, POST /api/logins/delete" });
    } catch (err) {
      sendServerError(res, err, "logins request failed", { method, url: path });
    }
  };

  /**
   * LLM health + bundled-model state (commercial M2). GET returns provider/mode + per-model
   * download state instantly; `?probe=1` additionally runs a tiny completion and embedding with a
   * short timeout so Settings can show real reachability instead of assuming the model works.
   */
  const handleLlmStatus: Handler = async (_req, res, url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/llm/status" });
      return;
    }
    const settings = readSettings(envPath);
    const models = modelStatuses();
    const wantProbe = new URL(url, "http://localhost").searchParams.get("probe") === "1";
    let chat: { ok: boolean; error: string | null; latencyMs: number | null } | null = null;
    let embedding: { ok: boolean; error: string | null; latencyMs: number | null } | null = null;
    if (wantProbe) {
      // First embedded call includes loading a ~1 GB model from a cold disk — the generous inner
      // timeout avoids false "not responding" on healthy installs. The OUTER deadline bounds the
      // HTTP response even if the request is stuck behind queued inference (the embedded provider
      // serializes work), where the inner timer hasn't started yet.
      chat = await probe(async () => {
        const client = getLlmClient();
        if (!client) throw new Error("no LLM configured");
        await client.complete("Reply with the single word: ok", { maxTokens: 8, timeoutMs: 45_000 });
      });
      embedding = await probe(async () => {
        const client = getEmbeddingClient();
        if (!client) throw new Error("no embedding client configured");
        await client.embed(["probe"]);
      });
    }
    sendJson(res, 200, {
      provider: settings.llmProvider,
      mode: settings.llmMode,
      model: settings.model,
      models,
      chat,
      embedding,
      usage: {
        last30Days: llmUsage.totalsSince(),
        byFeature: llmUsage.byFeatureSince(),
      },
    });
  };

  const probe = async (
    fn: () => Promise<void>,
    deadlineMs = 50_000
  ): Promise<{ ok: boolean; error: string | null; latencyMs: number | null }> => {
    const started = Date.now();
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`probe deadline (${deadlineMs}ms) exceeded — the model may be busy`)), deadlineMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return { ok: true, error: null, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: null };
    }
  };

  /** Kick off (or resume) the bundled-model downloads; progress is polled via /api/llm/status. */
  const handleLlmModelsDownload: Handler = async (_req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/llm/models/download" });
      return;
    }
    for (const model of BUNDLED_MODELS) {
      downloadModel(model)
        .then(() => {
          // A finished download makes the embedded provider usable — drop cached "missing model" clients.
          resetLlmClientCache();
          resetEmbeddingClientCache();
        })
        .catch(() => {
          /* surfaced via modelStatuses().error; retried on the next POST */
        });
    }
    sendJson(res, 202, { started: true, models: modelStatuses() });
  };

  // Profile (PII). GET returns an editable form; POST saves it (source:"user" on user input).
  const handleProfile: Handler = async (req, res, _url, method) => {
    const repo = new ProfileRepo(db, encryptionKey);
    if (method === "GET") {
      const existing = activeProfile(repo);
      sendJson(res, 200, { configured: Boolean(existing), form: profileToForm(existing ?? createBlankProfile()) });
      return;
    }
    if (method === "POST") {
      const body = await readJsonBody(req);
      try {
        const base = activeProfile(repo) ?? createBlankProfile();
        const saved = repo.save(applyFormToProfile(base, coerceForm(body)));
        sendJson(res, 200, { ok: true, configured: true, form: profileToForm(saved) });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return;
    }
    sendJson(res, 405, { error: "GET or POST /api/profile" });
  };

  const handleProfileReset: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/profile/reset" });
      return;
    }
    req.resume();
    try {
      const repo = new ProfileRepo(db, encryptionKey);
      const saved = repo.resetAll();
      if (existsSync(resumesDir)) {
        for (const name of readdirSync(resumesDir)) {
          try {
            rmSync(join(resumesDir, name), { force: true });
          } catch {
            /* best-effort — stale files are harmless */
          }
        }
      }
      sendJson(res, 200, { ok: true, configured: true, form: profileToForm(saved) });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  };

  // Résumé preview/import: upload or paste -> extract -> parse -> map -> user review -> confirmed import.
  const handleResumePreview: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST a resume file or pasted text to /api/resume/preview" });
      return;
    }
    const input = validate(IngestInput, await readJsonBody(req));
    try {
      pruneResumeImports();
      const upload = decodeResumeInput(input);
      const repo = new ProfileRepo(db, encryptionKey);
      const profile = activeProfile(repo) ?? createBlankProfile();
      const draft = await prepareResumeImportDraft(profile, upload, profileToForm(profile));
      const previewId = randomUUID();
      pendingResumeImports.set(previewId, { profileId: profile.id, draft, createdAt: Date.now() });
      sendJson(res, 200, resumePreviewPayload(previewId, profile.id, draft));
    } catch (err) {
      sendJson(res, err instanceof ApiError ? err.status : 400, { error: (err as Error).message });
    }
  };

  const handleResumeImport: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST a reviewed resume preview to /api/resume/import" });
      return;
    }
    const input = validate(ResumeImportInput, await readJsonBody(req));
    const previewId = input.previewId ?? "";
    if (!previewId) {
      sendJson(res, 400, { error: "previewId is required" });
      return;
    }
    pruneResumeImports();
    const pending = pendingResumeImports.get(previewId);
    if (!pending) {
      sendJson(res, 404, { error: "Resume import preview expired. Upload or paste the resume again." });
      return;
    }
    try {
      const repo = new ProfileRepo(db, encryptionKey);
      const base = activeProfile(repo) ?? createBlankProfile(pending.profileId);
      const form = input.mappedData ? coerceForm(input.mappedData) : pending.draft.mapping.mappedData;
      const validationErrors = validateMappedResume(pending.draft.parsedResume, form);
      if (validationErrors.length) {
        sendJson(res, 400, { error: "Fix the highlighted resume import fields before saving.", validationErrors });
        return;
      }

      const included = input.includedFactIds ? new Set(input.includedFactIds) : null;
      const facts = included ? pending.draft.facts.filter((f) => included.has(f.id)) : pending.draft.facts;
      const profile = applyFormToProfile(base, form);
      const out = persistResumeImportDraft(db, encryptionKey, profile, resumesDir, pending.draft, facts);
      pendingResumeImports.delete(previewId);
      sendJson(res, 200, {
        ok: true,
        method: pending.draft.method,
        warnings: pending.draft.warnings,
        profileFieldsFilled: pending.draft.profileFieldsFilled,
        form: profileToForm(profile),
        mapping: { ...pending.draft.mapping, mappedData: form, validationErrors },
        suggestedRoles: inferTargetRoles(profile, out.ledger.facts),
        ...(ledgerPayload(out.ledger) as object),
      });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  };

  // Legacy direct résumé ingest: upload -> parse -> ledger (facts stored UNAPPROVED). PII + untrusted file.
  const handleResumeIngest: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST a résumé to /api/resume/ingest" });
      return;
    }
    const input = validate(IngestInput, await readJsonBody(req));
    try {
      const upload = decodeResumeInput(input);
      const repo = new ProfileRepo(db, encryptionKey);
      const profile = activeProfile(repo) ?? createBlankProfile();
      const out = await ingestResumeBuffer(db, encryptionKey, profile, resumesDir, {
        filename: upload.filename,
        buffer: upload.buffer,
        // Pass through ONLY when the client sent it — unset rides the capability resolver.
        ...(input.preferLlm !== undefined ? { preferLlm: input.preferLlm } : {}),
      });
      sendJson(res, 200, {
        ok: true,
        method: out.method,
        warnings: out.warnings,
        profileFieldsFilled: out.profileFieldsFilled,
        form: profileToForm(out.profile),
        suggestedRoles: out.suggestedRoles,
        ...(ledgerPayload(out.ledger) as object),
      });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  };

  // Facts ledger: GET to review, POST to approve/remove (only approved facts reach documents).
  const handleLedger: Handler = async (req, res, _url, method) => {
    const profile = activeProfile();
    const ledgerRepo = new LedgerRepo(db, encryptionKey);
    if (method === "GET") {
      const ledger = profile ? ledgerRepo.get(profile.id) : undefined;
      if (!ledger) {
        sendJson(res, 200, { ...EMPTY_LEDGER, suggestedRoles: [] });
        return;
      }
      const suggestedRoles = inferTargetRoles(profile!, ledger.facts);
      sendJson(res, 200, { ...(ledgerPayload(ledger) as object), suggestedRoles });
      return;
    }
    if (method === "POST") {
      if (!profile) {
        sendJson(res, 400, { error: "No profile yet." });
        return;
      }
      let ledger = ledgerRepo.get(profile.id);
      if (!ledger) {
        sendJson(res, 400, { error: "No ledger yet — ingest a résumé first." });
        return;
      }
      const input = validate(LedgerInput, await readJsonBody(req));
      if (input.approveAll === true) ledger = approveAll(ledger);
      if (input.setApproved) {
        for (const s of input.setApproved) {
          if (s.id) ledger = setApproved(ledger, s.id, s.approved === true);
        }
      }
      if (input.remove) {
        for (const id of input.remove) ledger = removeFact(ledger, id);
      }
      if (input.edit) ledger = editFactStatement(ledger, input.edit.id, input.edit.statement);
      ledger = finalizeApproval(ledger);
      const saved = ledgerRepo.save(ledger);
      // Recompute matching insights from the now-approved facts (prefer approved, else all).
      if (profile) {
        const approved = saved.facts.filter((f) => f.approved);
        const basis = approved.length ? approved : saved.facts;
        new ResumeInsightsRepo(db).set(profile.id, computeResumeInsights(basis));
      }
      sendJson(res, 200, ledgerPayload(saved));
      return;
    }
    sendJson(res, 405, { error: "GET or POST /api/ledger" });
  };

  // Target company actions (enable/disable/approve/remove).
  const handleCompaniesAction: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/companies/action" });
      return;
    }
    const input = validate(CompanyActionInput, await readJsonBody(req));
    const id = input.id ?? "";
    const action = input.action ?? "";
    if (!id) {
      sendJson(res, 400, { error: "id required" });
      return;
    }
    const repo = new CompaniesRepo(db);
    switch (action) {
      case "enable": repo.setEnabled(id, true); break;
      case "disable": repo.setEnabled(id, false); break;
      case "approve":
      case "disapprove":
        sendJson(res, 400, { error: "Auto-submit approval is no longer supported — all applies pause for your review." });
        return;
      case "remove": repo.remove(id); break;
      default:
        sendJson(res, 400, { error: `unknown action "${action}"` });
        return;
    }
    sendJson(res, 200, { ok: true });
  };

  // Discovered job actions: discard roles that are not a fit.
  const handleDiscoveredJobsAction: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/discovered-jobs/action" });
      return;
    }
    const input = validate(CompanyActionInput, await readJsonBody(req));
    const id = input.id ?? "";
    const action = input.action ?? "";
    if (!id) {
      sendJson(res, 400, { error: "id required" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 400, { error: "No profile yet." });
      return;
    }
    if (action === "set-tier") {
      const t = input.tier;
      const tier = t === "A" || t === "B" || t === "C" ? t : null;
      if (!new DiscoveredJobsRepo(db).setTier(profile.id, id, tier)) {
        sendJson(res, 404, { error: "discovered job not found" });
        return;
      }
      sendJson(res, 200, { ok: true, tier });
      return;
    }
    if (action !== "discard") {
      sendJson(res, 400, { error: `unknown action "${action}" (expected "discard" or "set-tier")` });
      return;
    }
    if (!new DiscoveredJobsRepo(db).setStatus(profile.id, id, "skipped")) {
      sendJson(res, 404, { error: "discovered job not found" });
      return;
    }
    sendJson(res, 200, { ok: true });
  };

  // Discovered jobs: scored matches from company boards (filter by minScore 0–1).
  const handleDiscoveredJobExplanation: Handler = (_req, res, url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/discovered-jobs/explain?id=<jobId>" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 404, { error: "profile not found" });
      return;
    }
    const id = new URL(url, "http://local").searchParams.get("id")?.trim();
    if (!id) {
      sendJson(res, 400, { error: "id is required" });
      return;
    }
    const job = new DiscoveredJobsRepo(db).list(profile.id).find((j) => j.id === id);
    if (!job) {
      sendJson(res, 404, { error: "discovered job not found" });
      return;
    }
    sendJson(res, 200, {
      job: {
        id: job.id,
        company: job.company,
        title: job.title,
        ...(job.location ? { location: job.location } : {}),
        jobUrl: job.jobUrl,
        score: job.score,
        knockouts: job.knockouts,
        status: job.status,
      },
      explanation: new DiscoveryAuditRepo(db).explainJob(job.id),
    });
  };

  const handleDiscoveredJobs: Handler = (_req, res, url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/discovered-jobs" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 200, { jobs: [] });
      return;
    }
    const parsed = new URL(url, "http://local");
    const minRaw = parsed.searchParams.get("minScore");
    const minScore = minRaw !== null && minRaw !== "" ? Number(minRaw) : undefined;
    const hasMinScore = minScore !== undefined && !Number.isNaN(minScore);
    const includeAll = parsed.searchParams.get("include") === "all";
    // Employer-ATS-only view (?employerOnly=1): hide aggregator-URL leads (LinkedIn/Indeed), showing
    // only postings on an employer's own board — the "only jobs that take me to the company's site" filter.
    const employerOnly = parsed.searchParams.get("employerOnly") === "1";
    // The row selection + mapping lives in the shared view builder so the read-only "web copy"
    // snapshot surfaces the identical Matches list (discovered-jobs-view.ts). Review-only — an apply
    // is never triggered from this list.
    sendJson(res, 200, {
      jobs: buildDiscoveredJobsPayload(db, profile.id, {
        ...(hasMinScore ? { minScore } : {}),
        includeAll,
        employerOnly,
      }),
    });
  };

  // Skill-gap insights: aggregate market demand across discovered jobs, diff vs the approved ledger.
  // Read-only — never changes a fact or a document.
  const handleInsights: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/insights" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 200, { jobsAnalyzed: 0, topGaps: [], topMatched: [] });
      return;
    }
    const ledger = new LedgerRepo(db, encryptionKey).get(profile.id) ?? { profileId: profile.id, facts: [] };
    // Learn from everything still in play (drop only the jobs the user discarded). Only the real
    // posting description is a trustworthy demand signal — the scoring rationale is meta-text.
    const jobs = new DiscoveredJobsRepo(db)
      .list(profile.id)
      .filter((j) => j.status !== "skipped")
      .map((j) => ({
        title: j.title,
        ...(j.description ? { description: j.description } : {}),
      }));
    sendJson(res, 200, computeSkillGap(jobs, ledger));
  };

  // Target companies/sources: GET list, POST add.
  const handleCompanies: Handler = async (req, res, _url, method) => {
    const repo = new CompaniesRepo(db);
    if (method === "GET") {
      const profile = activeProfile();
      const jobs = profile ? new DiscoveredJobsRepo(db).list(profile.id) : [];
      const companies = repo.list().map((c) => ({ ...c, found: jobs.filter((j) => j.company === c.name).length }));
      sendJson(res, 200, { companies });
      return;
    }
    if (method === "POST") {
      const input = validate(CompaniesInput, await readJsonBody(req));
      const rawUrl = (input.url ?? "").trim();
      const name = input.name?.trim() || undefined;
      if (!rawUrl) {
        sendJson(res, 400, { error: "url required" });
        return;
      }
      let direct: ReturnType<typeof normalizeBoard>;
      try {
        direct = normalizeBoard(rawUrl);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
        return;
      }
      if (direct) {
        const c = repo.add(name ?? direct.name, direct.boardUrl, direct.atsType);
        sendJson(res, 200, { ok: true, company: c, via: "direct" });
        return;
      }
      // A homepage/careers URL: browse the site to find its board (one browser task at a time).
      if (!acquireBrowser()) {
        sendJson(res, 409, { error: "A browser task is already running." });
        return;
      }
      try {
        const resolved = await resolveCompany(rawUrl, name);
        if (!resolved) {
          sendJson(res, 400, { error: "Couldn't find a supported job source on that site. Paste the ATS or job-search URL directly." });
          return;
        }
        const c = repo.add(resolved.name, resolved.boardUrl, resolved.atsType);
        sendJson(res, 200, { ok: true, company: c, via: resolved.via });
      } catch (err) {
        console.error("[api] company resolve failed:", err);
        sendServerError(res, err, "failed to resolve company board", { method, url: "/api/companies" });
      } finally {
        releaseBrowser();
      }
      return;
    }
    sendJson(res, 405, { error: "GET or POST /api/companies" });
  };

  // Discovery progress poll.
  const handleDiscoverStatus: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/discover/status" });
      return;
    }
    sendJson(res, 200, getDiscoveryTaskStatus());
  };

  // Discovery: analyze résumé, seed targets, browse enabled boards (one browser task at a time).
  const handleDiscover: Handler = async (_req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/discover" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 400, { error: "No profile yet." });
      return;
    }
    const ledger = new LedgerRepo(db, encryptionKey).get(profile.id);
    if (!ledger?.facts.length) {
      sendJson(res, 400, { error: "No résumé facts yet — upload your résumé in the Résumé tab first." });
      return;
    }
    if (!acquireBrowser()) {
      sendJson(res, 409, { error: "A browser task is already running." });
      return;
    }
    resetDiscoveryAbort();
    startDiscoveryTask("Analyzing your résumé and searching company boards…");
    try {
      const approvedFacts = ledger.facts.filter((f) => f.approved);
      const scoringFacts = approvedFacts.length ? approvedFacts : ledger.facts;
      const onProgress = (msg: string) => setDiscoveryProgress(msg);
      const run = deps.runDiscoveryFn
        ? await runDiscoveryFn(db, profile, scoringFacts)
        : await runDiscoveryPass(db, profile, scoringFacts, {
            ledgerFacts: scoringFacts,
            headed: false,
            onProgress,
          });
      const matches = run.scored.filter((s) => s.knockouts.length === 0 && s.score >= 0.5).length;
      const strongMatches = run.scored.filter((s) => s.knockouts.length === 0 && s.score >= 0.65).length;
      const newlyAdded = run.newlyAdded?.length ?? run.perCompany.reduce((n, c) => n + c.added, 0);
      const scoredVisible = run.scoredVisible?.length ?? run.scored.length;
      const rescoredExisting = run.rescoredExisting?.length ?? Math.max(0, scoredVisible - newlyAdded);
      const topMatches = run.scored
        .filter((s) => s.knockouts.length === 0)
        .slice(0, 12)
        .map((s) => ({
          title: s.title,
          company: s.company,
          score: Math.round(s.score * 100),
          rationale: s.rationale,
          jobUrl: s.jobUrl,
        }));
      const targetsAdded = "targets" in run ? (run as { targets: { added: string[] } }).targets.added : run.targetsAdded ?? [];
      const stopped = isDiscoveryAbortRequested();
      finishDiscoveryTask(stopped ? "Discovery stopped" : "Discovery complete");
      sendJson(res, 200, {
        ok: true,
        perCompany: run.perCompany,
        found: run.scored.length,
        matches,
        strongMatches,
        newlyAdded,
        rescoredExisting,
        scoredVisible,
        topMatches,
        targetsAdded,
        targetsResolvedOpen: run.targetsResolvedOpen ?? 0,
        usedUnapprovedFacts: approvedFacts.length === 0,
        stopped,
      });
    } catch (err) {
      finishDiscoveryTask("Discovery failed");
      console.error("[api] discovery failed:", err);
      sendServerError(res, err, "discovery failed", { method, url: "/api/discover" });
    } finally {
      releaseBrowser();
      resetDiscoveryAbort();
    }
  };

  // Document generation: tailored résumé + cover from APPROVED facts only (verifier-gated).
  const handleGenerate: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/generate" });
      return;
    }
    const input = validate(GenerateInput, await readJsonBody(req));
    try {
      const result = await runGenerate(db, encryptionKey, generatedDir, {
        ...(input.company !== undefined ? { company: input.company } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        postingText: input.postingText ?? "",
        // Unset = ride the capability resolver; explicit false forces the template generator.
        useLlm: input.useLlm ?? aiEnabled("doc-generation"),
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.postingUrl ? { postingUrl: input.postingUrl } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {}),
      }, { demoMode });
      sendJson(res, 200, { ok: true, ...result, downloads: downloadPayload(result.files) });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  };

  const handleApplicationDrafts: Handler = async (req, res, _url, method) => {
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, method === "GET" ? 200 : 400, method === "GET" ? { drafts: [] } : { error: "No profile yet." });
      return;
    }
    const repo = new ApplicationDraftsRepo(db);
    if (method === "GET") {
      sendJson(res, 200, { drafts: repo.list(profile.id) });
      return;
    }
    if (method === "POST") {
      const input = validate(ApplicationDraftActionInput, await readJsonBody(req));
      const id = input.id ?? "";
      const status = input.status as ApplicationDraftStatus | undefined;
      if (!id || !status) {
        sendJson(res, 400, { error: "id and status are required" });
        return;
      }
      if (!repo.setStatus(profile.id, id, status)) {
        sendJson(res, 404, { error: "application draft not found" });
        return;
      }
      sendJson(res, 200, { ok: true, drafts: repo.list(profile.id) });
      return;
    }
    sendJson(res, 405, { error: "GET or POST /api/application-drafts" });
  };

  // Generated files: browser downloads are basename-scoped to generatedDir and auth-gated via /api.
  const handleGeneratedFile: Handler = (_req, res, url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/generated?file=<name>" });
      return;
    }
    const parsed = new URL(url, "http://local");
    const rawName = parsed.searchParams.get("file") ?? "";
    if (!rawName || rawName !== basename(rawName) || rawName.includes("/") || rawName.includes("\\")) {
      sendJson(res, 400, { error: "file basename required" });
      return;
    }
    const root = resolve(generatedDir);
    const filePath = resolve(root, rawName);
    if (dirname(filePath) !== root || !existsSync(filePath) || !statSync(filePath).isFile()) {
      sendJson(res, 404, { error: "generated file not found" });
      return;
    }
    const downloadName = rawName.replace(/["\r\n]/g, "");
    res.writeHead(200, {
      "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${downloadName}"`,
      "cache-control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  };

  // In-app apply (VISIBLE, persistent, review-first): /api/apply opens a browser the user can SEE —
  // the desktop app's embedded review panel when the shell provides one, a headed window otherwise —
  // fills what it confidently can, and returns the review gate + a sessionId. It NEVER submits: the
  // user reviews the real employer page, fixes anything, and clicks the employer's Submit button
  // themselves. /api/apply/field answers a question the bot left for you; /api/apply/refresh
  // re-checks after you solve a challenge/login on the page; /api/apply/mark-submitted records that
  // YOU submitted; /api/apply/cancel tears the session down. Only form-fill-supported jobs
  // (Greenhouse/Lever/Ashby) are accepted — see classifyApplyCapability.
  const handleApply: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/apply" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 400, { error: "No profile yet." });
      return;
    }
    const input = validate(ApplyInput, await readJsonBody(req));
    const jobUrl = (input.url ?? "").trim();
    if (!jobUrl) {
      sendJson(res, 400, { error: "url required" });
      return;
    }
    // The discovery→apply contract: only jobs with a real form-fill adapter may enter the automated
    // prefill path. Manual-only and unsupported jobs are refused with their reason — never silently
    // routed into the generic fallback.
    const capability = classifyApplyCapability(jobUrl);
    if (capability.capability !== "supported_form_fill") {
      sendJson(res, 422, {
        error:
          capability.capability === "manual_open_only"
            ? `This job can't be prefilled automatically. ${capability.reason} Use "Open manually" instead.`
            : `This job can't be applied to. ${capability.reason}`,
        ...applyCapabilityFields(jobUrl),
      });
      return;
    }
    // Replace any abandoned session, then hold the generic lock through doc-gen + the visible
    // launch+fill, transitioning to the apply session's own lock only once it's live (no gap).
    await closeApply();
    if (!acquireBrowser()) {
      sendJson(res, 409, { error: "A browser task is already running." });
      return;
    }
    try {
      // Pull the discovered job (if any) for JD text — better tailoring — and its known metadata.
      const dj = new DiscoveredJobsRepo(db).findByUrl(profile.id, jobUrl);
      const docs = await prepareApplicationDocs(db, encryptionKey, generatedDir, profile, {
        company: input.company ?? dj?.company ?? "Employer",
        title: input.title ?? dj?.title ?? "Role",
        jobUrl,
        ...(dj?.description ? { description: dj.description } : {}),
        ...(dj?.location ? { location: dj.location } : {}),
        ...(dj?.rationale ? { rationale: dj.rationale } : {}),
      });
      const applyInput: ApplySessionInput = {
        url: jobUrl,
        ...(input.company ? { company: input.company } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.display ? { display: input.display } : {}),
        resumePath: docs.resumePath,
        ...(docs.coverLetterPath ? { coverLetterPath: docs.coverLetterPath } : {}),
        ...(docs.ledgerCheck ? { ledgerCheck: docs.ledgerCheck } : {}),
      };
      const handle = await startApply(db, profile, applyInput);
      activeApply = { handle, timer: armApplyTtl(handle), startedAt: new Date().toISOString() };
      releaseBrowser(); // the live apply session is now the exclusive lock
      // Record what the form-fill agent produced (redacted) so the Applications tab can show it.
      captureFillSnapshot(profile.id, handle.getGate(), false);
      sendJson(res, 200, {
        ok: true,
        sessionId: handle.getId(),
        generator: docs.generator,
        submitted: false,
        // Where the session's browser actually is, so the UI can say so honestly.
        display: handle.getDisplay?.() ?? resolveApplyDisplay(input.display),
        ...applyCapabilityFields(jobUrl),
        ...flatGate(handle.getGate()),
        gate: serializeGate(handle.getGate()),
      });
    } catch (err) {
      releaseBrowser();
      await closeApply();
      sendJson(res, 400, { error: (err as Error).message });
    }
  };

  /** Answer a field the bot couldn't fill — set live on the headless page, as a user-sourced value. */
  const handleApplyField: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/apply/field" });
      return;
    }
    const body = validate(ApplyFieldInput, await readJsonBody(req));
    if (!activeApply || (body.sessionId && body.sessionId !== activeApply.handle.getId())) {
      sendJson(res, 409, { error: "No active application. Start one first." });
      return;
    }
    try {
      const gate = await activeApply.handle.setField(body.ref, body.value);
      touchApply();
      sendJson(res, 200, { ok: true, gate: serializeGate(gate) });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  };

  /** Re-check the headed browser after the human solves CAPTCHA/login, then continue the gate. */
  const handleApplyRefresh: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/apply/refresh" });
      return;
    }
    const body = validate(ApplySessionRefInput, await readJsonBody(req));
    if (!activeApply || (body.sessionId && body.sessionId !== activeApply.handle.getId())) {
      sendJson(res, 409, { error: "No active application. Start one first." });
      return;
    }
    try {
      const gate = await activeApply.handle.refresh();
      touchApply();
      sendJson(res, 200, { ok: true, gate: serializeGate(gate) });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  };

  /**
   * REMOVED capability, kept as an honest tombstone: the app no longer clicks the employer's submit
   * button — not even after user approval. Submission happens manually, by the user, on the real
   * employer page (in the review panel or the headed window). Use /api/apply/mark-submitted to
   * record that it happened.
   */
  const handleApplySubmit: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/apply/submit" });
      return;
    }
    req.resume();
    sendJson(res, 410, {
      error:
        "ApplyPilot doesn't click submit anymore. Review the application in the browser panel, click the employer's Submit button yourself, then mark it submitted.",
      submitted: false,
    });
  };

  /**
   * Record that the HUMAN submitted the application on the employer's page. Never clicks anything.
   * Works for the active session (flips its row + snapshot to submitted and closes it), or — when
   * the session already expired while the user finished up on the page — for a bare URL.
   */
  const handleApplyMarkSubmitted: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/apply/mark-submitted" });
      return;
    }
    const body = validate(ApplyMarkSubmittedInput, await readJsonBody(req));
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 400, { error: "No profile yet." });
      return;
    }
    const handle =
      activeApply && (!body.sessionId || body.sessionId === activeApply.handle.getId()) ? activeApply.handle : undefined;
    try {
      if (handle) {
        const result = await handle.markSubmitted();
        captureFillSnapshot(profile.id, handle.getGate(), true);
        if (activeApply && activeApply.handle === handle) {
          clearTimeout(activeApply.timer);
          activeApply = null; // the session closed its own browser when marked submitted
        }
        sendJson(res, 200, { ok: true, submitted: true, reason: result.reason, ...(result.warning ? { warning: result.warning } : {}) });
        return;
      }
      const url = (body.url ?? "").trim();
      if (!url) {
        sendJson(res, 409, { error: "No active application. Pass the job url to record a submit after the session closed." });
        return;
      }
      // A10: harden the bare-URL path so a manual record can't pollute dedup/history with a
      // non-posting or a random link. A board/search/invalid URL is refused; an unrecognized ATS
      // page requires explicit confirmation. Recognized employer postings (greenhouse/lever/ashby)
      // are trusted from a deliberate mark-submitted call.
      const capability = classifyApplyCapability(url);
      if (capability.capability === "unsupported") {
        sendJson(res, 422, { error: `Can't record a submit for this link — ${capability.reason}`, submitted: false });
        return;
      }
      if (capability.capability === "manual_open_only" && body.confirm !== true) {
        sendJson(res, 422, {
          error: "This isn't a recognized ATS posting. If you did submit it, resend with confirm: true to record it.",
          submitted: false,
          needsConfirmation: true,
        });
        return;
      }
      new ApplicationsRepo(db).record({
        profileId: profile.id,
        dedupKey: dedupKeyForUrl(url),
        ...(body.company ? { company: body.company } : {}),
        ...(body.title ? { title: body.title } : {}),
        url,
        ats: capability.atsType ?? "unknown",
        mode: "semi_auto",
        status: "submitted",
        submitted: true,
      });
      recordAudit(db, profile.id, "application.submitted", { url, via: "user_manual_click", ats: capability.atsType ?? "unknown" });
      sendJson(res, 200, { ok: true, submitted: true, reason: "Recorded — you submitted this on the employer's site." });
    } catch (err) {
      sendServerError(res, err, "could not record the submit", { method, url: "/api/apply/mark-submitted" });
    }
  };

  /**
   * The placeholder page the desktop shell loads into the embedded review panel. The engine finds
   * this page over CDP (by pathname) and navigates it to the real employer application — so the
   * user watches the fill happen right here, inside the app.
   */
  const handleReviewPanelPage: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /review-panel" });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>ApplyPilot review panel</title>` +
        `<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;` +
        `font-family:system-ui,sans-serif;background:#fbf7f0;color:#4a4237}p{max-width:34em;text-align:center;line-height:1.6}</style>` +
        `</head><body><p>Waiting for the application page… ApplyPilot will open the employer's real form here, ` +
        `fill what it safely can, and then hand it over to you. You review and click Submit yourself.</p></body></html>`
    );
  };

  /** Close an open apply session without submitting. */
  const handleApplyCancel: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/apply/cancel" });
      return;
    }
    req.resume();
    await closeApply();
    sendJson(res, 200, { ok: true });
  };

  // Update which roles the user wants to apply for (profile.preferences.targetRoles only —
  // no other profile fields are touched so this never clobbers contact info or work auth).
  const handleTargetRoles: Handler = async (req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/target-roles" });
      return;
    }
    const body = await readJsonBody(req);
    const roles = Array.isArray(body.roles)
      ? (body.roles as unknown[]).filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => (r as string).trim())
      : [];
    const profileRepo = new ProfileRepo(db, encryptionKey);
    const profile = activeProfile(profileRepo);
    if (!profile) {
      sendJson(res, 400, { error: "No profile yet." });
      return;
    }
    profile.preferences.targetRoles = roles;
    profile.updatedAt = new Date().toISOString();
    profileRepo.save(profile);
    sendJson(res, 200, { ok: true, targetRoles: roles });
  };

  const handleHealth: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/health" });
      return;
    }
    sendJson(res, 200, { ok: true, browserBusy });
  };

  // The canonical JobSearchIntent: GET returns the resolved intent (a stored CONFIRMED one, else an
  // inferred draft) + the automation permissions its confidence unlocks. POST confirms/updates it
  // (brief Part H — the onboarding/target-profile step). Persisting a confirmed intent is what lets
  // discovery run with high confidence and the apply path treat strong matches as review-ready.
  const SearchIntentPatch = z.object({
    targetTitles: z.array(z.string()).optional(),
    adjacentTitles: z.array(z.string()).optional(),
    excludedTitles: z.array(z.string()).optional(),
    seniorityMin: z.enum(["intern", "entry", "associate", "mid", "senior", "lead", "manager", "director", "executive"]).optional(),
    seniorityMax: z.enum(["intern", "entry", "associate", "mid", "senior", "lead", "manager", "director", "executive"]).optional(),
    mustHaveSkills: z.array(z.string()).optional(),
    niceToHaveSkills: z.array(z.string()).optional(),
    requiredCredentials: z.array(z.string()).optional(),
    missingCredentialDealbreakers: z.array(z.string()).optional(),
    industries: z.array(z.string()).optional(),
    companyTypes: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
    workArrangement: z.array(z.enum(["onsite", "hybrid", "remote_us"])).optional(),
    dealbreakers: z.array(z.string()).optional(),
    compensationMin: z.number().optional(),
    compensationTarget: z.number().optional(),
  });

  const approvedFactsFor = (profileId: string) =>
    (new LedgerRepo(db, encryptionKey).get(profileId)?.facts ?? []).filter((f) => f.approved);

  const handleSearchIntent: Handler = async (req, res, _url, method) => {
    const repo = new ProfileRepo(db, encryptionKey);
    const profile = activeProfile(repo);
    if (!profile) {
      sendJson(res, 400, { error: "No profile yet." });
      return;
    }
    const facts = approvedFactsFor(profile.id);
    if (method === "GET") {
      const intent = resolveJobSearchIntent({ profile, facts });
      sendJson(res, 200, { intent, permissions: intentPermissions(intent.confidence) });
      return;
    }
    if (method === "POST") {
      try {
        const patch = validate(SearchIntentPatch, await readJsonBody(req)) as IntentPatch;
        // Build the draft from profile + facts IGNORING any stored intent, so the user's edits merge
        // onto fresh inference rather than onto a previous confirmation.
        const draftProfile = { ...profile, dynamicAnswers: profile.dynamicAnswers.filter((d) => d.key !== INTENT_DYNAMIC_KEY) };
        const draft = resolveJobSearchIntent({ profile: draftProfile, facts });
        const confirmed = buildConfirmedIntent(draft, patch);
        const saved = repo.save(withConfirmedIntent(profile, confirmed));
        recordAudit(db, profile.id, "search_intent.confirmed", {
          roleFamilies: confirmed.roleFamilies,
          targetTitles: confirmed.targetTitles.slice(0, 8),
        });
        const reloaded = resolveJobSearchIntent({ profile: saved, facts });
        sendJson(res, 200, { ok: true, intent: reloaded, permissions: intentPermissions(reloaded.confidence) });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return;
    }
    sendJson(res, 405, { error: "GET or POST /api/search-intent" });
  };

  // Assisted LinkedIn/Indeed search: build a pre-filled search-page URL from the user's own intent so
  // they can browse those sites THEMSELVES in their browser (shell.openExternal). The app never fetches
  // LinkedIn/Indeed (hard-denied in NetGuard) — this only hands the user a ready-made search link. Pair
  // it with the ?employerOnly=1 Matches filter: search off-platform there, and the app surfaces the
  // company-site postings here.
  const handleAssistedSearch: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/assisted-search" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 200, { linkedin: null, indeed: null });
      return;
    }
    const intent = resolveJobSearchIntent({ profile, facts: approvedFactsFor(profile.id) });
    const keywords = (intent.targetTitles[0] ?? profile.preferences.targetRoles?.[0] ?? "").trim();
    const location = (intent.locations[0] ?? "").trim();
    if (!keywords) {
      sendJson(res, 200, { keywords: null, location: null, linkedin: null, indeed: null });
      return;
    }
    const input = { keywords, ...(location ? { location } : {}) };
    sendJson(res, 200, {
      keywords,
      location: location || null,
      linkedin: buildLinkedInJobSearchUrl(input),
      indeed: buildIndeedJobSearchUrl(input),
    });
  };

  // The latest automation funnel report (brief F2/J3): where jobs were lost this pass + a zero-match
  // bottleneck diagnosis. Read from the audit log so the dashboard can show honest diagnostics.
  const handleAutomationFunnel: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/automation/funnel" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 400, { error: "No profile yet." });
      return;
    }
    const row = db
      .prepare("SELECT detail, ts FROM audit_log WHERE profile_id = ? AND action = 'automation.funnel' ORDER BY id DESC LIMIT 1")
      .get(profile.id) as { detail: string | null; ts: string } | undefined;
    if (!row?.detail) {
      sendJson(res, 200, { funnel: null });
      return;
    }
    try {
      sendJson(res, 200, { funnel: JSON.parse(row.detail), at: row.ts });
    } catch {
      sendJson(res, 200, { funnel: null });
    }
  };

  const handleErrors: Handler = async (req, res, url, method) => {
    const path = pathnameOf(url);
    if (path === "/api/errors/export") {
      if (method !== "GET") {
        sendJson(res, 405, { error: "GET /api/errors/export" });
        return;
      }
      const parsed = new URL(url, "http://local");
      const limit = Number(parsed.searchParams.get("limit") ?? "50");
      const bundle = errorReporter.export(Number.isFinite(limit) ? limit : 50);
      sendJson(res, 200, { ok: true, ...bundle, dir: errorReporter.dir });
      return;
    }

    if (method === "GET") {
      const parsed = new URL(url, "http://local");
      const limit = Number(parsed.searchParams.get("limit") ?? "20");
      sendJson(res, 200, {
        ok: true,
        dir: errorReporter.dir,
        reports: errorReporter.list(Number.isFinite(limit) ? limit : 20),
      });
      return;
    }
    if (method === "POST") {
      const input = validate(ClientErrorInput, await readJsonBody(req));
      const report = errorReporter.record({
        source: input.source ?? "frontend",
        severity: input.severity ?? "error",
        message: input.message,
        ...(input.name ? { name: input.name } : {}),
        ...(input.stack ? { stack: input.stack } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      });
      sendJson(res, 200, { ok: true, errorId: report.id, dir: errorReporter.dir });
      return;
    }
    sendJson(res, 405, { error: "GET or POST /api/errors" });
  };

  const handleReset: Handler = async (_req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/reset" });
      return;
    }
    try {
      // Stop all in-flight work before wiping data.
      automationRunner.stop();
      requestAllBrowserTasksStop();
      await closeApply();

      // Wipe every data table. Order respects FK constraints (children before parents).
      db.transaction(() => {
        for (const table of [
          "llm_cache", "llm_usage", "profile_embeddings", "resume_insights",
          "normalized_jobs_fts", "user_feedback", "rerank_decisions", "scorecards", "filter_decisions",
          "dedupe_groups", "job_observation_links", "normalized_jobs", "raw_job_observations",
          "source_queries", "discovery_runs", "automation_progress",
          "audit_log", "application_drafts", "applications", "accounts", "discovered_jobs",
          "companies", "ledgers", "profiles",
        ]) {
          db.prepare(`DELETE FROM ${table}`).run();
        }
      })();

      // Delete generated docs, uploaded resumes, and error logs.
      const dataDir = dirname(resolve(cfg.dbPath));
      for (const sub of ["resumes", "generated", "errors"]) {
        const dir = join(dataDir, sub);
        if (existsSync(dir)) {
          for (const entry of readdirSync(dir)) {
            rmSync(join(dir, entry), { recursive: true, force: true });
          }
        }
      }
      // Career-site cookies/logins live in the persistent Chromium profile(s), outside the DB and the
      // dirs above — a full reset must clear them too (commercial M7). Sessions were stopped above.
      wipeBrowserProfiles();

      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error("[api] reset failed:", err);
      sendServerError(res, err, "reset failed", { method, url: "/api/reset" });
    }
  };

  // Chromium provisioning (commercial M8): the packaged app ships no browser binary — it downloads
  // Chromium into userData on first run. Mirrors /api/llm/status + /api/llm/models/download.
  const handleBrowserStatus: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/browser/status" });
      return;
    }
    sendJson(res, 200, browserStatus());
  };

  const handleBrowserInstall: Handler = (_req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/browser/install" });
      return;
    }
    const { started } = installChromium();
    // 202 Accepted: the download runs in the background; the dashboard polls /api/browser/status.
    sendJson(res, started ? 202 : 200, { ok: true, started, ...browserStatus() });
  };

  // Standalone "forget my career-site logins" control (commercial M7): wipe the persistent Chromium
  // profile(s) without touching the rest of the datastore. We must NEVER rmSync the profile out from
  // under a live Chromium — that corrupts it (and on Windows the locked-file delete silently no-ops, so
  // we'd report success while nothing was cleared). So refuse with 409 while any browser task holds it
  // (discovery/company scans take the browserBusy lease; an apply session owns activeApply; automation
  // runs its own persistent context). The user stops the task, then retries against a quiet profile.
  const handleBrowserProfileWipe: Handler = async (_req, res, _url, method) => {
    if (method !== "POST") {
      sendJson(res, 405, { error: "POST /api/browser-profile/wipe" });
      return;
    }
    if (browserBusy || activeApply || automationRunner.isRunning()) {
      sendJson(res, 409, {
        error: "A browser task is running (Find jobs, applying, or automation). Stop it and try again.",
      });
      return;
    }
    try {
      const { removed } = wipeBrowserProfiles();
      sendJson(res, 200, { ok: true, removed: removed.length, dir: browserProfileDir() });
    } catch (err) {
      console.error("[api] browser-profile wipe failed:", err);
      sendServerError(res, err, "browser-profile wipe failed", { method, url: "/api/browser-profile/wipe" });
    }
  };

  const handleState: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/state" });
      return;
    }
    try {
      const { llmMode } = readSettings(envPath);
      const state = buildDashboardState(db, encryptionKey, llmMode, { demoMode });
      // Override the progress-only live indicator with the full real picture: an open apply session
      // (a real form is loaded + filled, paused at the gate) takes priority, then the automation pass,
      // then a standalone discovery pass. Read-only; nothing here triggers a submit.
      const gate = activeApply?.handle.getGate();
      state.liveActivity = computeLiveActivity({
        applySession:
          activeApply && gate
            ? {
                company: gate.company ?? null,
                title: gate.title ?? null,
                startedAt: activeApply.startedAt,
                needsInput: gate.needsConfirmation.length > 0,
                ready: gate.readyForOneClickSubmit,
              }
            : null,
        progress: {
          status: state.automationProgress.status,
          currentStepLabel: state.automationProgress.currentStepLabel,
          startedAt: state.automationProgress.startedAt,
          percentComplete: state.automationProgress.percentComplete,
          completedAt: state.automationProgress.completedAt,
        },
        discovery: getDiscoveryTaskStatus(),
      });
      sendJson(res, 200, state);
    } catch (err) {
      console.error("[api] state build failed:", err);
      sendServerError(res, err, "failed to build dashboard state", { method, url: "/api/state" });
    }
  };

  // Full Applications detail for the Applications tab: every applied job AND every prepared draft,
  // joined by dedup key with its tailored docs and the redacted form-fill snapshot. Read-only.
  const handleApplications: Handler = (_req, res, _url, method) => {
    if (method !== "GET") {
      sendJson(res, 405, { error: "GET /api/applications" });
      return;
    }
    const profile = activeProfile();
    if (!profile) {
      sendJson(res, 200, { applications: [] });
      return;
    }
    const apps = new ApplicationsRepo(db).list(profile.id);
    const drafts = new ApplicationDraftsRepo(db).list(profile.id);
    const snaps = new FillSnapshotsRepo(db).list(profile.id);
    const snapByKey = new Map(snaps.map((s) => [s.dedupKey, s]));
    const draftByKey = new Map(drafts.map((d) => [d.dedupKey, d]));
    const draftView = (d: (typeof drafts)[number]) => ({
      id: d.id,
      tailoredResumeSummary: d.tailoredResumeSummary,
      coverLetter: d.coverLetter,
      applicationAnswers: d.applicationAnswers,
      status: d.status,
      updatedAt: d.updatedAt,
    });
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const a of apps) {
      seen.add(a.dedupKey);
      const d = draftByKey.get(a.dedupKey);
      const s = snapByKey.get(a.dedupKey);
      out.push({
        dedupKey: a.dedupKey,
        company: a.company ?? d?.company ?? s?.company ?? null,
        title: a.title ?? d?.title ?? s?.title ?? null,
        url: a.url ?? d?.applyUrl ?? s?.url ?? null,
        ats: a.ats ?? s?.ats ?? null,
        status: a.status,
        submitted: a.submitted,
        createdAt: a.createdAt,
        source: "applied",
        draft: d ? draftView(d) : null,
        fill: s ? s.snapshot : null,
      });
    }
    for (const d of drafts) {
      if (seen.has(d.dedupKey)) continue;
      const s = snapByKey.get(d.dedupKey);
      out.push({
        dedupKey: d.dedupKey,
        company: d.company ?? null,
        title: d.title ?? null,
        url: d.applyUrl ?? null,
        ats: s?.ats ?? null,
        status: d.status,
        submitted: false,
        createdAt: d.createdAt,
        source: "draft",
        draft: draftView(d),
        fill: s ? s.snapshot : null,
      });
    }
    out.sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
    sendJson(res, 200, { applications: out });
  };

  // Exact-path dispatch table — the name-tag chart. Lookup is O(1) and order-independent, so no path
  // can shadow another (the old `startsWith` cascade only worked because `/api/discovered-jobs` was
  // listed before `/api/discover`). Adding a route = one entry here + its handler.
  const routes: Record<string, Handler> = {
    "/api/tasks/stop": handleTasksStop,
    "/api/runner/status": handleRunner,
    "/api/runner/stop": handleRunner,
    "/api/runner/start": handleRunner,
    "/api/automation/progress": handleAutomationProgress,
    "/api/runs": handleRuns,
    "/api/autopilot": handleAutopilot,
    "/api/schedule": handleSchedule,
    "/api/settings": handleSettings,
    "/api/logins": handleLogins,
    "/api/logins/delete": handleLogins,
    "/api/llm/status": handleLlmStatus,
    "/api/llm/models/download": handleLlmModelsDownload,
    "/api/profile": handleProfile,
    "/api/profile/reset": handleProfileReset,
    "/api/resume/preview": handleResumePreview,
    "/api/resume/import": handleResumeImport,
    "/api/resume/ingest": handleResumeIngest,
    "/api/ledger": handleLedger,
    "/api/companies/action": handleCompaniesAction,
    "/api/discovered-jobs/action": handleDiscoveredJobsAction,
    "/api/discovered-jobs/explain": handleDiscoveredJobExplanation,
    "/api/discovered-jobs": handleDiscoveredJobs,
    "/api/insights": handleInsights,
    "/api/companies": handleCompanies,
    "/api/discover/status": handleDiscoverStatus,
    "/api/discover": handleDiscover,
    "/api/generate": handleGenerate,
    "/api/application-drafts": handleApplicationDrafts,
    "/api/applications": handleApplications,
    "/api/generated": handleGeneratedFile,
    "/api/apply": handleApply,
    "/api/apply/field": handleApplyField,
    "/api/apply/refresh": handleApplyRefresh,
    "/api/apply/submit": handleApplySubmit,
    "/api/apply/mark-submitted": handleApplyMarkSubmitted,
    "/api/apply/cancel": handleApplyCancel,
    "/review-panel": handleReviewPanelPage,
    "/api/target-roles": handleTargetRoles,
    "/api/search-intent": handleSearchIntent,
    "/api/assisted-search": handleAssistedSearch,
    "/api/automation/funnel": handleAutomationFunnel,
    "/api/errors": handleErrors,
    "/api/errors/export": handleErrors,
    "/api/health": handleHealth,
    "/api/state": handleState,
    "/api/reset": handleReset,
    "/api/browser-profile/wipe": handleBrowserProfileWipe,
    "/api/browser/status": handleBrowserStatus,
    "/api/browser/install": handleBrowserInstall,
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Per-request CORS (reflected only for an allowed origin) applied up front; responses inherit it.
    applyCors(res, corsHeadersFor(req.headers.origin, access));

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth seam: gate the data API (/api/*), EXCEPT /api/health (see access.requiresAuth — the shell's
    // own unauthenticated liveness probe must keep working). The static SPA shell loads unauthenticated
    // so the client can bootstrap; its XHRs then carry the token. With no token, authorize() allows all.
    if (requiresAuth(pathnameOf(url))) {
      const auth = authorize(req);
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.message });
        return;
      }
    }

    // Single front-door try/catch: handled ApiErrors (validation/body/size) map to their status with a
    // safe message; anything unexpected is logged server-side and returned as a generic 500 — internal
    // detail never reaches the client.
    try {
      const route = routes[pathnameOf(url)];
      if (route) {
        await route(req, res, url, method);
        return;
      }
      if (method === "GET" && webRoot && serveStatic(res, webRoot, url)) return;
      if (method !== "GET") {
        sendJson(res, 405, { error: "read-only API" });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof ApiError) {
        if (!res.headersSent) sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error("[api] unhandled error:", err);
      sendServerError(res, err, "internal error", { method, url });
    }
  };

  // Bind the SAME handler on each resolved host. In tailscale mode that's loopback + the 100.x
  // address (the local app/health checks keep working AND the phone can reach it). The primary
  // (hosts[0], always loopback unless "all") is returned; secondaries are closed with it. With an
  // ephemeral port (0, used by tests) only the primary is bound, since each socket would otherwise
  // get a different port.
  const primary = createServer(handler);
  const secondaryHosts = port === 0 ? [] : access.hosts.slice(1);
  const secondaries = secondaryHosts.map(() => createServer(handler));

  primary.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(
        `\nApplyPilot API port ${port} is already in use.\n` +
          `  Close the other ApplyPilot window, or run: npm run app:stop\n` +
          `  Then: npm run app\n\n`
      );
      process.exit(1);
    }
    throw err;
  });

  primary.listen(port, access.hosts[0], () => {
    const addr = primary.address();
    const bound = addr && typeof addr === "object" ? addr.port : port;
    for (let i = 0; i < secondaries.length; i++) secondaries[i]!.listen(bound, secondaryHosts[i]);
    process.stdout.write(`ApplyPilot app API on http://${access.hosts[0]}:${bound} — ${describeBind(access)}\n`);
    process.stdout.write(`ApplyPilot web app: ${access.hosts.map((host) => `http://${host}:${bound}/`).join(", ")}\n`);
    if (access.mode !== "loopback" && !access.authToken) {
      process.stdout.write(
        "  Reachable beyond loopback without an app token — set APPLYPILOT_AUTH_TOKEN to require Bearer auth.\n"
      );
    }
    // Arm the daily scheduler from the persisted setting now that the engine is up (M9-C). Disabled
    // by default, so this is a no-op until the user opts in — no timer, no unattended runs.
    const schedule = readSettings(envPath);
    scheduler.set({ enabled: schedule.scheduleEnabled, hour: schedule.scheduleHour });
  });
  primary.on("close", () => {
    scheduler.stop();
    secondaries.forEach((s) => s.close());
  });
  return primary;
}
