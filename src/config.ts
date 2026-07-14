// src/config.ts
//
// Loads local, single-user configuration from `.env` (never committed). Nothing here leaves
// the machine. The Anthropic key is OPTIONAL for Milestone 1: the deterministic anti-
// fabrication gate and the heuristic resume parser run without it.

import type { LlmProviderId } from "./llm/config";
import { parseLlmProvider } from "./llm/config";

let envLoaded = false;
function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  // Node >=20.12 ships process.loadEnvFile(); absent/missing .env is fine.
  // The packaged app roots all mutable state under the OS user-data dir and points
  // APPLYPILOT_ENV_PATH there; dev keeps the repo-relative ./.env default.
  const envPath = process.env.APPLYPILOT_ENV_PATH?.trim();
  try {
    const load = (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile;
    envPath ? load(envPath) : load();
  } catch {
    /* no .env file present — rely on real environment variables */
  }
}

export interface AppConfig {
  dbPath: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  llmProvider?: LlmProviderId;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  /** Local embedding model for semantic résumé/job matching (free, e.g. Ollama nomic-embed-text). */
  embedModel?: string;
  embedBaseUrl?: string;
  embedApiKey?: string;
  /** 32-byte AES-256-GCM key, or undefined when encryption-at-rest is disabled. */
  encryptionKey?: Buffer;
  /** Enables the seeded demo profile as a live profile. Off by default for normal local use. */
  demoMode: boolean;
}

/** Parse a 32-byte key supplied as hex (64 chars) or base64. */
export function parseEncryptionKey(raw: string | undefined): Buffer | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const v = raw.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    key = Buffer.from(v, "hex");
  } else {
    key = Buffer.from(v, "base64");
  }
  if (key.length !== 32) {
    throw new Error(
      `APPLYPILOT_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return key;
}

function parseFlag(raw: string | undefined): boolean {
  return /^(on|true|1|yes)$/i.test((raw ?? "").trim());
}

export function loadConfig(): AppConfig {
  ensureEnvLoaded();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const llmProvider = process.env.APPLYPILOT_LLM_PROVIDER?.trim();
  const llmBaseUrl = process.env.APPLYPILOT_LLM_BASE_URL?.trim();
  const llmApiKey = process.env.APPLYPILOT_LLM_API_KEY?.trim();
  const llmModel = process.env.APPLYPILOT_LLM_MODEL?.trim();
  const embedModel = process.env.APPLYPILOT_EMBED_MODEL?.trim();
  const embedBaseUrl = process.env.APPLYPILOT_EMBED_BASE_URL?.trim();
  const embedApiKey = process.env.APPLYPILOT_EMBED_API_KEY?.trim();
  return {
    dbPath: process.env.APPLYPILOT_DB_PATH?.trim() || "./data/applypilot.sqlite",
    anthropicApiKey: apiKey && apiKey !== "" ? apiKey : undefined,
    anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6",
    encryptionKey: parseEncryptionKey(process.env.APPLYPILOT_ENCRYPTION_KEY),
    llmProvider: llmProvider ? parseLlmProvider(llmProvider) : undefined,
    llmBaseUrl: llmBaseUrl && llmBaseUrl !== "" ? llmBaseUrl : undefined,
    llmApiKey: llmApiKey && llmApiKey !== "" ? llmApiKey : undefined,
    llmModel: llmModel && llmModel !== "" ? llmModel : undefined,
    embedModel: embedModel && embedModel !== "" ? embedModel : undefined,
    embedBaseUrl: embedBaseUrl && embedBaseUrl !== "" ? embedBaseUrl : undefined,
    embedApiKey: embedApiKey && embedApiKey !== "" ? embedApiKey : undefined,
    demoMode: parseFlag(process.env.APPLYPILOT_DEMO_MODE),
  };
}
