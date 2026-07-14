// src/llm/model-store.ts
//
// The bundled free-tier models: what they are, where they live on disk, and a resumable
// downloader (models are far too big for the app bundle, so first run fetches them into the
// data directory with progress + retry). Everything here is offline-safe: status never touches
// the network, and a failed/missing download simply leaves the embedded provider reporting
// "model not downloaded" while the engine's deterministic fallbacks keep working.

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig } from "../config";

export type BundledModelKind = "chat" | "embedding";

export interface BundledModel {
  id: string;
  kind: BundledModelKind;
  /** GGUF filename on disk (also the tail of the download URL). */
  file: string;
  url: string;
  /** Approximate size for progress display; the real byte count comes from Content-Length. */
  approxBytes: number;
  license: string;
  licenseUrl: string;
}

/**
 * Model picks (commercial M2, decision D11 — owner sign-off pending per brief Part 4 #5):
 * - Chat: Qwen2.5-1.5B-Instruct Q4_K_M — Apache-2.0, official GGUF from the Qwen org. Small
 *   enough for any Apple-silicon Mac, strong for its size.
 * - Embeddings: nomic-embed-text-v1.5 — Apache-2.0, and the SAME model the Ollama default used,
 *   so the semantic-fit calibration in embeddings.ts (similarityToFit) stays valid unchanged.
 */
export const BUNDLED_MODELS: readonly BundledModel[] = [
  {
    id: "qwen2.5-1.5b-instruct",
    kind: "chat",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    approxBytes: 1_120_000_000,
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF",
  },
  {
    id: "nomic-embed-text-v1.5",
    kind: "embedding",
    file: "nomic-embed-text-v1.5.Q8_0.gguf",
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf",
    approxBytes: 146_000_000,
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF",
  },
] as const;

export function bundledModel(kind: BundledModelKind): BundledModel {
  return BUNDLED_MODELS.find((m) => m.kind === kind)!;
}

/** Models live next to the database (=> under userData in the packaged app). */
export function modelsDir(): string {
  const dir = process.env.APPLYPILOT_MODELS_DIR?.trim();
  if (dir) return dir;
  return join(dirname(loadConfig().dbPath), "models");
}

export function modelPath(model: BundledModel): string {
  return join(modelsDir(), model.file);
}

export interface ModelStatus {
  id: string;
  kind: BundledModelKind;
  file: string;
  present: boolean;
  /** Bytes of a partial download awaiting resume, 0 otherwise. */
  partialBytes: number;
  approxBytes: number;
  license: string;
  downloading: boolean;
  /** 0..1 while downloading, null otherwise. */
  progress: number | null;
  error: string | null;
}

interface DownloadJob {
  progress: number;
  error: string | null;
  promise: Promise<void>;
}

const jobs = new Map<string, DownloadJob>();

export function modelStatuses(): ModelStatus[] {
  return BUNDLED_MODELS.map((m) => {
    const path = modelPath(m);
    const part = `${path}.part`;
    const job = jobs.get(m.id);
    return {
      id: m.id,
      kind: m.kind,
      file: m.file,
      present: existsSync(path),
      partialBytes: existsSync(part) ? statSync(part).size : 0,
      approxBytes: m.approxBytes,
      license: m.license,
      downloading: Boolean(job && !job.error),
      progress: job && !job.error ? job.progress : null,
      error: job?.error ?? null,
    };
  });
}

export function allModelsPresent(): boolean {
  return BUNDLED_MODELS.every((m) => existsSync(modelPath(m)));
}

/**
 * Download one model with resume (.part + HTTP Range) and retry. Concurrent calls for the same
 * model share one job. Resolves when the file is fully in place; rejects after the final retry.
 */
export function downloadModel(model: BundledModel, onProgress?: (fraction: number) => void): Promise<void> {
  const existing = jobs.get(model.id);
  if (existing && !existing.error) return existing.promise;

  const job: DownloadJob = { progress: 0, error: null, promise: Promise.resolve() };
  job.promise = (async () => {
    const target = modelPath(model);
    if (existsSync(target)) {
      job.progress = 1;
      return;
    }
    mkdirSync(modelsDir(), { recursive: true });
    const part = `${target}.part`;
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await fetchToFile(model.url, part, (fraction) => {
          job.progress = fraction;
          onProgress?.(fraction);
        });
        renameSync(part, target);
        rmSync(`${part}.etag`, { force: true });
        job.progress = 1;
        return;
      } catch (err) {
        if (attempt === attempts) {
          job.error = err instanceof Error ? err.message : String(err);
          throw err;
        }
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  })();
  jobs.set(model.id, job);
  job.promise.then(
    // Success: forget the job so status stops saying "downloading" and a deleted/corrupted file
    // can be re-downloaded later in the same engine session.
    () => {
      if (jobs.get(model.id) === job) jobs.delete(model.id);
    },
    // Failure: keep the errored job visible in status; the next downloadModel call replaces it.
    () => {}
  );
  return job.promise;
}

/** Test hook: clear job state between tests. */
export function resetModelJobs(): void {
  jobs.clear();
}

async function fetchToFile(url: string, part: string, onProgress: (fraction: number) => void): Promise<void> {
  const have = existsSync(part) ? statSync(part).size : 0;
  const etagFile = `${part}.etag`;
  const etag = existsSync(etagFile) ? readFileSync(etagFile, "utf8").trim() : "";
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      ...(have > 0 ? { range: `bytes=${have}-` } : {}),
      // If-Range: a changed upstream file answers 200 (full body) instead of 206, so a resume can
      // never concatenate two different revisions of the model.
      ...(have > 0 && etag ? { "if-range": etag } : {}),
    },
  });
  // Order matters: transient errors (5xx/429) must NOT touch the partial file — only a genuine
  // 200 (server ignored/invalidated the Range) restarts the download from scratch.
  if (!res.ok && res.status !== 206) {
    throw new Error(`Model download failed (${res.status}) for ${url}`);
  }
  const resuming = res.status === 206;
  if (!resuming && have > 0) rmSync(part, { force: true });
  if (!res.body) throw new Error("Model download returned no body");
  const resEtag = res.headers.get("etag");
  if (!resuming && resEtag) writeFileSync(etagFile, resEtag);

  const total =
    Number(res.headers.get("content-length") ?? 0) + (resuming ? have : 0) || 0;
  let received = resuming ? have : 0;
  const counter = async function* (source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      received += chunk.length;
      if (total > 0) onProgress(Math.min(0.999, received / total));
      yield chunk;
    }
  };
  await pipeline(
    counter(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream)),
    createWriteStream(part, { flags: resuming ? "a" : "w" })
  );
  // The stream can end early on a dropped connection without erroring — verify byte count.
  if (total > 0 && statSync(part).size !== total) {
    throw new Error(`Model download incomplete: got ${statSync(part).size} of ${total} bytes`);
  }
  onProgress(1);
}
