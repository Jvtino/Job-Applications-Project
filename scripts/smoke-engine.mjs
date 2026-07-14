#!/usr/bin/env node
// scripts/smoke-engine.mjs
//
// Packaged-build smoke test (commercial M8). Boots the BUNDLED engine (app-build/engine.cjs) the way
// the packaged Electron shell does — a plain Node child with userData-style env — and asserts the core
// API answers. This catches a bundle that fails to boot (a bad esbuild external, a missing runtime dep)
// or a broken /api surface BEFORE a release ships, without needing Electron, a browser, or a model.
// Runs in CI and locally: `npm run smoke:engine` (build the bundle first with `npm run build:engine`).
// Exits 0 on success; non-zero with a diagnosis on failure.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ENGINE = join(ROOT, "app-build", "engine.cjs");
const BOOT_TIMEOUT_MS = 30_000;

function die(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

/** Ask the OS for a free loopback port (small TOCTOU window, fine for a single-shot smoke test). */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function waitForHealth(port, deadline, isDead) {
  while (Date.now() < deadline) {
    if (isDead()) throw new Error("engine process exited before it became ready");
    try {
      const { status, body } = await getJson(port, "/api/health");
      if (status === 200 && body && body.ok === true) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`engine did not answer GET /api/health within ${BOOT_TIMEOUT_MS}ms`);
}

async function main() {
  if (!existsSync(ENGINE)) die(`missing ${ENGINE} — run \`npm run build:engine\` first`);

  const dir = mkdtempSync(join(tmpdir(), "applypilot-smoke-"));
  const port = await freePort();
  const child = spawn(process.execPath, [ENGINE], {
    cwd: dir,
    env: {
      ...process.env,
      APPLYPILOT_API_PORT: String(port),
      APPLYPILOT_DB_PATH: join(dir, "smoke.sqlite"),
      APPLYPILOT_ENV_PATH: join(dir, ".env"),
      // No web root / CDP / auth token: /api/* answers on loopback with no token, and /api/health is
      // exempt regardless. A browser is never launched, so unprovisioned Chromium does not matter here.
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  };
  // die()'s assertion paths call process.exit() directly (no throw), bypassing the catch below — so run
  // cleanup on process exit too, or a failing smoke run would orphan the non-detached engine + temp dir.
  process.on("exit", cleanup);

  try {
    await waitForHealth(port, Date.now() + BOOT_TIMEOUT_MS, () => exited !== null);

    const health = await getJson(port, "/api/health");
    if (health.status !== 200 || !health.body || health.body.ok !== true) {
      die(`GET /api/health => ${health.status} ${JSON.stringify(health.body)}`);
    }

    const state = await getJson(port, "/api/state");
    if (state.status !== 200) die(`GET /api/state => ${state.status}`);
    if (!state.body || typeof state.body !== "object") die(`GET /api/state returned a non-object body`);

    console.log(`[smoke] OK — bundled engine booted on 127.0.0.1:${port}; /api/health + /api/state healthy`);
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error(`[smoke] ${err instanceof Error ? err.message : String(err)}`);
    cleanup();
    process.exit(1);
  }
}

main();
