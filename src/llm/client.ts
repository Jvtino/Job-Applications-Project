// LLM client factory — bundled in-process model by default, Ollama/OpenAI-compatible/Anthropic optional.
//
// Two client getters remain for historical call sites:
//   - getLlmClient()      — used by every PII-bearing feature (résumé parse, doc generation, ledger
//                           judge, field match, …).
//   - getReasonerClient() — used by the PII-free job-fit reasoner (job-rerank).
// Both resolve to the same local/Anthropic client; the paid cloud proxy tier has been removed.

import { loadLlmConfig, type LlmConfig } from "./config";
import { createAnthropicClient } from "./anthropic-provider";
import { createOpenAiCompatibleClient } from "./openai-compatible";
import { createEmbeddedClient } from "./embedded";
import type { LlmClient } from "./types";

export type { LlmClient } from "./types";
export { extractJson } from "./types";
export { loadLlmConfig, parseLlmProvider, llmProviderLabel, providerNeedsApiKey, isLlmConfigured } from "./config";

let cachedLocal: LlmClient | null | undefined;
let cachedReasoner: LlmClient | null | undefined;

/** Test hook + live provider-swap hook (writeSettings → resetLlmClientCache): clear both clients. */
export function resetLlmClientCache(): void {
  cachedLocal = undefined;
  cachedReasoner = undefined;
}

/** The client for PII-bearing features (résumé/EEO/contact data stays on the local/Anthropic path). */
function buildLocalClient(config: LlmConfig): LlmClient {
  if (config.provider === "anthropic") return createAnthropicClient(config);
  if (config.provider === "embedded") return createEmbeddedClient();
  return createOpenAiCompatibleClient(config);
}

/** The client for the PII-free job-fit reasoner. Same resolution as the local client. */
function buildReasonerClient(config: LlmConfig): LlmClient {
  return buildLocalClient(config);
}

/** Client for PII-bearing features. Null when no LLM is configured (e.g. Anthropic without a key). */
export function getLlmClient(): LlmClient | null {
  if (cachedLocal !== undefined) return cachedLocal;
  const config = loadLlmConfig();
  cachedLocal = config ? buildLocalClient(config) : null;
  return cachedLocal;
}

/** Client for the job-fit reasoner (job-rerank). Resolves to the same local/Anthropic client. */
export function getReasonerClient(): LlmClient | null {
  if (cachedReasoner !== undefined) return cachedReasoner;
  const config = loadLlmConfig();
  cachedReasoner = config ? buildReasonerClient(config) : null;
  return cachedReasoner;
}
