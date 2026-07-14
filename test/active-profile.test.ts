import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { createBlankProfile } from "../src/profile/factory";
import { DEMO_PROFILE_ID, resolveActiveProfile } from "../src/profile/active-profile";
import { startApiServer } from "../src/server/api";

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("active profile resolution", () => {
  it("treats a demo-only datastore as unconfigured when demo mode is off", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-active-profile-"));
    const db = openDatabase(join(dir, "p.sqlite"));
    const repo = new ProfileRepo(db, undefined);
    repo.save(createBlankProfile(DEMO_PROFILE_ID));

    expect(resolveActiveProfile(repo, { demoMode: false })).toBeUndefined();

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows the demo profile when demo mode is on", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-active-profile-"));
    const db = openDatabase(join(dir, "p.sqlite"));
    const repo = new ProfileRepo(db, undefined);
    repo.save(createBlankProfile(DEMO_PROFILE_ID));

    expect(resolveActiveProfile(repo, { demoMode: true })?.id).toBe(DEMO_PROFILE_ID);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the newest non-demo profile even when demo exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-active-profile-"));
    const db = openDatabase(join(dir, "p.sqlite"));
    const repo = new ProfileRepo(db, undefined);
    const demo = createBlankProfile(DEMO_PROFILE_ID);
    demo.updatedAt = "2026-03-01T00:00:00.000Z";
    repo.save(demo);
    const real = createBlankProfile("real");
    real.updatedAt = "2026-01-01T00:00:00.000Z";
    repo.save(real);

    expect(resolveActiveProfile(repo, { demoMode: false })?.id).toBe("real");
    expect(resolveActiveProfile(repo, { demoMode: true })?.id).toBe("real");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("profile POST creates a real profile when only hidden demo data exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-active-profile-api-"));
    const db = openDatabase(join(dir, "p.sqlite"));
    const repo = new ProfileRepo(db, undefined);
    repo.save(createBlankProfile(DEMO_PROFILE_ID));
    const server = startApiServer(0, { db, demoMode: false });
    const base = await listening(server);

    try {
      const stateBefore = await (await fetch(`${base}/api/state`)).json() as { configured: boolean };
      expect(stateBefore.configured).toBe(false);

      const post = await fetch(`${base}/api/profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(post.status).toBe(200);
      const ids = repo.list().map((profile) => profile.id);
      expect(ids).toContain(DEMO_PROFILE_ID);
      expect(ids.some((id) => id !== DEMO_PROFILE_ID)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
