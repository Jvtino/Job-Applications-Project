import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { BrowserSession } from "../src/ats/browser";
import { inspectAccountWall, prefillRegistration, generatePassword } from "../src/ats/account";
import { runApplication } from "../src/orchestrator/apply";
import { AccountsRepo } from "../src/db/accounts-repo";
import { createBlankProfile } from "../src/profile/factory";
import type { ApplicantProfile } from "../src/types/applicant-profile";

const here = dirname(fileURLToPath(import.meta.url));

let server: http.Server;
let baseUrl: string;
let host: string;
let session: BrowserSession;
let dir: string;

beforeAll(async () => {
  const html = readFileSync(join(here, "fixtures", "account-register.html"), "utf8");
  server = http.createServer((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/apply/signup`;
  host = `127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), "applypilot-acct-"));
  session = new BrowserSession({ headed: false, userDataDir: join(dir, "p"), minActionDelayMs: 1, maxActionDelayMs: 2 });
  await session.start();
}, 90000);

afterAll(async () => {
  await session?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function profileFixture(): ApplicantProfile {
  const p = createBlankProfile("acct");
  p.contact.legalFirstName = "Ahmet";
  p.contact.legalLastName = "Kaya";
  p.contact.email = "ahmet.kaya@example.com";
  p.contact.phone = "(415) 555-0188";
  return p;
}

describe("generatePassword", () => {
  it("produces a strong password with all character classes", () => {
    for (let i = 0; i < 25; i++) {
      const pw = generatePassword(20);
      expect(pw.length).toBe(20);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^A-Za-z0-9]/);
    }
    expect(generatePassword()).not.toBe(generatePassword()); // not deterministic
  });
});

describe("account wall: detect + pre-fill (NEVER password, NEVER submit)", () => {
  it("detects a registration wall and classifies it", async () => {
    const ctx = await session.open(baseUrl);
    const wall = await inspectAccountWall(ctx);
    expect(wall).toBeTruthy();
    expect(wall!.kind).toBe("register");
    expect(wall!.passwordFields).toBe(2);
    const roles = wall!.fields.map((f) => f.role);
    expect(roles).toContain("email");
    expect(roles).toContain("first_name");
    expect(roles).toContain("last_name");
  }, 90000);

  it("pre-fills only non-secret fields, leaves passwords empty, and never submits", async () => {
    const ctx = await session.open(baseUrl);
    const wall = await inspectAccountWall(ctx);
    const filled = await prefillRegistration(ctx, profileFixture().contact, wall!);
    expect(filled.length).toBeGreaterThanOrEqual(3);

    const vals = await ctx.page.evaluate(() => ({
      email: (document.getElementById("email") as HTMLInputElement).value,
      first: (document.getElementById("first") as HTMLInputElement).value,
      last: (document.getElementById("last") as HTMLInputElement).value,
      pw: (document.getElementById("pw") as HTMLInputElement).value,
      pw2: (document.getElementById("pw2") as HTMLInputElement).value,
      submitted: (window as unknown as { __accountSubmitted: boolean }).__accountSubmitted,
    }));

    expect(vals.email).toBe("ahmet.kaya@example.com");
    expect(vals.first).toBe("Ahmet");
    expect(vals.last).toBe("Kaya");
    // The critical guarantees:
    expect(vals.pw).toBe(""); // password field never touched
    expect(vals.pw2).toBe(""); // confirm-password never touched
    expect(vals.submitted).toBe(false); // account never created/submitted
  }, 90000);
});

describe("orchestrator pauses on an account wall and stores NO password", () => {
  it("returns accountRequired, records metadata only, and submits nothing", async () => {
    const db: DB = openDatabase(join(dir, "acct.sqlite"));
    const profile = profileFixture();

    const outcome = await runApplication(session, db, {
      url: baseUrl,
      mode: "semi_auto",
      profile,
      accountMode: "handoff", // detect + pause only (no clipboard side effects in tests)
      passwordStore: "1Password",
      company: "Acme",
    });

    expect(outcome.accountRequired).toBe(true);
    expect(outcome.submitted).toBe(false);
    expect(outcome.gate.accountAction?.kind).toBe("register");
    expect(outcome.gate.accountAction?.domain).toBe(host);
    expect(outcome.gate.readyForOneClickSubmit).toBe(false);

    const rec = new AccountsRepo(db).get(profile.id, host);
    expect(rec).toBeTruthy();
    expect(rec!.username).toBe("ahmet.kaya@example.com");
    expect(rec!.accountExists).toBe(false); // a registration, not an existing login
    expect(rec!.passwordStore).toBe("1Password");
    // There is no password to leak: the record type has no password field at all.
    expect(Object.keys(rec!)).not.toContain("password");

    db.close();
  }, 90000);
});
