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
import { AccountsRepo } from "../src/db/accounts-repo";
import { createBlankProfile } from "../src/profile/factory";
import type { ApplicantProfile } from "../src/types/applicant-profile";

const here = dirname(fileURLToPath(import.meta.url));

// The server flips between a LOGIN WALL and a LOGGED-IN apply page at the SAME url, to simulate
// "you logged in once; the persistent session now reaches the application form".
let pageMode: "login" | "loggedin" = "login";
let server: http.Server;
let url: string;
let host: string;
let session: BrowserSession;
let dir: string;

beforeAll(async () => {
  const loginHtml = readFileSync(join(here, "fixtures", "login-wall.html"), "utf8");
  const appHtml = readFileSync(join(here, "fixtures", "greenhouse-fixture.html"), "utf8");
  server = http.createServer((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end(pageMode === "login" ? loginHtml : appHtml);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}/acme/jobs/9/apply`;
  host = `127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), "applypilot-sess-"));
  session = new BrowserSession({ headed: false, userDataDir: join(dir, "p"), minActionDelayMs: 1, maxActionDelayMs: 2 });
  await session.start();
}, 90000);

afterAll(async () => {
  await session?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function profileFixture(): ApplicantProfile {
  const p = createBlankProfile("sess");
  p.contact.legalFirstName = "Ahmet";
  p.contact.legalLastName = "Kaya";
  p.contact.email = "ahmet.kaya@example.com";
  p.contact.phone = "(415) 555-0188";
  p.workAuthorization.authorizedToWorkInUS = { value: true, source: "user", updatedAt: "" };
  return p;
}

describe("log in once -> session persists -> auto from then on", () => {
  it("pauses on the login wall, then on a later run recognizes the live session", async () => {
    const db: DB = openDatabase(join(dir, "sess.sqlite"));
    const profile = profileFixture();
    const accounts = new AccountsRepo(db);

    // Run 1: login wall -> pause, record that we need a login (session not active).
    pageMode = "login";
    const run1 = await runApplication(session, db, { url, mode: "semi_auto", profile, accountMode: "handoff", company: "Acme" });
    expect(run1.accountRequired).toBe(true);
    expect(run1.gate.accountAction?.kind).toBe("login");
    expect(run1.submitted).toBe(false);
    const a1 = accounts.get(profile.id, host)!;
    expect(a1.loggedIn).toBe(false);
    expect(accounts.isSessionReady(profile.id, host)).toBe(false);

    // The human logs in (simulated by the page no longer showing a login wall).
    pageMode = "loggedin";

    // Run 2: same url, dedup allows the retry (run 1 wasn't submitted); the wall is gone, so the
    // session is recognized as active and the app proceeds to the application form.
    const run2 = await runApplication(session, db, { url, mode: "semi_auto", profile, accountMode: "handoff", company: "Acme" });
    expect(run2.accountRequired).toBeFalsy();
    expect(run2.sessionActivated).toBe(true);
    expect(run2.gate.ats).toBe("greenhouse"); // reached the real form
    expect(accounts.isSessionReady(profile.id, host)).toBe(true);
    const a2 = accounts.get(profile.id, host)!;
    expect(a2.loggedIn).toBe(true);
    expect(a2.lastLoginAt).toBeTruthy();
    // Still no credential stored anywhere.
    expect(Object.keys(a2)).not.toContain("password");

    db.close();
  }, 120000);
});
