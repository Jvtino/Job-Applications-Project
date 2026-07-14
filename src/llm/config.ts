// LLM provider configuration — bundled in-process model by default (commercial M2), with
// Ollama / OpenAI-compatible endpoints and Anthropic (cloud) as opt-in alternatives.

import { loadConfig } from "../config";

export type LlmProviderId = "embedded" | "ollama" | "openai-compatible" | "anthropic";

export interface LlmConfig {
  provider: LlmProviderId;
  model: string;
  /** Empty for the in-process embedded provider (no HTTP endpoint involved). */
  baseUrl: string;
  apiKey?: string;
}

const DEFAULTS: Record<LlmProviderId, { baseUrl: string; model: string }> = {
  embedded: { baseUrl: "", model: "qwen2.5-1.5b-instruct" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "gemma4:e4b" },
  "openai-compatible": { baseUrl: "http://localhost:8080/v1", model: "local-model" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-6" },
};

export function parseLlmProvider(raw: string | undefined): LlmProviderId {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "embedded" || v === "bundled" || v === "builtin") return "embedded";
  if (v === "ollama" || v === "local") return "ollama";
  if (v === "openai" || v === "openai-compatible" || v === "compatible" || v === "vllm" || v === "localai") {
    return "openai-compatible";
  }
  if (v === "anthropic" || v === "claude") return "anthropic";
  return "embedded";
}

export function llmProviderLabel(id: LlmProviderId): string {
  switch (id) {
    case "embedded":
      return "Bundled (built-in, no setup)";
    case "ollama":
      return "Ollama (local, open source)";
    case "openai-compatible":
      return "OpenAI-compatible (LocalAI, vLLM, etc.)";
    case "anthropic":
      return "Anthropic Claude (cloud)";
  }
}

export function providerNeedsApiKey(id: LlmProviderId): boolean {
  return id === "anthropic";
}

/**
 * Infer the provider for legacy configs written before "embedded" existed: an explicit base URL
 * (or an Ollama-style "name:tag" model) without APPLYPILOT_LLM_PROVIDER meant a local HTTP server,
 * and silently rerouting those users to the bundled model would kill their working setup.
 */
function inferLegacyProvider(baseUrl: string | undefined, model: string | undefined): LlmProviderId | null {
  if (baseUrl) return "ollama";
  if (model?.includes(":")) return "ollama";
  return null;
}

/** Resolve config from env. Defaults to the bundled model when no provider is chosen. */
export function loadLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig | null {
  const cfg = loadConfig();
  const legacyAnthropicKey = cfg.anthropicApiKey;
  const legacyAnthropicModel = cfg.anthropicModel;

  const provider =
    overrides.provider ??
    cfg.llmProvider ??
    (legacyAnthropicKey ? ("anthropic" as const) : null) ??
    inferLegacyProvider(cfg.llmBaseUrl, cfg.llmModel) ??
    ("embedded" as const);

  const defaults = DEFAULTS[provider];
  const model = overrides.model ?? cfg.llmModel ?? (provider === "anthropic" ? legacyAnthropicModel : defaults.model);

  // APPLYPILOT_LLM_BASE_URL is provider-agnostic and often holds a stale localhost URL from an
  // earlier Ollama setup — it must never leak into the Anthropic client (which would then request
  // http://localhost:11434/v1/v1/messages). Anthropic re-pointing uses its own var.
  const configuredBaseUrl =
    provider === "anthropic"
      ? process.env.APPLYPILOT_ANTHROPIC_BASE_URL?.trim() || defaults.baseUrl
      : overrides.baseUrl ?? cfg.llmBaseUrl ?? defaults.baseUrl;
  const baseUrl = (overrides.baseUrl ?? configuredBaseUrl).replace(/\/+$/, "");
  const apiKey = overrides.apiKey ?? cfg.llmApiKey ?? (provider === "anthropic" ? legacyAnthropicKey : undefined);

  if (provider === "anthropic" && !apiKey) return null;
  return { provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) };
}

export function isLlmConfigured(config: LlmConfig | null): boolean {
  if (!config) return false;
  if (config.provider === "anthropic") return Boolean(config.apiKey);
  if (config.provider === "embedded") return Boolean(config.model);
  return Boolean(config.baseUrl && config.model);
}
