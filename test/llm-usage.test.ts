// Usage metering + completion cache + capability resolver (commercial M3).
//
// The metering contract billing will reconcile against: every completion reports an event
// (provider/model/feature/tokens, never text), cache hits are marked cached (never billed),
// and the capability resolver is the single source of "is feature X on?".

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { LlmUsageRepo } from "../src/db/llm-usage-repo";
import { cachedComplete, LlmCacheRepo } from "../src/llm/cache";
import { recordLlmUsage, setLlmUsageSink, type LlmClient, type LlmUsageEvent } from "../src/llm/types";
import { aiCapability } from "../src/llm/capabilities";

const dirs: string[] = [];
let db: DB | null = null;
afterEach(() => {
  setLlmUsageSink(null);
  db?.close();
  db = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDb(): DB {
  const dir = mkdtempSync(join(tmpdir(), "applypilot-usage-"));
  dirs.push(dir);
  db = openDatabase(join(dir, "t.sqlite"));
  return db;
}

function stubClient(text: string): { client: LlmClient; calls: number } {
  const state = { calls: 0 };
  const client: LlmClient = {
    model: "stub-model",
    provider: "stub",
    async complete() {
      state.calls++;
      return { text, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { client, get calls() { return state.calls; } } as { client: LlmClient; calls: number };
}

describe("llm_usage ledger", () => {
  it("records events and rolls up totals + per-feature, never storing text", () => {
    const repo = new LlmUsageRepo(tempDb());
    repo.record({ provider: "embedded", model: "m", feature: "job-rerank", inputTokens: 100, outputTokens: 20, cached: false });
    repo.record({ provider: "embedded", model: "m", feature: "job-rerank", cached: true });
    repo.record({ provider: "anthropic", model: "c", feature: "doc-generation", inputTokens: 50, outputTokens: 30, cached: false });

    const totals = repo.totalsSince();
    expect(totals.calls).toBe(3);
    expect(totals.cachedCalls).toBe(1);
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(50);

    const byFeature = repo.byFeatureSince();
    expect(byFeature.find((f) => f.feature === "job-rerank")?.calls).toBe(2);
    expect(byFeature.find((f) => f.feature === "doc-generation")?.inputTokens).toBe(50);
  });

  it("sink wiring is fire-and-forget and never throws into completions", () => {
    const events: LlmUsageEvent[] = [];
    setLlmUsageSink((e) => events.push(e));
    recordLlmUsage({ provider: "p", model: "m", feature: "f", cached: false });
    expect(events).toHaveLength(1);
    setLlmUsageSink(() => {
      throw new Error("sink exploded");
    });
    expect(() => recordLlmUsage({ provider: "p", model: "m", feature: "f", cached: false })).not.toThrow();
  });
});

describe("cachedComplete", () => {
  it("caches by model+kind+prompt and marks hits as cached usage (never billed)", async () => {
    const cache = new LlmCacheRepo(tempDb());
    const stub = stubClient("answer");
    const events: LlmUsageEvent[] = [];
    setLlmUsageSink((e) => events.push(e));

    expect(await cachedComplete(cache, stub.client, "kind@v1", "prompt")).toBe("answer");
    expect(await cachedComplete(cache, stub.client, "kind@v1", "prompt")).toBe("answer");
    expect(stub.calls).toBe(1); // second call served from cache

    const cachedEvents = events.filter((e) => e.cached);
    expect(cachedEvents).toHaveLength(1);
    expect(cachedEvents[0]!.model).toBe("stub-model");

    // A version bump invalidates: new kind, fresh completion.
    await cachedComplete(cache, stub.client, "kind@v2", "prompt");
    expect(stub.calls).toBe(2);
  });

  it("passes through without a cache", async () => {
    const stub = stubClient("raw");
    expect(await cachedComplete(null, stub.client, "k", "p")).toBe("raw");
    expect(stub.calls).toBe(1);
  });
});

describe("capability resolver", () => {
  it("reports the embedded default as disabled with a reason until models are downloaded", () => {
    const prev = process.env.APPLYPILOT_MODELS_DIR;
    process.env.APPLYPILOT_MODELS_DIR = "/nonexistent/applypilot-models";
    try {
      const cap = aiCapability("job-rerank");
      expect(cap.enabled).toBe(false);
      expect(cap.reason).toMatch(/not downloaded/i);
    } finally {
      prev === undefined ? delete process.env.APPLYPILOT_MODELS_DIR : (process.env.APPLYPILOT_MODELS_DIR = prev);
    }
  });
});
