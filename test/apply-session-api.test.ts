// The in-app apply lifecycle over HTTP, driven by an INJECTED fake session (no real browser):
//   start (supported URL only) -> answer the field -> user submits ON THE EMPLOYER PAGE ->
//   mark-submitted records it. Proves the server's session wiring AND the review-first contract:
//   /api/apply refuses jobs without a form-fill adapter, /api/apply/submit is a dead endpoint (the
//   app never clicks submit), and mark-submitted clears the active session (and its browser lock).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { ApplicationsRepo } from "../src/db/applications-repo";
import { LedgerRepo } from "../src/db/ledger-repo";
import { ingestResumeBuffer } from "../src/server/ingest-runner";
import { approveAll } from "../src/ingestion/ledger-ops";
import { createBlankProfile } from "../src/profile/factory";
import { startApiServer } from "../src/server/api";
import type { ApplySessionHandle } from "../src/orchestrator/apply-session";
import type { ReviewGate } from "../src/orchestrator/review-gate";

const here = dirname(fileURLToPath(import.meta.url));

const postJson = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const filledMr = (label: string) => ({
  field: { ref: label, label, controlType: "text", required: false },
  resolvedValue: "value", risk: "identity", source: "profile", method: "exact", confidence: 1, rationale: "ok",
});

/** A stateful fake apply session: one self-id field needs input until the user answers it. */
function makeFakeHandle(): ApplySessionHandle {
  let pending = new Set<string>(["eeo_race"]);
  let done = false;
  const gate = (): ReviewGate =>
    ({
      url: "https://job-boards.greenhouse.io/acme/jobs/1",
      ats: "greenhouse",
      mode: "semi_auto",
      filled: [filledMr("Email"), filledMr("Full name")],
      flaggedForReview: [],
      needsConfirmation: [...pending].map((ref) => ({
        field: { ref, label: "Race/Ethnicity", controlType: "native_select", required: true, options: ["Decline to self-identify"] },
        risk: "self_id", resolvedValue: null, source: "none", method: "unmapped", confidence: 0, rationale: "high-stakes — needs you",
      })),
      attachedDocuments: [{ kind: "resume", attached: true }],
      challengeDetected: false,
      submitControlRef: "apf-submit",
      readyForOneClickSubmit: pending.size === 0,
    }) as unknown as ReviewGate;
  return {
    getId: () => "sess-1",
    getGate: () => gate(),
    getDisplay: () => "window",
    refresh: async () => gate(),
    setField: async (ref) => {
      pending.delete(ref);
      return gate();
    },
    markSubmitted: async () => {
      done = true;
      return { submitted: true, reason: "Recorded — you submitted this on the employer's site." };
    },
    cancel: async () => {
      done = true;
    },
    isDone: () => done,
  };
}

