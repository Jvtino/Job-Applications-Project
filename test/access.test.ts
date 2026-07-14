// Network access layer: bind-host resolution, the (token-ready) auth seam, and CORS scoping.
//
// The security-critical properties under test:
//  - the secure DEFAULT is unchanged (loopback only, no token, no blanket CORS);
//  - exposing the PII API to all interfaces is refused unless explicitly forced;
//  - "tailscale" mode keeps loopback alongside the tailnet IP (local app keeps working);
//  - the auth seam is inert in v1 (no token) but enforces Bearer auth the moment a token is set;
//  - CORS reflects only allowed origins (localhost / tailnet / allowlist), never "*".

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  resolveBind,
  loadAccessConfig,
  createAuthorizer,
  requiresAuth,
  corsHeadersFor,
  isTailscaleIp,
  type AccessConfig,
} from "../src/server/access";
import { openDatabase, type DB } from "../src/db/database";
import { startApiServer } from "../src/server/api";

describe("isTailscaleIp", () => {
  it("matches the 100.64.0.0/10 CGNAT range only", () => {
    expect(isTailscaleIp("100.64.0.1")).toBe(true);
    expect(isTailscaleIp("100.115.92.3")).toBe(true);
    expect(isTailscaleIp("100.127.255.254")).toBe(true);
    expect(isTailscaleIp("100.63.0.1")).toBe(false); // below the range
    expect(isTailscaleIp("100.128.0.1")).toBe(false); // above the range
    expect(isTailscaleIp("192.168.1.10")).toBe(false);
    expect(isTailscaleIp("not-an-ip")).toBe(false);
  });
});

describe("resolveBind", () => {
  it("defaults to loopback only (the secure default)", () => {
    for (const v of [undefined, "", "127.0.0.1", "localhost", "loopback"]) {
      expect(resolveBind(v)).toEqual({ hosts: ["127.0.0.1"], mode: "loopback" });
    }
  });

  it("tailscale mode keeps loopback alongside the detected tailnet IP", () => {
    const out = resolveBind("tailscale", { detectTailscale: () => "100.115.92.7" });
    expect(out).toEqual({ hosts: ["127.0.0.1", "100.115.92.7"], mode: "tailscale" });
  });

  it("throws a helpful error when tailscale is requested but the tailnet is down", () => {
    expect(() => resolveBind("tailscale", { detectTailscale: () => undefined })).toThrow(/no Tailscale interface/i);
  });

  it("treats an explicit 100.x IP as tailscale (loopback kept)", () => {
    expect(resolveBind("100.64.10.10")).toEqual({ hosts: ["127.0.0.1", "100.64.10.10"], mode: "tailscale" });
  });

  it("REFUSES binding all interfaces unless explicitly forced", () => {
    expect(() => resolveBind("0.0.0.0")).toThrow(/all interfaces/i);
    expect(resolveBind("0.0.0.0", { allowAllInterfaces: true })).toEqual({ hosts: ["0.0.0.0"], mode: "all" });
  });
});

describe("loadAccessConfig", () => {
  it("reads bind host, token, and origin allowlist from the environment", () => {
    const cfg = loadAccessConfig({
      APPLYPILOT_BIND_HOST: "100.100.100.100",
      APPLYPILOT_AUTH_TOKEN: "  s3cret  ",
      APPLYPILOT_ALLOWED_ORIGINS: "http://a.example, http://b.example ,",
    } as NodeJS.ProcessEnv);
    expect(cfg.hosts).toEqual(["127.0.0.1", "100.100.100.100"]);
    expect(cfg.authToken).toBe("s3cret"); // trimmed
    expect(cfg.allowedOrigins).toEqual(["http://a.example", "http://b.example"]);
  });

  it("default env => loopback, no token", () => {
    const cfg = loadAccessConfig({} as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ hosts: ["127.0.0.1"], mode: "loopback", allowedOrigins: [] });
    expect(cfg.authToken).toBeUndefined();
  });
});

