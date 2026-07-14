// src/server/access.ts
//
// The NETWORK ACCESS LAYER for the local API: where it binds, who may call /api, and which browser
// origins may call it cross-origin. This is the single seam that turns the on-box-only engine into
// something a phone on the user's Tailscale network can reach — without weakening the secure default.
//
// v1 access model (per product decision):
//   - Tailscale IS the access control. The API is reachable only to the user's own devices on their
//     tailnet (device identity enforced by WireGuard keys). No public exposure, no LAN broadcast.
//   - No pairing/bearer token is required in v1, BUT the token seam is built here and is inert unless
//     APPLYPILOT_AUTH_TOKEN is set — so a bearer/pairing token drops in later with NO route changes.
//   - The default bind stays 127.0.0.1 ONLY. Binding to the Tailscale interface is strictly opt-in
//     and config-gated (APPLYPILOT_BIND_HOST=tailscale | <ip>).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THREAT MODEL (v1)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  Default posture (no env set): bind 127.0.0.1 only. Nothing is reachable off-box; PII/secrets never
//    leave the machine. Mobile is strictly opt-in; the secure default is unchanged.
//
//  Opt-in exposure (APPLYPILOT_BIND_HOST=tailscale): bind ONLY to the 100.64.0.0/10 Tailscale address
//    (plus loopback, so the local Electron shell + health checks still work). This is a private
//    WireGuard mesh of the user's own devices — NOT a public listener: no port-forward, no inbound
//    from the internet, not bound to the LAN/Wi-Fi interface.
//    Trust boundary = the tailnet.
//
//  Residual risks accepted for v1 (documented; mitigations are seam-ready):
//    1. No app-layer auth when no token is set → any device already on the tailnet can call the API.
//       Mitigation seam: set APPLYPILOT_AUTH_TOKEN to require `Authorization: Bearer <token>` on
//       /api/*. Recommended the moment the tailnet contains shared or other-user devices.
//    2. Plaintext HTTP over the tailnet → acceptable: WireGuard already encrypts device-to-device, so
//       we do not add TLS in v1. If ever exposed beyond a tailnet, TLS + token become mandatory —
//       which is why binding to all interfaces (0.0.0.0) is refused unless explicitly forced.
//    3. DNS-rebinding / CSRF from a malicious page in the phone's browser → mitigated by a CORS
//       allowlist (no blanket "*" once exposed) and by the API being JSON-only with NO cookie auth,
//       so cross-site requests cannot ride ambient credentials.
//
//  Submission safety is INDEPENDENT of this layer: a phone-triggered apply still goes through the
//  same gated, confirm-before-submit path. This layer only governs reachability, never whether a
//  real application can be sent.

import { networkInterfaces } from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type BindMode = "loopback" | "tailscale" | "explicit" | "all";

export interface AccessConfig {
  /** Concrete host(s) to listen on. hosts[0] is the primary (always loopback unless "all"). */
  hosts: string[];
  mode: BindMode;
  /** When set, /api/* requires `Authorization: Bearer <token>`. Unset in v1 (Tailscale gates). */
  authToken?: string;
  /** Extra browser origins allowed to call the API cross-origin. localhost + tailnet are implicit. */
  allowedOrigins: string[];
}

/** True for an IPv4 in Tailscale's CGNAT range 100.64.0.0/10 (the tailnet address space). */
export function isTailscaleIp(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/** Find this machine's Tailscale IPv4 (100.64.0.0/10) among its interfaces, if the tailnet is up. */
export function findTailscaleIp(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && isTailscaleIp(a.address)) return a.address;
    }
  }
  return undefined;
}

/**
 * Resolve APPLYPILOT_BIND_HOST into concrete listen host(s). Default = loopback only (the secure
 * default). "tailscale" auto-detects the tailnet IP and ALSO keeps loopback (so the local app +
 * health checks still work). An explicit 100.x IP is treated as tailscale. Binding all interfaces
 * (0.0.0.0) is refused unless APPLYPILOT_ALLOW_ALL_INTERFACES=1, to avoid accidental LAN/public
 * exposure of a PII API.
 */
