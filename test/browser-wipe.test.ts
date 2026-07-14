// Browser-profile wipe endpoint (commercial M7 "forget site logins"). Confirms the route deletes the
// Chromium profile + its -discovery sibling, reports an honest count, and is strictly scoped to the
// resolved profile paths (a temp dir here — the test must NEVER point at a real ./browser-profile).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { startApiServer } from "../src/server/api";

describe("POST /api/browser-profile/wipe (M7)", () => {
  let dir: string;
  let profileDir: string;
  let db: DB;
  let server: http.Server;
  let base: string;
  const prevEnv = process.env.APPLYPILOT_BROWSER_PROFILE_DIR;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-wipe-"));
    profileDir = join(dir, "browser-profile");
    process.env.APPLYPILOT_BROWSER_PROFILE_DIR = profileDir;
    for (const d of [profileDir, `${profileDir}-discovery`]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "Cookies"), "sessionid=secret"); // stand-in for a stored career-site login
    }
    db = openDatabase(join(dir, "w.sqlite"));
    server = startApiServer(0, { db, envPath: join(dir, ".env") });
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    prevEnv === undefined
      ? delete process.env.APPLYPILOT_BROWSER_PROFILE_DIR
      : (process.env.APPLYPILOT_BROWSER_PROFILE_DIR = prevEnv);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a GET", async () => {
    expect((await fetch(`${base}/api/browser-profile/wipe`, { method: "GET" })).status).toBe(405);
  });

  it("deletes the profile + -discovery dirs when idle and reports the count", async () => {
    expect(existsSync(profileDir)).toBe(true);
    expect(existsSync(`${profileDir}-discovery`)).toBe(true);
    const res = await fetch(`${base}/api/browser-profile/wipe`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: number };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(2);
    expect(existsSync(profileDir)).toBe(false);
    expect(existsSync(`${profileDir}-discovery`)).toBe(false);
  });

  it("is idempotent — a second wipe removes nothing and still succeeds", async () => {
    const res = await fetch(`${base}/api/browser-profile/wipe`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(0);
  });
});