describe("createAuthorizer", () => {
  it("allows everything when no token is set (v1: Tailscale gates)", () => {
    const authz = createAuthorizer({});
    expect(authz({ headers: {} })).toEqual({ ok: true });
  });

  it("requires a correct Bearer token once a token is configured", () => {
    const authz = createAuthorizer({ authToken: "good-token" });
    expect(authz({ headers: {} })).toMatchObject({ ok: false, status: 401 });
    expect(authz({ headers: { authorization: "Bearer wrong" } })).toMatchObject({ ok: false, status: 403 });
    expect(authz({ headers: { authorization: "Bearer good-token" } })).toEqual({ ok: true });
    expect(authz({ headers: { authorization: "bearer good-token" } })).toEqual({ ok: true }); // case-insensitive scheme
  });
});

describe("requiresAuth (M7 control-surface carve-out)", () => {
  it("gates every data /api/* path", () => {
    for (const p of ["/api/state", "/api/apply", "/api/settings", "/api/generated", "/api/errors"]) {
      expect(requiresAuth(p)).toBe(true);
    }
  });

  it("EXEMPTS /api/health so the shell's unauthenticated liveness probe keeps working", () => {
    expect(requiresAuth("/api/health")).toBe(false);
  });

  it("does not gate the SPA shell, static assets, or the review-panel page", () => {
    for (const p of ["/", "/index.html", "/assets/app.js", "/review-panel"]) {
      expect(requiresAuth(p)).toBe(false);
    }
  });
});

describe("corsHeadersFor", () => {
  const access = { allowedOrigins: ["https://app.example.com"] };

  it("reflects an allowed origin (localhost / tailnet / allowlist), never '*'", () => {
    expect(corsHeadersFor("http://localhost:5174", access)["access-control-allow-origin"]).toBe("http://localhost:5174");
    expect(corsHeadersFor("http://100.115.92.7:5179", access)["access-control-allow-origin"]).toBe("http://100.115.92.7:5179");
    expect(corsHeadersFor("https://app.example.com", access)["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("returns no CORS headers for a disallowed or absent origin", () => {
    expect(corsHeadersFor("https://evil.example", access)).toEqual({});
    expect(corsHeadersFor(undefined, access)).toEqual({});
  });

  it("allows the Authorization header (for the future bearer token)", () => {
    expect(corsHeadersFor("http://localhost:5174", access)["access-control-allow-headers"]).toContain("authorization");
  });
});

describe("auth seam over the live API", () => {
  let dir: string;
  let db: DB;
  let openServer: http.Server;
  let lockedServer: http.Server;

  const noToken: AccessConfig = { hosts: ["127.0.0.1"], mode: "loopback", allowedOrigins: [] };
  const withToken: AccessConfig = { hosts: ["127.0.0.1"], mode: "loopback", authToken: "tok-123", allowedOrigins: [] };

  async function base(s: http.Server): Promise<string> {
    await new Promise<void>((r) => (s.listening ? r() : s.once("listening", () => r())));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-access-"));
    db = openDatabase(join(dir, "a.sqlite"));
    openServer = startApiServer(0, { db, access: noToken, envPath: join(dir, "open.env") });
    lockedServer = startApiServer(0, { db, access: withToken, envPath: join(dir, "locked.env") });
  });

  afterAll(async () => {
    await new Promise<void>((r) => openServer.close(() => r()));
    await new Promise<void>((r) => lockedServer.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("v1 (no token): /api/health is reachable without auth", async () => {
    const res = await fetch(`${await base(openServer)}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("token set: data /api/* needs the token, but /api/health stays exempt (M7 shell probe)", async () => {
    const b = await base(lockedServer);
    // /api/health is intentionally exempt (access.requiresAuth) so the desktop shell's unauthenticated
    // liveness probe keeps working once a token is mandatory — it returns only {ok, browserBusy}.
    expect((await fetch(`${b}/api/health`)).status).toBe(200);
    // A real data route IS gated: 401 without a token, 403 with a wrong one, 200 with the right one.
    expect((await fetch(`${b}/api/state`)).status).toBe(401);
    expect((await fetch(`${b}/api/state`, { headers: { authorization: "Bearer nope" } })).status).toBe(403);
    const ok = await fetch(`${b}/api/state`, { headers: { authorization: "Bearer tok-123" } });
    expect(ok.status).toBe(200);
  });

  it("CORS reflects an allowed Origin and is not a blanket '*'", async () => {
    const res = await fetch(`${await base(openServer)}/api/health`, { headers: { origin: "http://localhost:5174" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5174");
    const blocked = await fetch(`${await base(openServer)}/api/health`, { headers: { origin: "https://evil.example" } });
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });
});