export function resolveBind(
  raw: string | undefined,
  opts: { allowAllInterfaces?: boolean; detectTailscale?: () => string | undefined } = {}
): { hosts: string[]; mode: BindMode } {
  const detect = opts.detectTailscale ?? findTailscaleIp;
  const v = (raw ?? "").trim().toLowerCase();

  if (v === "" || v === "127.0.0.1" || v === "localhost" || v === "loopback") {
    return { hosts: ["127.0.0.1"], mode: "loopback" };
  }

  if (v === "tailscale" || v === "ts") {
    const ip = detect();
    if (!ip) {
      throw new Error(
        "APPLYPILOT_BIND_HOST=tailscale but no Tailscale interface (100.64.0.0/10) was found. " +
          "Start Tailscale on this machine (the Mac mini), or set APPLYPILOT_BIND_HOST to the exact " +
          "100.x address, or unset it to stay 127.0.0.1-only."
      );
    }
    return { hosts: ["127.0.0.1", ip], mode: "tailscale" };
  }

  if (v === "0.0.0.0" || v === "all" || v === "lan") {
    if (!opts.allowAllInterfaces) {
      throw new Error(
        "Refusing to bind the PII API to all interfaces (0.0.0.0): that exposes it to the LAN/internet. " +
          "Use APPLYPILOT_BIND_HOST=tailscale for a private tailnet bind. To override deliberately, set " +
          "APPLYPILOT_ALLOW_ALL_INTERFACES=1 (and add APPLYPILOT_AUTH_TOKEN + TLS)."
      );
    }
    return { hosts: ["0.0.0.0"], mode: "all" };
  }

  // An explicit IP/host. If it's a tailnet address, keep loopback alongside it.
  return isTailscaleIp(v) ? { hosts: ["127.0.0.1", v], mode: "tailscale" } : { hosts: [v], mode: "explicit" };
}

/** Build the full AccessConfig from the environment (default = loopback-only, no token). */
export function loadAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const { hosts, mode } = resolveBind(env.APPLYPILOT_BIND_HOST, {
    allowAllInterfaces: env.APPLYPILOT_ALLOW_ALL_INTERFACES === "1",
  });
  const token = env.APPLYPILOT_AUTH_TOKEN?.trim();
  const allowedOrigins = (env.APPLYPILOT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { hosts, mode, ...(token ? { authToken: token } : {}), allowedOrigins };
}

// ── Auth seam ──────────────────────────────────────────────────────────────────────────────────

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };
export type Authorizer = (req: Pick<IncomingMessage, "headers">) => AuthResult;

/** Constant-time string compare (length-independent: hash both, then timingSafeEqual). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Which request paths the bearer gate covers. Everything under /api/* is gated EXCEPT /api/health:
 * the desktop shell's own liveness probe (electron/main.cjs pingEngine/waitForEngine) hits
 * /api/health with NO Authorization header, so once a token is mandatory a gated /api/health would
 * 401 the shell into thinking the engine is dead (duplicate spawn / boot timeout). /api/health
 * returns only {ok, browserBusy} — no PII — so leaving it open is safe and mirrors the unauthenticated
 * /review-panel exemption (which is not under /api/). Kept as a pure predicate so the exact carve-out
 * is unit-testable without standing up the server. Commercial M7 (control-surface hardening).
 */
export function requiresAuth(pathname: string): boolean {
  return pathname.startsWith("/api/") && pathname !== "/api/health";
}

/**
 * Build the /api authorizer. v1: when no token is configured this allows every request (Tailscale is
 * the gate). When APPLYPILOT_AUTH_TOKEN is set, it requires `Authorization: Bearer <token>` — the
 * drop-in pairing/bearer path, no route changes needed to enable it. Commercial M7 makes the desktop
 * shell auto-provision an ephemeral token so the loopback control surface is authenticated by default.
 */
export function createAuthorizer(access: Pick<AccessConfig, "authToken">): Authorizer {
  const token = access.authToken;
  if (!token) return () => ({ ok: true });
  return (req) => {
    const header = req.headers["authorization"];
    const raw = Array.isArray(header) ? header[0] : header;
    const m = /^Bearer\s+(.+)$/i.exec(raw ?? "");
    if (!m) return { ok: false, status: 401, message: "missing bearer token" };
    return safeEqual(m[1]!.trim(), token) ? { ok: true } : { ok: false, status: 403, message: "invalid token" };
  };
}

// ── CORS ─────────────────────────────────────────────────────────────────────────────────────────

/** localhost/127.0.0.1 (any port) — always allowed so dev (Vite proxy) and same-origin keep working. */
function isLocalOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

function isTailscaleOrigin(origin: string): boolean {
  try {
    return isTailscaleIp(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string, access: Pick<AccessConfig, "allowedOrigins">): boolean {
  return isLocalOrigin(origin) || isTailscaleOrigin(origin) || access.allowedOrigins.includes(origin);
}

/**
 * CORS headers for a given request Origin. Returns reflected, scoped headers ONLY for an allowed
 * origin (localhost, the tailnet, or an explicit allowlist) — never a blanket "*". A disallowed or
 * absent Origin yields no CORS headers: same-origin (the served dashboard) and native clients (no
 * Origin) are unaffected, while a cross-origin browser request is blocked.
 */
export function corsHeadersFor(
  origin: string | string[] | undefined,
  access: Pick<AccessConfig, "allowedOrigins">
): Record<string, string> {
  const o = Array.isArray(origin) ? origin[0] : origin;
  if (!o || !isAllowedOrigin(o, access)) return {};
  return {
    "access-control-allow-origin": o,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
  };
}

/** One-line human summary of the bind posture, for the startup log. */
export function describeBind(access: AccessConfig): string {
  const where = access.hosts.join(", ");
  const auth = access.authToken ? "bearer-token required" : "no token (Tailscale-gated)";
  return `${access.mode} [${where}] — ${auth}`;
}
