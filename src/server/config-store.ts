// src/server/config-store.ts
//
// Read/write the small set of app settings the GUI manages — currently the Anthropic API key and
// model — persisted to the local, gitignored `.env` (the same file loadConfig reads). The KEY IS A
// SECRET: readSettings NEVER returns it in full (only a "…1234" hint + a boolean), the file is
// written 0600, and writeSettings also updates process.env in-memory so the running engine picks the
// new key up immediately (no restart). Other `.env` lines and comments are preserved on write.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseLlmProvider, type LlmProviderId } from "../llm/config";
import { allModelsPresent } from "../llm/model-store";
import { resetLlmClientCache } from "../llm/client";
import { resetEmbeddingClientCache } from "../llm/embeddings";

export interface AppSettings {
  hasKey: boolean;
  /** Last 4 chars only, e.g. "…aB12" — enough to confirm which key is set, never the secret. */
  keyHint: string | null;
  model: string;
  llmProvider: LlmProviderId;
  llmBaseUrl: string | null;
  llmConfigured: boolean;
  /**
   * Which AI tier is active:
   * - "bundled" — the built-in in-process model (default; no install, no daemon).
   * - "cloud"   — Anthropic key configured; AI calls go to Claude.
   * - "local"   — Ollama/compatible endpoint selected; that server must be running.
   * - "builtin" — Anthropic selected but no key set; falls back to rule-based engine.
   */
  llmMode: "builtin" | "bundled" | "local" | "cloud";
  /**
   * "Quality over volume" mode. When on, an autopilot pass raises the min-fit floor and tightens the
   * per-pass ceiling so the ready queue fills with a few strong, tailored matches instead of many
   * mediocre ones — the framework's "20 tailored > 100 mass". Off by default.
   */
  qualityMode: boolean;
  /** Uniform recency window (days) for discovery's postedAt gate (brief §2b). Default 7; 0 disables. */
  maxAgeDays: number;
  /**
   * Daily scheduled automation (commercial M9-C). When enabled, the engine runs one semi (never-submit)
   * pass each day at `scheduleHour` (local) while it is running. Opt-in: OFF by default, because it is
   * an unattended trigger of browser automation — the user turns it on deliberately.
   */
  scheduleEnabled: boolean;
  /** Local hour (0–23) the daily pass starts. Default 7. */
  scheduleHour: number;
  /** API-backed discovery sources. Each is active only when all required keys are present. */
  adzunaConfigured: boolean;
  adzunaAppIdHint: string | null;
  adzunaAppKeyHint: string | null;
  joobleConfigured: boolean;
  joobleKeyHint: string | null;
  usajobsConfigured: boolean;
  usajobsKeyHint: string | null;
  usajobsEmailHint: string | null;
}

/** Parse an env flag: "on"/"true"/"1"/"yes" (case-insensitive) => true, anything else => false. */
function parseFlag(v: string | undefined): boolean {
  return /^(on|true|1|yes)$/i.test((v ?? "").trim());
}

const DEFAULT_MODEL = "qwen2.5-1.5b-instruct"; // the bundled chat model (src/llm/model-store.ts)

function readEnvValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*=(.*)$`, "m").exec(text);
  return m ? m[1]!.trim().replace(/^['"]|['"]$/g, "") : undefined;
}

/** Replace KEY=… in place if present, else append a fresh line — preserving everything else. */
function upsertEnvValue(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return text + sep + line + "\n";
}

/** Delete KEY=… lines entirely — used to scrub settings the product no longer supports. */
function removeEnvValue(text: string, key: string): string {
  return text.replace(new RegExp(`^\\s*${key}\\s*=.*\\n?`, "gm"), "");
}

/**
 * Retired CAPTCHA-solver settings (commercial M0): ApplyPilot never solves or bypasses CAPTCHAs,
 * so these keys are no longer read anywhere. Scrub them from `.env` and the live process env on
 * the next settings save so stale solver credentials don't linger on user machines.
 */
const RETIRED_ENV_KEYS = [
  "APPLYPILOT_CAPTCHA_API_KEY",
  "APPLYPILOT_CAPTCHA_PROVIDER",
  "APPLYPILOT_CAPTCHA_API_URL",
  // Replaced by APPLYPILOT_SOURCE_POLICY (commercial M4) — no code reads this flag anymore.
  "APPLYPILOT_ENABLE_LINKEDIN_INDEED",
] as const;

/**
 * A `getSecret` for the finder connectors: maps their `keys.*` identifiers to the
 * raw values stored in `.env` / process.env. Only the FREE public USAJOBS key is
 * wired (owner amendment — federal search); paid aggregators stay unmapped (null).
 * Reads the file fresh so a key added mid-session is picked up on the next pass.
 */
export function finderSecretLookup(envPath: string): (key: string) => string | null {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const read = (envName: string): string | null =>
    (readEnvValue(text, envName) || process.env[envName]?.trim() || "") || null;
  const MAP: Record<string, string> = {
    "keys.usajobs.api_key": "APPLYPILOT_USAJOBS_KEY",
    "keys.usajobs.user_agent_email": "APPLYPILOT_USAJOBS_EMAIL",
  };
  return (key: string) => (MAP[key] ? read(MAP[key]!) : null);
}

export function readSettings(envPath: string): AppSettings {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const key = readEnvValue(text, "ANTHROPIC_API_KEY") || process.env.ANTHROPIC_API_KEY?.trim() || "";
  const llmBaseUrl = readEnvValue(text, "APPLYPILOT_LLM_BASE_URL") || process.env.APPLYPILOT_LLM_BASE_URL?.trim() || "";
  const rawModel = readEnvValue(text, "APPLYPILOT_LLM_MODEL") || process.env.APPLYPILOT_LLM_MODEL?.trim() || "";
  // Legacy configs (pre-"embedded") that set a base URL or an Ollama-style "name:tag" model
  // without a provider meant a local HTTP server — keep them there (mirrors loadLlmConfig).
  const legacyDefault = key ? "anthropic" : llmBaseUrl || rawModel.includes(":") ? "ollama" : "embedded";
  const llmProvider = parseLlmProvider(
    readEnvValue(text, "APPLYPILOT_LLM_PROVIDER") || process.env.APPLYPILOT_LLM_PROVIDER || legacyDefault
  );
  const llmApiKey =
    readEnvValue(text, "APPLYPILOT_LLM_API_KEY") || process.env.APPLYPILOT_LLM_API_KEY?.trim() || key;
  const providerDefaultModel =
    llmProvider === "embedded" ? DEFAULT_MODEL
    : llmProvider === "ollama" ? "gemma4:e4b"
    : llmProvider === "openai-compatible" ? "local-model"
    : "claude-sonnet-4-6";
  const llmModel =
    readEnvValue(text, "APPLYPILOT_LLM_MODEL") ||
    process.env.APPLYPILOT_LLM_MODEL?.trim() ||
    readEnvValue(text, "ANTHROPIC_MODEL") ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    providerDefaultModel;
  // "Configured" must mean "will actually work": the embedded provider is only configured once
  // its model files are on disk — this drives the Settings badge and the Welcome download prompt.
  const llmConfigured =
    llmProvider === "anthropic" ? llmApiKey.length > 0
    : llmProvider === "embedded" ? allModelsPresent()
    : Boolean(llmModel);
  const llmMode: AppSettings["llmMode"] =
    llmProvider === "embedded" ? "bundled"
    : llmProvider === "anthropic" && llmConfigured ? "cloud"
    : llmProvider !== "anthropic" ? "local"
    : "builtin";
  const qualityMode = parseFlag(
    readEnvValue(text, "APPLYPILOT_QUALITY_MODE") || process.env.APPLYPILOT_QUALITY_MODE
  );
  const maxAgeRaw = readEnvValue(text, "APPLYPILOT_MAX_AGE_DAYS") ?? process.env.APPLYPILOT_MAX_AGE_DAYS;
  const maxAgeNum = Number(maxAgeRaw);
  const maxAgeDays = maxAgeRaw !== undefined && Number.isFinite(maxAgeNum) && maxAgeNum >= 0 ? Math.round(maxAgeNum) : 7;
  // Daily-run schedule (commercial M9-C). Default OFF: an unattended automation trigger must be opt-in.
  const scheduleEnabled = parseFlag(
    readEnvValue(text, "APPLYPILOT_SCHEDULE_ENABLED") ?? process.env.APPLYPILOT_SCHEDULE_ENABLED
  );
  const scheduleHourRaw = readEnvValue(text, "APPLYPILOT_SCHEDULE_HOUR") ?? process.env.APPLYPILOT_SCHEDULE_HOUR;
  const scheduleHourNum = Number(scheduleHourRaw);
  const scheduleHour =
    scheduleHourRaw !== undefined && Number.isFinite(scheduleHourNum)
      ? Math.min(23, Math.max(0, Math.round(scheduleHourNum)))
      : 7;
  const adzunaAppId  = readEnvValue(text, "APPLYPILOT_ADZUNA_APP_ID")  || process.env.APPLYPILOT_ADZUNA_APP_ID?.trim()  || "";
  const adzunaAppKey = readEnvValue(text, "APPLYPILOT_ADZUNA_APP_KEY") || process.env.APPLYPILOT_ADZUNA_APP_KEY?.trim() || "";
  const joobleKey    = readEnvValue(text, "APPLYPILOT_JOOBLE_KEY")     || process.env.APPLYPILOT_JOOBLE_KEY?.trim()     || "";
  const usajobsKey   = readEnvValue(text, "APPLYPILOT_USAJOBS_KEY")    || process.env.APPLYPILOT_USAJOBS_KEY?.trim()    || "";
  const usajobsEmail = readEnvValue(text, "APPLYPILOT_USAJOBS_EMAIL")  || process.env.APPLYPILOT_USAJOBS_EMAIL?.trim()  || "";
  return {
    hasKey: llmConfigured,
    keyHint: llmApiKey.length > 0 ? "…" + llmApiKey.slice(-4) : null,
    model: llmModel,
    llmProvider,
    llmBaseUrl: llmBaseUrl || null,
    llmConfigured,
    llmMode,
    qualityMode,
    maxAgeDays,
    scheduleEnabled,
    scheduleHour,
    adzunaConfigured: adzunaAppId.length > 0 && adzunaAppKey.length > 0,
    adzunaAppIdHint:  adzunaAppId.length  > 0 ? "…" + adzunaAppId.slice(-4)  : null,
    adzunaAppKeyHint: adzunaAppKey.length > 0 ? "…" + adzunaAppKey.slice(-4) : null,
    joobleConfigured: joobleKey.length > 0,
    joobleKeyHint:    joobleKey.length  > 0 ? "…" + joobleKey.slice(-4)  : null,
    usajobsConfigured: usajobsKey.length > 0 && usajobsEmail.length > 0,
    usajobsKeyHint:   usajobsKey.length   > 0 ? "…" + usajobsKey.slice(-4)   : null,
    usajobsEmailHint: usajobsEmail.length > 0 ? usajobsEmail.replace(/^(.).*(@.*)$/, "$1…$2") : null,
  };
}

export interface SettingsInput {
  apiKey?: string;
  model?: string;
  llmProvider?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  qualityMode?: boolean;
  /** Recency window in days for discovery (brief §2b). 0 disables the gate. */
  maxAgeDays?: number;
  /** Daily scheduled automation (commercial M9-C). */
  scheduleEnabled?: boolean;
  scheduleHour?: number;
  /** Adzuna REST API credentials (developer.adzuna.com). */
  adzunaAppId?: string;
  adzunaAppKey?: string;
  /** Jooble partner key (developer.jooble.org). */
  joobleKey?: string;
  /** USAJOBS API key + registered email (developer.usajobs.gov). */
  usajobsKey?: string;
  usajobsEmail?: string;
}

export function writeSettings(envPath: string, input: SettingsInput): AppSettings {
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

  // Only overwrite the key when a non-empty value is supplied (an empty field means "leave it").
  if (typeof input.apiKey === "string" && input.apiKey.trim() !== "") {
    const k = input.apiKey.trim();
    text = upsertEnvValue(text, "ANTHROPIC_API_KEY", k);
    text = upsertEnvValue(text, "APPLYPILOT_LLM_API_KEY", k);
    text = upsertEnvValue(text, "APPLYPILOT_LLM_PROVIDER", "anthropic");
    process.env.ANTHROPIC_API_KEY = k;
    process.env.APPLYPILOT_LLM_API_KEY = k;
    process.env.APPLYPILOT_LLM_PROVIDER = "anthropic";
  }
  if (typeof input.llmApiKey === "string" && input.llmApiKey.trim() !== "") {
    const k = input.llmApiKey.trim();
    text = upsertEnvValue(text, "APPLYPILOT_LLM_API_KEY", k);
    process.env.APPLYPILOT_LLM_API_KEY = k;
  }
  if (typeof input.llmProvider === "string" && input.llmProvider.trim() !== "") {
    const p = parseLlmProvider(input.llmProvider);
    text = upsertEnvValue(text, "APPLYPILOT_LLM_PROVIDER", p);
    process.env.APPLYPILOT_LLM_PROVIDER = p;
  }
  if (typeof input.llmBaseUrl === "string" && input.llmBaseUrl.trim() !== "") {
    const u = input.llmBaseUrl.trim();
    text = upsertEnvValue(text, "APPLYPILOT_LLM_BASE_URL", u);
    process.env.APPLYPILOT_LLM_BASE_URL = u;
  }
  const modelInput = input.llmModel ?? input.model;
  if (typeof modelInput === "string" && modelInput.trim() !== "") {
    const m = modelInput.trim();
    text = upsertEnvValue(text, "APPLYPILOT_LLM_MODEL", m);
    text = upsertEnvValue(text, "ANTHROPIC_MODEL", m);
    process.env.APPLYPILOT_LLM_MODEL = m;
    process.env.ANTHROPIC_MODEL = m;
  }
  for (const k of RETIRED_ENV_KEYS) {
    text = removeEnvValue(text, k);
    delete process.env[k];
  }
  if (typeof input.qualityMode === "boolean") {
    const v = input.qualityMode ? "on" : "off";
    text = upsertEnvValue(text, "APPLYPILOT_QUALITY_MODE", v);
    process.env.APPLYPILOT_QUALITY_MODE = v;
  }
  if (typeof input.maxAgeDays === "number" && Number.isFinite(input.maxAgeDays) && input.maxAgeDays >= 0) {
    const v = String(Math.round(input.maxAgeDays));
    text = upsertEnvValue(text, "APPLYPILOT_MAX_AGE_DAYS", v);
    process.env.APPLYPILOT_MAX_AGE_DAYS = v;
  }
  if (typeof input.scheduleEnabled === "boolean") {
    const v = input.scheduleEnabled ? "on" : "off";
    text = upsertEnvValue(text, "APPLYPILOT_SCHEDULE_ENABLED", v);
    process.env.APPLYPILOT_SCHEDULE_ENABLED = v;
  }
  if (typeof input.scheduleHour === "number" && Number.isFinite(input.scheduleHour)) {
    const v = String(Math.min(23, Math.max(0, Math.round(input.scheduleHour))));
    text = upsertEnvValue(text, "APPLYPILOT_SCHEDULE_HOUR", v);
    process.env.APPLYPILOT_SCHEDULE_HOUR = v;
  }
  if (typeof input.adzunaAppId === "string" && input.adzunaAppId.trim()) {
    const v = input.adzunaAppId.trim();
    text = upsertEnvValue(text, "APPLYPILOT_ADZUNA_APP_ID", v);
    process.env.APPLYPILOT_ADZUNA_APP_ID = v;
  }
  if (typeof input.adzunaAppKey === "string" && input.adzunaAppKey.trim()) {
    const v = input.adzunaAppKey.trim();
    text = upsertEnvValue(text, "APPLYPILOT_ADZUNA_APP_KEY", v);
    process.env.APPLYPILOT_ADZUNA_APP_KEY = v;
  }
  if (typeof input.joobleKey === "string" && input.joobleKey.trim()) {
    const v = input.joobleKey.trim();
    text = upsertEnvValue(text, "APPLYPILOT_JOOBLE_KEY", v);
    process.env.APPLYPILOT_JOOBLE_KEY = v;
  }
  if (typeof input.usajobsKey === "string" && input.usajobsKey.trim()) {
    const v = input.usajobsKey.trim();
    text = upsertEnvValue(text, "APPLYPILOT_USAJOBS_KEY", v);
    process.env.APPLYPILOT_USAJOBS_KEY = v;
  }
  if (typeof input.usajobsEmail === "string" && input.usajobsEmail.trim()) {
    const v = input.usajobsEmail.trim();
    text = upsertEnvValue(text, "APPLYPILOT_USAJOBS_EMAIL", v);
    process.env.APPLYPILOT_USAJOBS_EMAIL = v;
  }

  writeFileSync(envPath, text, { mode: 0o600 });
  // `mode` is honored only when writeFileSync CREATES the file; on an overwrite of a pre-existing .env
  // (copied from .env.example, edited by hand, first written before this guard) the perms are left as
  // found — often 0644, leaking every secret in this file. Re-assert 0600 on every write (commercial
  // M7). Best-effort: filesystems without POSIX perms (Windows) throw, which we ignore.
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* non-POSIX filesystem — perms not applicable */
  }
  resetLlmClientCache();
  resetEmbeddingClientCache();
  return readSettings(envPath);
}
