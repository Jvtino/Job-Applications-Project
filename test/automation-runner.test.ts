// Legacy continuous runner API — start removed from product; status/stop remain for compatibility.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { createBlankProfile } from "../src/profile/factory";
import { startApiServer } from "../src/server/api";
import { automationRunner, __setCycleFnForTest } from "../src/server/automation-runner";
import type { ApplicantProfile } from "../src/types/applicant-profile";

const EMPTY_CYCLE = async () => ({
  discovered: 0,
  matches: 0,
  ready: 0,
  discoveryMs: 0,
  applicationMs: 0,
  durationMs: 0,
  applied: false,
  message: "test cycle",
});

function cleanProfile(id: string): ApplicantProfile {
  const p = createBlankProfile(id);
  p.contact.legalFirstName = "Ahmet";
  p.contact.legalLastName = "Kaya";
  p.contact.email = "ahmet.kaya@example.com";
  return p;
}

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((res) => (server.listening ? res() : server.once("listening", () => res())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("POST /api/runner — removed from product surface", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;
  let profile: ApplicantProfile;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-runner-"));
    db = openDatabase(join(dir, "runner.sqlite"));
    profile = new ProfileRepo(db, undefined).save(cleanProfile("runner"));
    __setCycleFnForTest(EMPTY_CYCLE);
    server = startApiServer(0, { db });
    base = await listening(server);
  });

  afterAll(async () => {
    automationRunner.stop();
    await automationRunner.whenFinished();
    __setCycleFnForTest(null);
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/runner/status returns idle by default", async () => {
    const r = await fetch(`${base}/api/runner/status`);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.running).toBe(false);
    expect(body.phase).toBe("idle");
  });

  it("POST /api/runner/start returns 410 Gone", async () => {
    const r = await fetch(`${base}/api/runner/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "semi" }),
    });
    const body = await r.json();
    expect(r.status).toBe(410);
    expect(body.error).toMatch(/removed/i);
  });

  it("POST /api/runner/stop still responds when idle", async () => {
    const r = await fetch(`${base}/api/runner/stop`, { method: "POST" });
    expect(r.status).toBe(200);
    const status = await fetch(`${base}/api/runner/status`).then((x) => x.json());
    expect(status.running).toBe(false);
  });

  it("transitions from Automation Discovery into Automation Application during a cycle", async () => {
    const phases: string[] = [];
    __setCycleFnForTest(async (_session, _db, _profile, _approvedFacts, opts) => {
      phases.push(automationRunner.getStatus().phase);
      opts.onProgress?.("Automation Discovery: scanning company boards for roles that fit your profile…");
      phases.push(automationRunner.getStatus().phase);
      opts.onProgress?.("Automation Application: tailoring documents for Operations Analyst @ Acme…");
      phases.push(automationRunner.getStatus().phase);
      opts.onProgress?.("Automation Application: filling Operations Analyst @ Acme (91% fit)…");
      phases.push(automationRunner.getStatus().phase);
      automationRunner.stop();
      return {
        discovered: 2,
        matches: 1,
        ready: 1,
        discoveryMs: 12,
        applicationMs: 18,
        durationMs: 30,
        applied: true,
        job: {
          company: "Acme",
          title: "Operations Analyst",
          jobUrl: "https://job-boards.greenhouse.io/acme/jobs/123456",
          score: 0.91,
        },
        action: "queued",
        reason: "filled and paused at the review gate",
        message: "Acme: form filled — click Submit when you're ready.",
      };
    });

    try {
      await automationRunner.start(db, profile, undefined, {
        mode: "semi",
        generatedDir: join(dir, "generated"),
        headed: false,
        betweenJobsMs: 1000,
      });
      await waitFor(() => automationRunner.getStatus().cycles >= 1);
      await automationRunner.whenFinished();
    } finally {
      automationRunner.stop();
      await automationRunner.whenFinished();
      __setCycleFnForTest(EMPTY_CYCLE);
    }

    expect(phases).toContain("discovering");
    expect(phases).toContain("applying");
    expect(automationRunner.getStatus().lastCycle?.ready).toBe(1);
    expect(automationRunner.getStatus().lastCycle?.action).toBe("queued");
  });
});
