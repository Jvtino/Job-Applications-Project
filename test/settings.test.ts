// App settings (LLM provider + model, optional Anthropic key) — the first WRITE surface on the local API.
//
// The security-critical property: the key is a secret. It is persisted to a local .env, but
// readSettings / GET /api/settings only ever expose a masked "…1234" hint — the full key never
// round-trips back to the UI or crosses the wire. Other .env lines are preserved on write.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { startApiServer } from "../src/server/api";
import { readSettings, writeSettings } from "../src/server/config-store";

// Restore env after this file (writeSettings mutates process.env in-memory by design).
const ORIG = {
  key: process.env.ANTHROPIC_API_KEY,
  model: process.env.ANTHROPIC_MODEL,
  llmProvider: process.env.APPLYPILOT_LLM_PROVIDER,
};
afterAll(() => {
  ORIG.key === undefined ? delete process.env.ANTHROPIC_API_KEY : (process.env.ANTHROPIC_API_KEY = ORIG.key);
  ORIG.model === undefined ? delete process.env.ANTHROPIC_MODEL : (process.env.ANTHROPIC_MODEL = ORIG.model);
  ORIG.llmProvider === undefined
    ? delete process.env.APPLYPILOT_LLM_PROVIDER
    : (process.env.APPLYPILOT_LLM_PROVIDER = ORIG.llmProvider);
});

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((res) => (server.listening ? res() : server.once("listening", () => res())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("config-store — .env permissions (M7)", () => {
  it("re-asserts 0600 even when overwriting a pre-existing group/world-readable .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-perms-"));
    const env = join(dir, ".env");
    // A .env that predates the 0600-on-create guard (copied from .env.example, edited by hand, …).
    writeFileSync(env, "APPLYPILOT_LLM_PROVIDER=embedded\n");
    chmodSync(env, 0o644);
    expect(statSync(env).mode & 0o777).toBe(0o644);
    writeSettings(env, { llmModel: "qwen2.5-1.5b-instruct" });
    // writeFileSync's `mode` only applies on create; the explicit chmod closes the overwrite leak.
    expect(statSync(env).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("config-store (Anthropic key persistence)", () => {
  it("defaults to the bundled embedded provider when no key is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-cfg0-"));
    const env = join(dir, ".env");
    const read = readSettings(env);
    expect(read.llmProvider).toBe("embedded");
    expect(read.model).toBe("qwen2.5-1.5b-instruct");
    expect(read.llmMode).toBe("bundled");
    // "Configured" for the embedded provider means the model files are on disk — not in tests.
    expect(read.llmConfigured).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the key but only ever returns a masked hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-cfg-"));
    const env = join(dir, ".env");
    writeFileSync(env, "APPLYPILOT_DB_PATH=./data/x.sqlite\n# a comment\n");

    const KEY = "sk-ant-secret-abcd1234";
    const out = writeSettings(env, { apiKey: KEY, model: "claude-sonnet-4-6" });
    expect(out.hasKey).toBe(true);
    expect(out.keyHint).toBe("…1234");
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(out.llmProvider).toBe("anthropic");
    expect(JSON.stringify(out)).not.toContain("secret"); // the hint never carries the secret

    // The file holds the real key; the pre-existing line + comment are preserved.
    const text = readFileSync(env, "utf8");
    expect(text).toContain(`ANTHROPIC_API_KEY=${KEY}`);
    expect(text).toContain("APPLYPILOT_DB_PATH=./data/x.sqlite");
    expect(text).toContain("# a comment");

    // readSettings round-trips without ever exposing the full key.
    const read = readSettings(env);
    expect(read.hasKey).toBe(true);
    expect(read.keyHint).toBe("…1234");
    expect(JSON.stringify(read)).not.toContain(KEY);

    rmSync(dir, { recursive: true, force: true });
  });

  it("scrubs retired keys (CAPTCHA solver, LinkedIn/Indeed flag) from .env and process.env on save", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-cfg-scrub-"));
    const env = join(dir, ".env");
    writeFileSync(
      env,
      "APPLYPILOT_CAPTCHA_API_KEY=old-solver-key\n" +
        "APPLYPILOT_CAPTCHA_PROVIDER=legacy-provider\n" +
        "APPLYPILOT_CAPTCHA_API_URL=http://localhost:8191\n" +
        "APPLYPILOT_ENABLE_LINKEDIN_INDEED=on\n" +
        "APPLYPILOT_DB_PATH=./data/x.sqlite\n# a comment\n"
    );
    process.env.APPLYPILOT_CAPTCHA_API_KEY = "old-solver-key";
    process.env.APPLYPILOT_ENABLE_LINKEDIN_INDEED = "on";

    const out = writeSettings(env, { model: "gemma4:e4b" });

    const text = readFileSync(env, "utf8");
    expect(text).not.toContain("APPLYPILOT_CAPTCHA"); // solver keys gone from disk
    expect(text).not.toContain("APPLYPILOT_ENABLE_LINKEDIN_INDEED"); // replaced by APPLYPILOT_SOURCE_POLICY
    expect(text).toContain("APPLYPILOT_DB_PATH=./data/x.sqlite"); // neighbors preserved
    expect(text).toContain("# a comment");
    expect(process.env.APPLYPILOT_CAPTCHA_API_KEY).toBeUndefined(); // and from the live env
    expect(process.env.APPLYPILOT_ENABLE_LINKEDIN_INDEED).toBeUndefined();
    expect(JSON.stringify(out).toLowerCase()).not.toContain("captcha"); // settings shape is clean
    expect(JSON.stringify(out)).not.toContain("enableLinkedinIndeed");

    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves an existing key untouched when apiKey is omitted (only model changes)", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-cfg2-"));
    const env = join(dir, ".env");
    writeSettings(env, { apiKey: "sk-ant-keepme-9999" });
    const out = writeSettings(env, { model: "claude-haiku-4-5-20251001" });
    expect(out.hasKey).toBe(true);
    expect(out.keyHint).toBe("…9999"); // unchanged
    expect(out.model).toBe("claude-haiku-4-5-20251001");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GET/POST /api/settings", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-setapi-"));
    db = openDatabase(join(dir, "s.sqlite"));
    server = startApiServer(0, { db, envPath: join(dir, ".env") });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("POST stores the key; GET reports it set but the secret never crosses the wire", async () => {
    const KEY = "sk-ant-http-zzzz7777";
    const post = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY, model: "claude-opus-4-8" }),
    });
    expect(post.status).toBe(200);
    const pbody = (await post.json()) as { hasKey: boolean; keyHint: string };
    expect(pbody.hasKey).toBe(true);
    expect(pbody.keyHint).toBe("…7777");

    const get = await fetch(`${base}/api/settings`);
    expect(get.status).toBe(200);
    const raw = await get.text();
    expect(raw).not.toContain(KEY); // the full key is never sent back
    const gbody = JSON.parse(raw) as { hasKey: boolean; keyHint: string; model: string };
    expect(gbody.hasKey).toBe(true);
    expect(gbody.keyHint).toBe("…7777");
    expect(gbody.model).toBe("claude-opus-4-8");
  });
});
