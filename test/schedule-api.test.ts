// Daily-run schedule persistence over the local API (commercial M9-C). The schedule is engine-owned:
// POST persists it to .env and re-arms the engine timer; GET reports it plus the engine-computed
// next-run. Default OFF — an unattended automation trigger is opt-in.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { startApiServer } from "../src/server/api";

// writeSettings mutates process.env in-memory by design; restore the schedule keys after this file so
// a later test's startApiServer never inherits an armed schedule from here.
const ORIG = {
  enabled: process.env.APPLYPILOT_SCHEDULE_ENABLED,
  hour: process.env.APPLYPILOT_SCHEDULE_HOUR,
};
afterAll(() => {
  ORIG.enabled === undefined ? delete process.env.APPLYPILOT_SCHEDULE_ENABLED : (process.env.APPLYPILOT_SCHEDULE_ENABLED = ORIG.enabled);
  ORIG.hour === undefined ? delete process.env.APPLYPILOT_SCHEDULE_HOUR : (process.env.APPLYPILOT_SCHEDULE_HOUR = ORIG.hour);
});

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((res) => (server.listening ? res() : server.once("listening", () => res())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface SchedulePayload {
  enabled: boolean;
  hour: number;
  nextRunAt: string | null;
}

describe("GET/POST /api/schedule", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;
  let envPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-sched-"));
    envPath = join(dir, ".env");
    db = openDatabase(join(dir, "s.sqlite"));
    server = startApiServer(0, { db, envPath });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to disabled with no next-run (opt-in)", async () => {
    const r = await fetch(`${base}/api/schedule`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as SchedulePayload;
    expect(body.enabled).toBe(false);
    expect(body.hour).toBe(7);
    expect(body.nextRunAt).toBeNull();
  });

  it("persists enabled+hour and returns an engine-computed future next-run at that hour", async () => {
    const post = await fetch(`${base}/api/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, hour: 9 }),
    });
    expect(post.status).toBe(200);
    const body = (await post.json()) as SchedulePayload;
    expect(body.enabled).toBe(true);
    expect(body.hour).toBe(9);
    expect(body.nextRunAt).not.toBeNull();
    const next = new Date(body.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now()); // strictly in the future
    expect(next.getHours()).toBe(9); // local hour matches the setting
    expect(next.getMinutes()).toBe(0);

    // Persisted to .env in the documented form.
    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("APPLYPILOT_SCHEDULE_ENABLED=on");
    expect(text).toContain("APPLYPILOT_SCHEDULE_HOUR=9");

    // GET round-trips the persisted value.
    const get = (await (await fetch(`${base}/api/schedule`)).json()) as SchedulePayload;
    expect(get.enabled).toBe(true);
    expect(get.hour).toBe(9);
    expect(get.nextRunAt).not.toBeNull();
  });

  it("clamps/rejects an out-of-range hour with 400 (never coerced into an unattended run)", async () => {
    const r = await fetch(`${base}/api/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hour: 30 }),
    });
    expect(r.status).toBe(400);
  });

  it("disabling clears the next-run", async () => {
    const post = await fetch(`${base}/api/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const body = (await post.json()) as SchedulePayload;
    expect(body.enabled).toBe(false);
    expect(body.nextRunAt).toBeNull();
  });

  it("rejects non-GET/POST verbs", async () => {
    const r = await fetch(`${base}/api/schedule`, { method: "DELETE" });
    expect(r.status).toBe(405);
  });
});
