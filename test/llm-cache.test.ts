import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { LlmCacheRepo, cacheKey } from "../src/llm/cache";

describe("LlmCacheRepo", () => {
  let dir: string;
  let db: DB;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-cache-"));
    db = openDatabase(join(dir, "c.sqlite"));
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null on miss and the value on hit, upserting", () => {
    const repo = new LlmCacheRepo(db);
    const k = cacheKey("qwen2.5", "rerank", "payload-1");
    expect(repo.get(k)).toBeNull();
    repo.set(k, "result-a");
    expect(repo.get(k)).toBe("result-a");
    repo.set(k, "result-b");
    expect(repo.get(k)).toBe("result-b");
  });

  it("keys differ by model, kind, and payload", () => {
    expect(cacheKey("m1", "k", "p")).not.toBe(cacheKey("m2", "k", "p"));
    expect(cacheKey("m1", "k1", "p")).not.toBe(cacheKey("m1", "k2", "p"));
    expect(cacheKey("m1", "k", "p1")).not.toBe(cacheKey("m1", "k", "p2"));
    expect(cacheKey("m1", "k", "p")).toBe(cacheKey("m1", "k", "p"));
  });
});

