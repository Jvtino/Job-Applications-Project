// src/llm/embedded.ts
//
// The bundled in-process LLM provider (commercial M2): node-llama-cpp running the redistributable
// GGUF models from model-store.ts — no Ollama install, no localhost daemon, Metal on macOS.
//
// Design notes:
// - node-llama-cpp is ESM-only and loads a native binding, so it is imported lazily via dynamic
//   import(); the esbuild engine bundle keeps it external and loads it from node_modules.
// - The loaded model is cached per file (expensive); each complete() gets a fresh context +
//   chat session so calls stay stateless, and the context is disposed afterwards.
// - Serialized with a simple promise chain: one local model, one CPU/GPU — concurrent prompts
//   would just thrash memory. Callers already tolerate slow local models via withLlmTimeout.
// - A missing model file throws ModelNotDownloadedError — callers catch and fall back to the
//   deterministic paths, and /api/llm/status reports it with a "download" call to action.

import { existsSync } from "node:fs";
import type { LlmClient, LlmCompleteOptions } from "./types";
import { recordLlmUsage, resolveLlmTimeoutMs, withLlmTimeout } from "./types";
import type { EmbeddingClient } from "./embeddings";
import { bundledModel, modelPath } from "./model-store";

export class ModelNotDownloadedError extends Error {
  constructor(file: string) {
    super(`Bundled model not downloaded yet: ${file}. Download it from Settings (or POST /api/llm/models/download).`);
    this.name = "ModelNotDownloadedError";
  }
}

// Types are structural stand-ins for node-llama-cpp's (ESM-only, so no static type import here
// without pulling the module into the CJS bundle graph).
interface LlamaModelLike {
  createContext(opts?: { contextSize?: number }): Promise<{
    getSequence(): unknown;
    dispose(): Promise<void>;
  }>;
  createEmbeddingContext(): Promise<{
    getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }>;
  }>;
}

let llamaRuntime: Promise<unknown> | undefined;
const loadedModels = new Map<string, Promise<LlamaModelLike>>();
let queue: Promise<unknown> = Promise.resolve();

/** Serialize all embedded inference — one small local model, one job at a time. */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

async function getRuntime(): Promise<{
  getLlama: (opts?: object) => Promise<{ loadModel(opts: { modelPath: string }): Promise<LlamaModelLike> }>;
  LlamaChatSession: new (opts: { contextSequence: unknown; systemPrompt?: string }) => {
    prompt(text: string, opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<string>;
  };
}> {
  llamaRuntime ??= import("node-llama-cpp");
  return (await llamaRuntime) as Awaited<ReturnType<typeof getRuntime>>;
}

async function loadModel(file: string, path: string): Promise<LlamaModelLike> {
  let loading = loadedModels.get(file);
  if (!loading) {
    loading = (async () => {
      const { getLlama } = await getRuntime();
      const llama = await getLlama();
      return (await llama.loadModel({ modelPath: path })) as LlamaModelLike;
    })();
    // A failed load (corrupt file, OOM) must be retryable rather than cached forever.
    loading.catch(() => loadedModels.delete(file));
    loadedModels.set(file, loading);
  }
  return loading;
}

/** Test hook: forget loaded models (they hold native memory). */
export function resetEmbeddedRuntime(): void {
  loadedModels.clear();
}

export function createEmbeddedClient(): LlmClient {
  const spec = bundledModel("chat");
  return {
    model: spec.id,
    provider: "embedded",
    async complete(prompt: string, opts: LlmCompleteOptions = {}) {
      const path = modelPath(spec);
      if (!existsSync(path)) throw new ModelNotDownloadedError(spec.file);
      const timeoutMs = resolveLlmTimeoutMs(opts.timeoutMs);
      return enqueue(() =>
        withLlmTimeout(timeoutMs, `Embedded LLM (${spec.id})`, async (signal) => {
          const { LlamaChatSession } = await getRuntime();
          const model = await loadModel(spec.file, path);
          const context = await model.createContext();
          try {
            const session = new LlamaChatSession({
              contextSequence: context.getSequence(),
              ...(opts.system ? { systemPrompt: opts.system } : {}),
            });
            const text = await session.prompt(prompt, {
              ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
              signal,
            });
            // The bundled model costs nothing per token; record the call for the usage view
            // without token counts (llama.cpp counts aren't surfaced through this session API).
            recordLlmUsage({ provider: "embedded", model: spec.id, feature: opts.feature ?? "unknown", cached: false });
            return { text };
          } finally {
            await context.dispose().catch(() => {});
          }
        })
      );
    },
  };
}

/**
 * Embed one text, halving it on "input longer than the context size" errors — node-llama-cpp does
 * NOT truncate (it throws), and the embedding model's context (~2048 tokens for nomic-embed) is
 * smaller than some profile/JD texts. Halving converges in a few steps and a truncated embedding
 * is far better for matching than none at all.
 */
async function embedTruncating(
  ctx: { getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }> },
  text: string
): Promise<number[]> {
  let t = text;
  for (;;) {
    try {
      return [...(await ctx.getEmbeddingFor(t)).vector];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/context size/i.test(msg) && t.length > 500) {
        t = t.slice(0, Math.floor(t.length / 2));
        continue;
      }
      throw err;
    }
  }
}

export function createEmbeddedEmbeddingClient(): EmbeddingClient {
  const spec = bundledModel("embedding");
  let embedContext: Promise<{ getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }> }> | undefined;
  return {
    model: spec.id,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const path = modelPath(spec);
      if (!existsSync(path)) throw new ModelNotDownloadedError(spec.file);
      return enqueue(() =>
        withLlmTimeout(resolveLlmTimeoutMs(), `Embedded embeddings (${spec.id})`, async (signal) => {
          if (!embedContext) {
            embedContext = loadModel(spec.file, path).then((m) => m.createEmbeddingContext());
            embedContext.catch(() => (embedContext = undefined));
          }
          const ctx = await embedContext;
          const out: number[][] = [];
          for (const text of texts) {
            // getEmbeddingFor has no cancellation — but stopping between items keeps a timed-out
            // batch from monopolizing the serialized queue for its full remaining length.
            if (signal.aborted) throw new Error(`Embedded embeddings (${spec.id}) aborted`);
            out.push(await embedTruncating(ctx, text));
          }
          return out;
        })
      );
    },
  };
}
