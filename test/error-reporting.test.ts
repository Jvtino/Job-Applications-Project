import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ErrorReporter, scrubText } from "../src/server/error-reporter";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { createBlankProfile } from "../src/profile/factory";
import { startApiServer } from "../src/server/api";
import type { AutopilotRun } from "../src/orchestrator/autopilot";
import type { ApplicantProfile } from "../src/types/applicant-profile";

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("error reporting API", () => {
  let dir: string;
  let errorsDir: string;
  let db: DB;
  let server: http.Server;
  let base: string;
  let currentPass: (d: DB, p: ApplicantProfile) => Promise<AutopilotRun>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-errors-"));
    errorsDir = join(dir, "errors");
    db = openDatabase(join(dir, "e.sqlite"));
    new ProfileRepo(db, undefined).save(createBlankProfile("errors-api"));
    currentPass = async () => ({ results: [], submitted: 0, wouldSubmit: 0, queued: 0, skipped: 0 });
    server = startApiServer(0, { db, envPath: join(dir, ".env"), errorsDir, runAutopilotPass: (d, p) => currentPass(d, p) });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not store expected API guardrail responses as diagnostics", async () => {
    const response = await fetch(`${base}/api/health`, { method: "POST" });
    expect(response.status).toBe(405);
    const body = (await response.json()) as { error: string; errorId?: string };
    expect(body.error).toMatch(/GET \/api\/health/);
    expect(body.errorId).toBeUndefined();
    expect(response.headers.get("x-applypilot-error-id")).toBeNull();

    const list = await fetch(`${base}/api/errors`);
    expect(list.status).toBe(200);
    const payload = (await list.json()) as { reports: unknown[] };
    expect(payload.reports).toHaveLength(0);
  });

  it("records frontend reports and writes an export bundle", async () => {
    const posted = await fetch(`${base}/api/errors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "frontend",
        message: "Button exploded",
        stack: "Error: Button exploded\n    at click",
        context: { route: "/oneclick", apiKey: "sk-should-not-leak" },
      }),
    });
    expect(posted.status).toBe(200);
    const pbody = (await posted.json()) as { errorId: string };
    expect(pbody.errorId).toBeTruthy();

    const exported = await fetch(`${base}/api/errors/export?limit=10`);
    expect(exported.status).toBe(200);
    const ebody = (await exported.json()) as { path: string; reports: Array<{ id: string; context?: Record<string, unknown> }> };
    expect(existsSync(ebody.path)).toBe(true);
    expect(ebody.reports.some((report) => report.id === pbody.errorId)).toBe(true);
    const report = ebody.reports.find((item) => item.id === pbody.errorId)!;
    expect(JSON.stringify(report)).not.toContain("sk-should-not-leak");
  });

  it("stores unexpected server failures with an errorId", async () => {
    currentPass = async () => {
      throw new Error("synthetic autopilot failure");
    };
    const response = await fetch(`${base}/api/autopilot`, { method: "POST" });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; errorId?: string };
    expect(body.error).toBe("autopilot pass failed");
    expect(body.errorId).toBeTruthy();

    const list = await fetch(`${base}/api/errors`);
    const payload = (await list.json()) as { reports: Array<{ id: string; source: string; message: string; context?: { url?: string } }> };
    expect(payload.reports.some((report) =>
      report.id === body.errorId &&
      report.source === "api" &&
      report.message === "synthetic autopilot failure" &&
      report.context?.url === "/api/autopilot"
    )).toBe(true);
  });
});

describe("scrubText — PII/secret stripping (M7)", () => {
  it("strips emails, phones, home-dir usernames, and bearer/sk- tokens", () => {
    expect(scrubText("contact jane.doe@example.com now")).toBe("contact [email] now");
    expect(scrubText("call (415) 555-0137 today")).toBe("call [phone] today");
    expect(scrubText("call +1 415-555-0137")).toBe("call [phone]");
    expect(scrubText("ENOENT /Users/janedoe/Documents/resume.pdf")).toBe("ENOENT /Users/[user]/Documents/resume.pdf");
    expect(scrubText("at /home/janedoe/app/index.js:1")).toBe("at /home/[user]/app/index.js:1");
    expect(scrubText("Authorization: Bearer abc.def-123")).toContain("Bearer [redacted]");
    expect(scrubText("key sk-ABCDEFGHIJKLMNOP")).toContain("sk-[redacted]");
  });

  it("leaves ordinary diagnostic text untouched", () => {
    const s = "TypeError: cannot read property 'x' of undefined at Foo.bar (module.js:42)";
    expect(scrubText(s)).toBe(s);
  });

  it("record() scrubs PII out of message and stack at write time", () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-scrub-"));
    scrubDirs.push(dir);
    const reporter = new ErrorReporter(dir);
    const report = reporter.record({
      source: "api",
      message: "failed for user carol@acme.com",
      stack: "Error\n    at /Users/carol/app/run.js:10",
      context: { note: "reach me at (212) 555-0188" },
    });
    const blob = JSON.stringify(report);
    expect(blob).not.toContain("carol@acme.com");
    expect(blob).not.toContain("/Users/carol/");
    expect(blob).not.toContain("(212) 555-0188");
    expect(report.message).toBe("failed for user [email]");
  });
});

const scrubDirs: string[] = [];
afterEach(() => {
  while (scrubDirs.length) rmSync(scrubDirs.pop()!, { recursive: true, force: true });
});
