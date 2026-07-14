// Proves the generic fallback fills unrecognized forms but never auto-submits them.

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
import { createBlankProfile } from "../src/profile/factory";

const here = dirname(fileURLToPath(import.meta.url));

let server: http.Server;
let url: string;
let session: BrowserSession;
let dir: string;

beforeAll(async () => {
  const html = readFileSync(join(here, "fixtures", "generic-fixture.html"), "utf8");
  server = http.createServer((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/northwind/careers/123/apply`;
  dir = mkdtempSync(join(tmpdir(), "applypilot-generic-"));
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
  p.contact.legalFirstName = "Jane";
  p.contact.legalLastName = "Applicant";
  p.contact.email = "jane.applicant@example.com";
  p.contact.phone = "(415) 555-0137";
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  p.screening.isAtLeast18 = { value: true, source: "user", updatedAt: "" };
  return p;
}

describe("generic fallback (semi/auto), end-to-end in a real browser against a local fixture", () => {
  it("falls through to the generic adapter and pauses even when approved + live", async () => {
    const db: DB = openDatabase(join(dir, "generic.sqlite"));
    const out = await runApplication(session, db, {
      url,
      mode: "auto",
      profile: cleanProfile("g"),
      company: "Northwind",
      title: "Operations Analyst",
      autoSubmitApproved: true,
      liveSubmit: true,
    });

    expect(out.gate.ats).toBe("generic");

    const first = out.gate.filled.find((m) => /first name/i.test(m.field.label));
    expect(first?.resolvedValue).toBe("Jane");

    expect(out.submitted).toBe(false);

    const page = session.pages().find((p) => p.url().includes("/careers/123/apply"));
    expect(page).toBeTruthy();
    const submitted = await page!.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted);
    expect(submitted).toBe(false);

    db.close();
  }, 90000);
});
