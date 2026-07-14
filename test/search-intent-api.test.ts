// /api/search-intent (GET resolved intent + POST confirm) and /api/automation/funnel — the onboarding
// / target-profile persistence (brief Part H) and the honest funnel diagnostics surface (F2/J3).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, recordAudit, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { createBlankProfile } from "../src/profile/factory";
import { startApiServer } from "../src/server/api";

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (base: string, path: string) => fetch(`${base}${path}`);

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("/api/search-intent + /api/automation/funnel", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;
  let profileId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-intent-"));
    db = openDatabase(join(dir, "intent.sqlite"));
    const profile = createBlankProfile("intent-api");
    profile.preferences.targetRoles = ["AML Analyst"];
    new ProfileRepo(db, undefined).save(profile);
    profileId = profile.id;
    server = startApiServer(0, { db, envPath: join(dir, ".env"), generatedDir: join(dir, "generated") });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET returns an inferred draft intent + permissions before confirmation", async () => {
    const r = await get(base, "/api/search-intent");
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.intent.confidence).toBe("inferred_high");
    expect(b.intent.roleFamilies).toContain("compliance");
    expect(b.permissions.canDiscover).toBe(true);
    expect(b.permissions.canApply).toBe(true);
  });

  it("POST confirms the intent (confidence 'confirmed') and persists it", async () => {
    const r = await post(base, "/api/search-intent", {
      targetTitles: ["AML Analyst", "Sanctions Analyst"],
      excludedTitles: ["Software Engineer"],
      seniorityMin: "entry",
      seniorityMax: "mid",
      workArrangement: ["remote_us"],
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.intent.confidence).toBe("confirmed");
    expect(b.intent.targetTitles).toContain("Sanctions Analyst");
    expect(b.intent.excludedTitles).toContain("Software Engineer");

    // A fresh GET now returns the confirmed intent (persisted).
    const r2 = await get(base, "/api/search-intent");
    const b2 = await r2.json();
    expect(b2.intent.confidence).toBe("confirmed");
    expect(b2.intent.seniority.min).toBe("entry");
  });

  it("rejects an invalid seniority value", async () => {
    const r = await post(base, "/api/search-intent", { seniorityMin: "wizard" });
    expect(r.status).toBe(400);
  });

  it("GET /api/automation/funnel returns null before any pass, then the recorded report", async () => {
    const before = await get(base, "/api/automation/funnel");
    expect((await before.json()).funnel).toBeNull();

    recordAudit(db, profileId, "automation.funnel", { strong: 2, good: 3, applyReady: 1, bottleneck: "" });
    const after = await get(base, "/api/automation/funnel");
    const body = await after.json();
    expect(body.funnel.strong).toBe(2);
    expect(body.funnel.applyReady).toBe(1);
  });
});
