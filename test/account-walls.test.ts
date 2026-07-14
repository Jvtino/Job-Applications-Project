// A6: account/login-wall detection beyond password fields. Modern ATS auth is often passwordless
// (SSO, magic link, email verification code, email-first "create account"). Those must pause; a
// normal application form that merely has a "Sign in" link must NOT falsely pause.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { BrowserSession } from "../src/ats/browser";
import { inspectAccountWall } from "../src/ats/account";

const here = dirname(fileURLToPath(import.meta.url));

function serve(file: string): Promise<{ server: http.Server; url: (p?: string) => string }> {
  const html = readFileSync(join(here, "fixtures", file), "utf8");
  const server = http.createServer((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: (p = "/") => `http://127.0.0.1:${port}${p}` });
    });
  });
}

let session: BrowserSession;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "applypilot-walls-"));
  session = new BrowserSession({ headed: false, userDataDir: join(dir, "p"), minActionDelayMs: 1, maxActionDelayMs: 2 });
  await session.start();
}, 90000);

afterAll(async () => {
  await session?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("A6: account/login wall detection beyond password fields", () => {
  it("pauses on an SSO wall (Continue with Google/LinkedIn, no password)", async () => {
    const { server, url } = await serve("account-sso.html");
    try {
      const ctx = await session.open(url("/candidate/portal"));
      const wall = await inspectAccountWall(ctx);
      expect(wall).toBeTruthy();
      expect(wall!.passwordFields).toBe(0);
      expect(wall!.signal).toBe("sso");
      expect(wall!.kind).toBe("login");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 90000);

  it("pauses on an email verification-code / magic-link wall", async () => {
    const { server, url } = await serve("account-magic-link.html");
    try {
      const ctx = await session.open(url("/auth/verify"));
      const wall = await inspectAccountWall(ctx);
      expect(wall).toBeTruthy();
      expect(wall!.passwordFields).toBe(0);
      expect(["verification", "magic_link"]).toContain(wall!.signal);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 90000);

  it("does NOT pause a normal application form that has a 'Sign in' link in the header", async () => {
    const { server, url } = await serve("apply-with-signin-link.html");
    try {
      const ctx = await session.open(url("/jobs/123/apply"));
      const wall = await inspectAccountWall(ctx);
      expect(wall).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 90000);
});