describe("in-app apply lifecycle (/api/apply, /field, /mark-submitted, /cancel)", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;
  let profileId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-apply-"));
    db = openDatabase(join(dir, "apply.sqlite"));
    const profile = createBlankProfile("apply-api");
    profile.contact.legalFirstName = "Jane";
    profile.contact.legalLastName = "Applicant";
    profile.contact.email = "jane@example.com";
    new ProfileRepo(db, undefined).save(profile);
    profileId = profile.id;
    // Approved ledger facts so prepareApplicationDocs generates VERIFIED tailored docs. (The master
    // résumé bypass is intentionally refused on the live apply path — A3.)
    const ingested = await ingestResumeBuffer(db, undefined, profile, join(dir, "resumes"), {
      filename: "resume.txt",
      buffer: readFileSync(join(here, "fixtures", "sample-resume.txt")),
    });
    new LedgerRepo(db, undefined).save(approveAll(ingested.ledger));
    server = startApiServer(0, { db, envPath: join(dir, ".env"), generatedDir: join(dir, "generated"), startApplySession: async () => makeFakeHandle() });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Each test starts from a clean slate (no lingering session holding the browser lock).
  beforeEach(async () => {
    await postJson(base, "/api/apply/cancel", {});
  });

  it("starts a session for a supported URL, surfaces the needs-input field, and never submits", async () => {
    const r = await postJson(base, "/api/apply", { url: "https://job-boards.greenhouse.io/acme/jobs/1", company: "Acme", title: "Analyst" });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.sessionId).toBe("sess-1");
    expect(b.submitted).toBe(false);
    expect(b.applyCapability).toBe("supported_form_fill");
    expect(b.display).toBe("window");
    expect(b.gate.needsConfirmation).toHaveLength(1);
    expect(b.gate.needsConfirmation[0].label).toMatch(/race/i);
    expect(b.gate.submitControlFound).toBe(true);
  });

  it("refuses manual-only sources (no form-fill adapter) instead of routing them to the generic fallback", async () => {
    const r = await postJson(base, "/api/apply", { url: "https://www.linkedin.com/jobs/view/12345" });
    expect(r.status).toBe(422);
    const b = await r.json();
    expect(b.applyCapability).toBe("manual_open_only");
    expect(b.error).toMatch(/open manually/i);
  });

  it("refuses board/search pages outright — there is no application form to fill", async () => {
    const r = await postJson(base, "/api/apply", { url: "https://www.linkedin.com/jobs/search/?keywords=analyst" });
    expect(r.status).toBe(422);
    const b = await r.json();
    expect(b.applyCapability).toBe("unsupported");
  });

  it("apply/submit is gone: the app never clicks the employer's submit button", async () => {
    await postJson(base, "/api/apply", { url: "https://job-boards.greenhouse.io/acme/jobs/1" });
    const r = await postJson(base, "/api/apply/submit", { sessionId: "sess-1" });
    expect(r.status).toBe(410);
    const b = await r.json();
    expect(b.submitted).toBe(false);
    expect(b.error).toMatch(/yourself|manually|doesn't click/i);
  });

  it("mark-submitted records the user's own submit and clears the session", async () => {
    await postJson(base, "/api/apply", { url: "https://job-boards.greenhouse.io/acme/jobs/1" });

    const answered = await postJson(base, "/api/apply/field", { sessionId: "sess-1", ref: "eeo_race", value: "Decline to self-identify" });
    expect(answered.status).toBe(200);
    expect((await answered.json()).gate.needsConfirmation).toHaveLength(0);

    const ok = await postJson(base, "/api/apply/mark-submitted", { sessionId: "sess-1" });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.submitted).toBe(true);
    expect(okBody.reason).toMatch(/you submitted/i);

    // The session is cleared — marking again with no url finds nothing active.
    const again = await postJson(base, "/api/apply/mark-submitted", {});
    expect(again.status).toBe(409);
  });

  it("mark-submitted by url records the submit even after the session closed", async () => {
    const url = "https://job-boards.greenhouse.io/acme/jobs/99";
    const r = await postJson(base, "/api/apply/mark-submitted", { url, company: "Acme", title: "Analyst" });
    expect(r.status).toBe(200);
    expect((await r.json()).submitted).toBe(true);
    const rows = new ApplicationsRepo(db).list(profileId);
    const row = rows.find((a) => a.url === url);
    expect(row?.submitted).toBe(true);
  });

  it("A10: refuses to record a submit for a board/search page (not an individual posting)", async () => {
    const r = await postJson(base, "/api/apply/mark-submitted", { url: "https://job-boards.greenhouse.io/acme" });
    expect(r.status).toBe(422);
    expect((await r.json()).submitted).toBe(false);
  });

  it("A10: an unrecognized ATS page requires explicit confirmation before recording", async () => {
    const url = "https://careers.unknown-employer.example.com/jobs/eng-42";
    const without = await postJson(base, "/api/apply/mark-submitted", { url });
    expect(without.status).toBe(422);

    const withConfirm = await postJson(base, "/api/apply/mark-submitted", { url, confirm: true });
    expect(withConfirm.status).toBe(200);
    expect((await withConfirm.json()).submitted).toBe(true);
    expect(new ApplicationsRepo(db).list(profileId).find((a) => a.url === url)?.submitted).toBe(true);
  });

  it("refreshes the active browser-backed gate after a human handoff", async () => {
    await postJson(base, "/api/apply", { url: "https://job-boards.greenhouse.io/acme/jobs/1" });
    const refreshed = await postJson(base, "/api/apply/refresh", { sessionId: "sess-1" });
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json();
    expect(body.gate.needsConfirmation).toHaveLength(1);
    expect(body.gate.submitControlFound).toBe(true);
  });

  it("field answers require an active session", async () => {
    const field = await postJson(base, "/api/apply/field", { ref: "eeo_race", value: "x" });
    expect(field.status).toBe(409);
  });

  it("requires a job url to start", async () => {
    const r = await postJson(base, "/api/apply", {});
    expect(r.status).toBe(400);
  });

  it("serves the review-panel placeholder page the desktop shell embeds", async () => {
    const r = await fetch(`${base}/review-panel`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toMatch(/click Submit yourself/i);
  });

  it("cancel closes the session so the next mark-submitted finds nothing active", async () => {
    await postJson(base, "/api/apply", { url: "https://job-boards.greenhouse.io/acme/jobs/1" });
    const cancelled = await postJson(base, "/api/apply/cancel", {});
    expect(cancelled.status).toBe(200);
    const mark = await postJson(base, "/api/apply/mark-submitted", { sessionId: "sess-1" });
    expect(mark.status).toBe(409);
  });
});
