// Bundled-model store (commercial M2): the resumable downloader and status reporting.
// Uses a local HTTP fixture — no external network, no real model weights.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_MODELS, downloadModel, modelPath, modelsDir, modelStatuses, resetModelJobs, type BundledModel } from "../src/llm/model-store";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetModelJobs();
  delete process.env.APPLYPILOT_MODELS_DIR;
});

function tempModelsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "applypilot-models-"));
  process.env.APPLYPILOT_MODELS_DIR = dir;
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fixtureServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function testModel(url: string): BundledModel {
  return {
    id: "test-model",
    kind: "chat",
    file: "test-model.gguf",
    url,
    approxBytes: 1024,
    license: "Apache-2.0",
    licenseUrl: url,
  };
}

describe("model catalog", () => {
  it("bundles exactly one chat and one embedding model, both redistribution-friendly", () => {
    expect(BUNDLED_MODELS.filter((m) => m.kind === "chat")).toHaveLength(1);
    expect(BUNDLED_MODELS.filter((m) => m.kind === "embedding")).toHaveLength(1);
    for (const m of BUNDLED_MODELS) expect(m.license).toMatch(/Apache-2\.0|MIT/);
  });

  it("models dir is env-overridable and statuses report absence without touching the network", () => {
    const dir = tempModelsDir();
    expect(modelsDir()).toBe(dir);
    for (const s of modelStatuses()) {
      expect(s.present).toBe(false);
      expect(s.downloading).toBe(false);
    }
  });
});

describe("downloadModel", () => {
  it("downloads to .part, renames into place, and reports progress", async () => {
    tempModelsDir();
    const body = Buffer.alloc(64 * 1024, 7);
    const base = await fixtureServer((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const model = testModel(`${base}/test-model.gguf`);
    const progress: number[] = [];
    await downloadModel(model, (f) => progress.push(f));
    expect(existsSync(modelPath(model))).toBe(true);
    expect(readFileSync(modelPath(model)).length).toBe(body.length);
    expect(existsSync(`${modelPath(model)}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(1);
  });

  it("forgets a finished job (no eternal 'downloading') and re-downloads a deleted file", async () => {
    tempModelsDir();
    const body = Buffer.from("model-bytes");
    let hits = 0;
    const base = await fixtureServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const model = testModel(`${base}/test-model.gguf`);
    await downloadModel(model);
    // Job must be forgotten on success — otherwise the UI's retry button wedges on "Downloading…".
    // (modelStatuses only reports catalog models, so assert via re-download behavior instead.)
    rmSync(modelPath(model), { force: true });
    await downloadModel(model);
    expect(hits).toBe(2); // a stale resolved job would have short-circuited the second call
    expect(existsSync(modelPath(model))).toBe(true);
  });

  it("preserves the .part file when a resume attempt hits a transient server error", async () => {
    const dir = tempModelsDir();
    const half = Buffer.from("01234567".repeat(32));
    const base = await fixtureServer((_req, res) => {
      res.writeHead(503);
      res.end("busy");
    });
    const model = testModel(`${base}/test-model.gguf`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${modelPath(model)}.part`, half);

    await expect(downloadModel(model)).rejects.toThrow(/503/);
    // The partial download survives — a transient 503 must never restart a ~1 GB fetch from zero.
    expect(readFileSync(`${modelPath(model)}.part`).equals(half)).toBe(true);
  }, 20_000);

  it("resumes a partial download with a Range request", async () => {
    const dir = tempModelsDir();
    const full = Buffer.from("0123456789abcdef".repeat(64));
    const half = full.subarray(0, full.length / 2);
    let sawRange = "";
    const base = await fixtureServer((req, res) => {
      sawRange = String(req.headers.range ?? "");
      const from = Number(/bytes=(\d+)-/.exec(sawRange)?.[1] ?? 0);
      res.writeHead(from > 0 ? 206 : 200, { "content-length": String(full.length - from) });
      res.end(full.subarray(from));
    });
    const model = testModel(`${base}/test-model.gguf`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${modelPath(model)}.part`, half);

    await downloadModel(model);
    expect(sawRange).toBe(`bytes=${half.length}-`);
    expect(readFileSync(modelPath(model)).equals(full)).toBe(true);
  });

  it("retries transient failures and eventually reports a job error", async () => {
    tempModelsDir();
    let hits = 0;
    const base = await fixtureServer((_req, res) => {
      hits++;
      res.writeHead(500);
      res.end("boom");
    });
    const model = testModel(`${base}/test-model.gguf`);
    await expect(downloadModel(model)).rejects.toThrow(/500/);
    expect(hits).toBe(3); // 3 attempts
  }, 20_000);
});
