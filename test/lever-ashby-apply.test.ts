// Lever + Ashby apply adapters, verified end-to-end against LOCAL fixtures (never a real site).
//
// The field engine is shared with Greenhouse; what's Lever/Ashby-specific is DETECTION. These forms
// deliberately avoid Greenhouse's signature, so a green `g.ats === "lever" | "ashby"` proves
// pickAdapter (Greenhouse -> Lever -> Ashby) routed correctly. Each form is fully mappable, so we
// also confirm the shared engine fills identity + Yes/No screening on their distinct markup and —
// critically — locates the submit control but NEVER submits in semi_auto.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import type { ApplicantProfile } from "../src/types/applicant-profile";
import { openDatabase, type DB } from "../src/db/database";
import { BrowserSession } from "../src/ats/browser";
import { runApplication } from "../src/orchestrator/apply";
import type { ReviewGate } from "../src/orchestrator/review-gate";
import { createBlankProfile } from "../src/profile/factory";

const here = dirname(fileURLToPath(import.meta.url));

let server: http.Server;
let baseUrl: string;
let session: BrowserSession;
let dir: string;

beforeAll(async () => {
  const lever = readFileSync(join(here, "fixtures", "lever-fixture.html"), "utf8");
  const ashby = readFileSync(join(here, "fixtures", "ashby-fixture.html"), "utf8");
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end((req.url ?? "").includes("/ashby") ? ashby : lever);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  dir = mkdtempSync(join(tmpdir(), "applypilot-leverashby-"));
  session = new BrowserSession({ headed: false, userDataDir: join(dir, "profile"), minActionDelayMs: 1, maxActionDelayMs: 2 });
  await session.start();
}, 90000);

afterAll(async () => {
  await session?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function profileFixture(): ApplicantProfile {
  const p = createBlankProfile("applicant");
  p.contact.legalFirstName = "Jane";
  p.contact.legalLastName = "Applicant";
  p.contact.email = "jane.applicant@example.com";
  p.contact.phone = "(415) 555-0137";
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  p.workAuthorization.requiresSponsorshipNowOrFuture = { value: false, source: "user", updatedAt: "" };
  p.screening.isAtLeast18 = { value: true, source: "user", updatedAt: "" };
  return p;
}

const find = (arr: ReviewGate["filled"], re: RegExp) => arr.find((m) => re.test(m.field.label));

async function assertFilledAndNeverSubmitted(g: ReviewGate, pageMatch: string): Promise<void> {
  // Identity filled from the profile.
  expect(find(g.filled, /first name/i)?.resolvedValue).toBe("Jane");
  expect(find(g.filled, /email/i)?.resolvedValue).toBe("jane.applicant@example.com");
  // Yes/No screening mapped from user-confirmed answers.
  expect(find(g.filled, /authorized to work/i)?.resolvedValue).toBe("Yes");
  expect(find(g.filled, /18 years/i)?.resolvedValue).toBe("Yes");
  // Nothing required was left unmapped (fully-mappable form).
  expect(g.needsConfirmation).toHaveLength(0);
  // Submit control located but NOT clicked.
  expect(g.submitControlRef).toBeTruthy();
  // The form's own submit guard never fired.
  const page = session.pages().find((p) => p.url().includes(pageMatch));
  expect(page).toBeTruthy();
  const submitted = await page!.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted);
  expect(submitted).toBe(false);
}

describe("Lever + Ashby adapters (semi_auto), end-to-end in a real browser against local fixtures", () => {
  it("detects a Lever form (not Greenhouse), fills it, and never submits", async () => {
    const db: DB = openDatabase(join(dir, "lever.sqlite"));
    const url = `${baseUrl}/acme/lever/postings/123/apply`;
    const outcome = await runApplication(session, db, {
      url,
      mode: "semi_auto",
      profile: profileFixture(),
      company: "Acme Corp",
      title: "Operations Analyst",
    });
    expect(outcome.gate.ats).toBe("lever"); // pickAdapter chose Lever, not Greenhouse/generic
    await assertFilledAndNeverSubmitted(outcome.gate, "/lever/");
    expect(outcome.submitted).toBe(false);
    db.close();
  }, 90000);

  it("detects an Ashby form (not Greenhouse/Lever), fills it, and never submits", async () => {
    const db: DB = openDatabase(join(dir, "ashby.sqlite"));
    const url = `${baseUrl}/acme/ashby/application/abc`;
    const outcome = await runApplication(session, db, {
      url,
      mode: "semi_auto",
      profile: profileFixture(),
      company: "Acme Corp",
      title: "Operations Analyst",
    });
    expect(outcome.gate.ats).toBe("ashby"); // Ashby detection beat the others
    await assertFilledAndNeverSubmitted(outcome.gate, "/ashby/");
    expect(outcome.submitted).toBe(false);
    db.close();
  }, 90000);
});
