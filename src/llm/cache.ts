// Content-addressed cache for LLM completions, backed by the local SQLite DB.
//
// Local models are slow and metered cloud calls cost money; caching keyed by a hash of
// model + kind + payload makes repeated work effectively free. Kinds carry a template version
// suffix (e.g. "job-reasoner@v1") so prompt-template changes invalidate cleanly. Purely an
// optimization — a cache miss just recomputes; entries expire after CACHE_TTL_DAYS.

import { createHash } from "node:crypto";
import type { DB } from "../db/database";
import type { LlmClient, LlmCompleteOptions } from "./types";
import { recordLlmUsage } from "./types";

export const CACHE_TTL_DAYS = 30;

export function cacheKey(model: string, kind: string, payload: string): string {
  return createHash("sha256").update(`${model}\u0000${kind}\u0000${payload}`).digest("hex");
}

export class LlmCacheRepo {
  constructor(private readonly db: DB) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM llm_cache WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO llm_cache (key, value, created_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`
      )
      .run(key, value, new Date().toISOString());
  }

  /** Drop entries older than the TTL. Cheap; called once at server start. */
  prune(maxAgeDays = CACHE_TTL_DAYS): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000).toISOString();
    return this.db.prepare("DELETE FROM llm_cache WHERE created_at < ?").run(cutoff).changes;
  }
}

// ---- Default cache registry ---------------------------------------------------------------
// Deep call sites (resume parsing, document generation) have no DB handle; the API server
// installs its cache here so they can opt in without threading `db` through every signature.
// CLI paths without a server simply run uncached.

let defaultCache: LlmCacheRepo | null = null;

export function setDefaultLlmCache(cache: LlmCacheRepo | null): void {
  defaultCache = cache;
}

export function getDefaultLlmCache(): LlmCacheRepo | null {
  return defaultCache;
}

/**
 * complete() with content-addressed caching. A hit is recorded as a cached (never billed) call;
 * a miss runs the model, VALIDATES the completion (a malformed/truncated output must never be
 * cached — stochastic providers deserve a fresh sample on retry, not a 30-day poisoned entry),
 * then stores the raw text. Cache read/write failures degrade to uncached completions.
 */
export async function cachedComplete(
  cache: LlmCacheRepo | null,
  client: LlmClient,
  kind: string,
  prompt: string,
  opts: LlmCompleteOptions & { validate?: (text: string) => void } = {}
): Promise<string> {
  const { validate, ...completeOpts } = opts;
  if (!cache) {
    const out = await client.complete(prompt, completeOpts);
    validate?.(out.text);
    return out.text;
  }
  const key = cacheKey(client.model, kind, `${completeOpts.system ?? ""}\u0000${prompt}`);
  let hit: string | null = null;
  try {
    hit = cache.get(key);
  } catch {
    /* a broken cache read is a miss, never a failed completion */
  }
  if (hit !== null) {
    recordLlmUsage({ provider: client.provider, model: client.model, feature: completeOpts.feature ?? kind, cached: true });
    return hit;
  }
  const out = await client.complete(prompt, completeOpts);
  validate?.(out.text); // throws => caller's fail-soft path runs and nothing is cached
  try {
    cache.set(key, out.text);
  } catch {
    /* caching is best-effort */
  }
  return out.text;
}
