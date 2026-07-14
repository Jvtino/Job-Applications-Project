// SmartRecruiters apply adapter, verified end-to-end against a LOCAL fixture (never a real site).
//
// The field engine is shared with Greenhouse (via the same subclassing Ashby uses); what's
// SmartRecruiters-specific is DETECTION. The fixture avoids the Greenhouse/Lever/Ashby signatures,
// so a green `g.ats === "smartrecruiters"` proves pickAdapter routed correctly, and the shared
// engine fills identity + Yes/No screening and — critically — locates the submit control but NEVER
// submits in semi_auto. This is the honest basis for promoting SmartRecruiters to supported_form_fill.

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
  const html = readFileSync(join(here, "fixtures", "smartrecruiters-fixture.html"), "utf8");
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), "applypilot-sr-"));
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

describe("SmartRecruiters adapter (semi_auto), end-to-end in a real browser against a local fixture", () => {
  it("detects a SmartRecruiters form (not Greenhouse/Lever/Ashby), fills it, and never submits", async () => {
    const db: DB = openDatabase(join(dir, "sr.sqlite"));
    const url = `${baseUrl}/acme/743999912345678-operations-analyst`;
    const outcome = await runApplication(session, db, {
      url,
      mode: "semi_auto",
      profile: profileFixture(),
      company: "Acme Corp",
      title: "Operations Analyst",
    });

    expect(outcome.gate.ats).toBe("smartrecruiters"); // pickAdapter chose SmartRecruiters
    // Identity + Yes/No screening filled from user-confirmed answers.
    expect(find(outcome.gate.filled, /first name/i)?.resolvedValue).toBe("Jane");
    expect(find(outcome.gate.filled, /email/i)?.resolvedValue).toBe("jane.applicant@example.com");
    expect(find(outcome.gate.filled, /authorized to work/i)?.resolvedValue).toBe("Yes");
    expect(find(outcome.gate.filled, /18 years/i)?.resolvedValue).toBe("Yes");
    // Submit control located but NOT clicked, and the form's own guard never fired.
    expect(outcome.gate.submitControlRef).toBeTruthy();
    expect(outcome.submitted).toBe(false);
    const page = session.pages().find((p) => p.url().includes("/743999912345678"));
    const submitted = await page!.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted);
    expect(submitted).toBe(false);
    db.close();
  }, 90000);
});
