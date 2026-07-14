// Local embedding client for semantic résumé <-> job-description matching.
//
// Free and local by default: the BUNDLED in-process embedding model (nomic-embed-text-v1.5 via
// node-llama-cpp) with no external install. Power users who already run Ollama/vLLM can point
// APPLYPILOT_EMBED_BASE_URL/_MODEL at an OpenAI-compatible /embeddings endpoint instead. There is
// NO cloud dependency — if the model is unavailable the caller falls back to lexical scoring, so
// nothing breaks offline.

import { loadConfig } from "../config";
import { loadLlmConfig } from "./config";
import { createEmbeddedEmbeddingClient } from "./embedded";
import { resolveLlmTimeoutMs, withLlmTimeout } from "./types";

export interface EmbeddingConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface EmbeddingClient {
  model: string;
  /** Embed a batch of texts. Throws on transport/model errors so callers can fall back. */
  embed(texts: string[]): Promise<number[][]>;
}

const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_EMBED_BASE_URL = "http://localhost:11434/v1";

/**
 * Resolve the HTTP embedding endpoint — only used when embeddings are NOT served by the bundled
 * in-process model (see getEmbeddingClient): i.e. when APPLYPILOT_EMBED_* is set explicitly, or
 * the chat provider is a non-embedded local server whose endpoint historically served embeddings.
 */
export function loadEmbeddingConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  const cfg = loadConfig();
  const llm = loadLlmConfig();
  // Anthropic + embedded serve embeddings from the bundled local model, so their chat config must
  // not leak into the HTTP embedding endpoint; only a local HTTP chat provider's endpoint is reused.
  const localLlm =
    llm && llm.provider !== "anthropic" && llm.provider !== "embedded" ? llm : null;

  const model = overrides.model ?? cfg.embedModel ?? DEFAULT_EMBED_MODEL;
  const baseUrl = (overrides.baseUrl ?? cfg.embedBaseUrl ?? localLlm?.baseUrl ?? DEFAULT_EMBED_BASE_URL).replace(
    /\/+$/,
    ""
  );
  const apiKey = overrides.apiKey ?? cfg.embedApiKey ?? localLlm?.apiKey;
  return { model, baseUrl, ...(apiKey ? { apiKey } : {}) };
}

/**
 * The bundled in-process embedder serves by default. An explicitly configured HTTP endpoint or
 * embed model (APPLYPILOT_EMBED_BASE_URL / APPLYPILOT_EMBED_MODEL) opts back into HTTP, as does
 * selecting a non-embedded local chat provider (its endpoint historically served embeddings too).
 */
function shouldUseEmbeddedEmbeddings(): boolean {
  const cfg = loadConfig();
  if (cfg.embedBaseUrl || cfg.embedModel) return false;
  const llm = loadLlmConfig();
  const chatProvider = llm?.provider ?? "embedded";
  return chatProvider === "embedded" || chatProvider === "anthropic";
}

function createClient(config: EmbeddingConfig): EmbeddingClient {
  const url = `${config.baseUrl}/embeddings`;
  return {
    model: config.model,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      return withLlmTimeout(resolveLlmTimeoutMs(), `Embeddings (${config.model})`, async (signal) => {
        const res = await fetch(url, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: config.model, input: texts }),
        });
        if (!res.ok) {
          throw new Error(`Embedding request failed (${res.status}): ${await res.text().catch(() => "")}`);
        }
        const json = (await res.json()) as { data?: { embedding?: number[] }[] };
        const data = json.data ?? [];
        if (data.length !== texts.length) {
          throw new Error(`Embedding count mismatch: asked ${texts.length}, got ${data.length}`);
        }
        return data.map((d) => {
          if (!Array.isArray(d.embedding) || d.embedding.length === 0) {
            throw new Error("Embedding response missing vector");
          }
          return d.embedding;
        });
      });
    },
  };
}

let cached: EmbeddingClient | null | undefined;

/** Test hook: clear the cached embedding client. */
export function resetEmbeddingClientCache(): void {
  cached = undefined;
}

/**
 * Returns an embedding client, or null when embeddings are disabled. We treat embeddings as
 * available whenever a local/OpenAI-compatible endpoint is resolvable (the actual reachability is
 * verified lazily on first use, where failures fall back to lexical scoring).
 */
export function getEmbeddingClient(): EmbeddingClient | null {
  if (cached !== undefined) return cached;
  if (shouldUseEmbeddedEmbeddings()) {
    // embedded.ts itself defers the node-llama-cpp import until first use, so this is cheap.
    cached = createEmbeddedEmbeddingClient();
    return cached;
  }
  const config = loadEmbeddingConfig();
  cached = config.baseUrl && config.model ? createClient(config) : null;
  return cached;
}

/** Cosine similarity of two equal-length vectors, in [-1, 1] (0 when either is degenerate). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Map cosine similarity (roughly [0,1] for related text) into a 0..1 fit contribution. */
export function similarityToFit(cosine: number): number {
  // nomic-embed-text similarities for related text cluster around 0.4-0.8; rescale so 0.4->0,
  // 0.85->1, clamped. This keeps the semantic signal meaningful rather than uniformly high.
  const scaled = (cosine - 0.4) / 0.45;
  return Math.max(0, Math.min(1, scaled));
}
