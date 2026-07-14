// In-app document generation (M5) + one-click apply wiring.
//   - /api/generate runs the real Module-5 pipeline: tailored docs from APPROVED facts only,
//     verifier-gated. We assert eligibility + that 4 files (résumé/cover × pdf/docx) are written.
//   - /api/apply is driven with an INJECTED apply fn (no browser) to prove the endpoint returns a
//     gate summary and — semi-locked — never reports submitted.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { startApiServer } from "../src/server/api";
import type { ApplySessionHandle } from "../src/orchestrator/apply-session";
import type { ReviewGate } from "../src/orchestrator/review-gate";

const here = dirname(fileURLToPath(import.meta.url));
const RESUME = readFileSync(join(here, "fixtures", "sample-resume.txt"));

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const postJson = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const mr = (label: string) => ({
  field: { ref: label, label, controlType: "text", required: false },
  resolvedValue: "value", risk: "identity", source: "profile", method: "exact", confidence: 1, rationale: "ok",
});
const FAKE_GATE = {
  url: "u", ats: "greenhouse", mode: "semi_auto",
  filled: [mr("First"), mr("Email"), mr("Phone")],
  flaggedForReview: [mr("City")],
  needsConfirmation: [],
  attachedDocuments: [{ kind: "resume", attached: true }],
  challengeDetected: false, submitControlRef: "apf-submit", readyForOneClickSubmit: true,
} as unknown as ReviewGate;

// A fake apply session: no browser, returns the gate above and never actually submits.
const fakeHandle = (): ApplySessionHandle => ({
  getId: () => "fake-session",
  getGate: () => FAKE_GATE,
  refresh: async () => FAKE_GATE,
  setField: async () => FAKE_GATE,
  markSubmitted: async () => ({ submitted: false, reason: "fake session" }),
  cancel: async () => {},
  isDone: () => false,
});

describe("/api/generate + /api/apply", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;
  let genDir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-gen-"));
    genDir = join(dir, "generated");
    db = openDatabase(join(dir, "p.sqlite"));
    server = startApiServer(0, {
      db,
      envPath: join(dir, ".env"),
      resumesDir: join(dir, "resumes"),
      generatedDir: genDir,
      startApplySession: async () => fakeHandle(), // no real browser
    });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates submission-eligible docs from approved facts (verifier-gated)", async () => {
    // Minimal profile (identity) + ingest + approve all facts.
    await postJson(base, "/api/profile", { legalFirstName: "Jane", legalLastName: "Applicant", email: "jane@example.com", phone: "(415) 555-0137" });
    await postJson(base, "/api/resume/ingest", { filename: "resume.txt", contentBase64: RESUME.toString("base64") });
    await postJson(base, "/api/ledger", { approveAll: true });

    const r = await postJson(base, "/api/generate", {
      company: "Acme",
      title: "Operations Analyst",
      postingText: "Acme is hiring an Operations Analyst. You will own reporting and process work.",
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.allEligible).toBe(true); // template generator only restates approved facts
    expect(b.resume.eligible).toBe(true);
    expect(b.coverLetter.eligible).toBe(true);
    expect(b.files).toHaveLength(4);
    expect(b.files.every((f: string) => existsSync(f))).toBe(true); // pdf + docx actually written
    expect(b.downloads).toHaveLength(4);
    expect(b.downloads.every((f: { name: string; url: string }) => f.name && f.url.startsWith("/api/generated?file="))).toBe(true);

    const download = await fetch(`${base}${b.downloads[0].url}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(b.downloads[0].name);

    const traversal = await fetch(`${base}/api/generated?file=${encodeURIComponent("../secret.pdf")}`);
    expect(traversal.status).toBe(400);
  });

  it("refuses to generate before any facts are approved", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "applypilot-gen2-"));
    const db2 = openDatabase(join(fresh, "p.sqlite"));
    const s2 = startApiServer(0, { db: db2, envPath: join(fresh, ".env"), generatedDir: join(fresh, "generated") });
    const b2 = await listening(s2);
    const r = await postJson(b2, "/api/generate", { company: "Acme", title: "X", postingText: "hi" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/profile|ledger|approved/i);
    await new Promise<void>((res) => s2.close(() => res()));
    db2.close();
    rmSync(fresh, { recursive: true, force: true });
  });

  it("one-click apply returns a gate summary and never reports submitted (semi)", async () => {
    const r = await postJson(base, "/api/apply", { url: "https://job-boards.greenhouse.io/acme/jobs/9", company: "Acme", title: "Operations Analyst" });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.submitted).toBe(false); // the dashboard never submits
    expect(b.filled).toBe(3);
    expect(b.flagged).toBe(1);
    expect(b.submitControlFound).toBe(true);
    expect(b.documents[0]).toEqual({ kind: "resume", attached: true });
  });

  it("apply requires a job url", async () => {
    const r = await postJson(base, "/api/apply", {});
    expect(r.status).toBe(400);
  });
});
