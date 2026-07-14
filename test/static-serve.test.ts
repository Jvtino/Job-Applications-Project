// Static dashboard serving (M6) — the single-origin production/Electron mode where the API also
// serves the built dashboard. Asserts it serves index + assets, SPA-falls-back unknown routes,
// never shadows the /api/* routes, and never leaks a file outside the web root.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { startApiServer } from "../src/server/api";

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("static dashboard serving (Electron/production mode)", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-web-"));
    const web = join(dir, "dist");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>ApplyPilot</title><div id=root></div>");
    writeFileSync(join(web, "assets", "app.css"), "body{color:teal}");
    db = openDatabase(join(dir, "p.sqlite"));
    server = startApiServer(0, { db, envPath: join(dir, ".env"), webRoot: web });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the dashboard index at /", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("ApplyPilot");
  });

  it("serves built assets with the right MIME", async () => {
    const r = await fetch(`${base}/assets/app.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/css");
    expect(await r.text()).toContain("teal");
  });

  it("SPA-falls-back unknown routes to index.html", async () => {
    const r = await fetch(`${base}/some/client/route`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("ApplyPilot");
  });

  it("does not let static serving shadow the API", async () => {
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it("never leaks a file outside the web root", async () => {
    const r = await fetch(`${base}/../../../../etc/passwd`);
    expect(await r.text()).not.toContain("root:"); // falls back to index.html, never /etc/passwd
  });
});
