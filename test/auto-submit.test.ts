import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { BrowserSession } from "../src/ats/browser";
import { runApplication } from "../src/orchestrator/apply";
import { decideAutoSubmit } from "../src/orchestrator/auto-submit";
import type { ReviewGate } from "../src/orchestrator/review-gate";
import { createBlankProfile } from "../src/profile/factory";
import type { ApplicantProfile } from "../src/types/applicant-profile";
import type { MatchResult } from "../src/ats/adapter";

const here = dirname(fileURLToPath(import.meta.url));

function gate(over: Partial<ReviewGate> = {}): ReviewGate {
  return {
    url: "u",
    ats: "greenhouse",
    mode: "auto",
    filled: [],
    flaggedForReview: [],
    needsConfirmation: [],
    attachedDocuments: [],
    challengeDetected: false,
    submitControlRef: "apf-submit",
    readyForOneClickSubmit: true,
    ...over,
  };
}
const m = {} as MatchResult;

describe("decideAutoSubmit gating (pure)", () => {
  it("queues unless mode=auto AND approved AND every gate passes", () => {
    expect(decideAutoSubmit(gate(), "semi_auto", true, true).action).toBe("queue");
    expect(decideAutoSubmit(gate(), "auto", false, true).action).toBe("queue");
    expect(decideAutoSubmit(gate(), "auto", true, true).action).toBe("submit");
    expect(decideAutoSubmit(gate({ ats: "generic" }), "auto", true, true).action).toBe("queue");
    expect(decideAutoSubmit(gate({ challengeDetected: true }), "auto", true, true).action).toBe("queue");
    expect(decideAutoSubmit(gate({ accountAction: { kind: "login", domain: "x", prefilled: [], passwordOnClipboard: false } }), "auto", true, true).action).toBe("queue");
    expect(decideAutoSubmit(gate({ needsConfirmation: [m] }), "auto", true, true).action).toBe("queue");
    expect(decideAutoSubmit(gate({ flaggedForReview: [m] }), "auto", true, true).action).toBe("submit");
    expect(decideAutoSubmit(gate({ ledgerCheck: { passed: false, checks: [] } }), "auto", true, true).action).toBe("queue");
    expect(decideAutoSubmit(gate({ submitControlRef: undefined }), "auto", true, true).action).toBe("queue");
  });

  it('dry-run -> "would_submit", live -> "submit"', () => {
    expect(decideAutoSubmit(gate(), "auto", true, false).action).toBe("would_submit");
    expect(decideAutoSubmit(gate(), "auto", true, true).action).toBe("submit");
  });
});

// ---- Browser gating against a fully auto-submittable Greenhouse fixture ----

let server: http.Server;
let url: string;
let session: BrowserSession;
let dir: string;

beforeAll(async () => {
  const html = readFileSync(join(here, "fixtures", "greenhouse-clean.html"), "utf8");
  server = http.createServer((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/acme/jobs/clean/apply`;
  dir = mkdtempSync(join(tmpdir(), "applypilot-auto-"));
  session = new BrowserSession({ headed: false, userDataDir: join(dir, "p"), minActionDelayMs: 1, maxActionDelayMs: 2 });
  await session.start();
}, 90000);

afterAll(async () => {
  await session?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function cleanProfile(id: string): ApplicantProfile {
  const p = createBlankProfile(id);
  p.contact.legalFirstName = "Ahmet";
  p.contact.legalLastName = "Kaya";
  p.contact.email = "ahmet.kaya@example.com";
  p.contact.phone = "(415) 555-0188";
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  p.screening.isAtLeast18 = { value: true, source: "user", updatedAt: "" };
  return p;
}

async function pageSubmitted(): Promise<boolean> {
  // The shared session accumulates a page per run; check the MOST RECENT /clean/apply page.
  const pages = session.pages().filter((p) => p.url().includes("/clean/apply"));
  const page = pages.at(-1);
  return page ? page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted) : false;
}

describe("auto mode removed from product (real browser)", () => {
  it("mode=auto never submits — pauses at review gate like semi_auto", async () => {
    const db: DB = openDatabase(join(dir, "dry.sqlite"));
    const out = await runApplication(session, db, { url, mode: "auto", profile: cleanProfile("a"), company: "Acme", autoSubmitApproved: true, liveSubmit: true });
    expect(out.submitted).toBe(false);
    expect(out.autoSubmitDecision).toBeUndefined();
    expect(await pageSubmitted()).toBe(false);
    db.close();
  }, 90000);

  it("semi_auto still never submits", async () => {
    const db: DB = openDatabase(join(dir, "semi.sqlite"));
    const out = await runApplication(session, db, { url, mode: "semi_auto", profile: cleanProfile("b"), company: "Acme" });
    expect(out.submitted).toBe(false);
    expect(await pageSubmitted()).toBe(false);
    db.close();
  }, 90000);
});
