// src/ats/browser-provision.ts
//
// First-run Chromium provisioning for the packaged app (commercial M8). Playwright's Chromium is NEVER
// bundled in the DMG (keeps it small and avoids re-signing an .app-within-.app under the hardened
// runtime) and NEVER fetched via a customer-facing `npx`; the engine downloads it on demand into the
// userData browser cache instead. The shell points PLAYWRIGHT_BROWSERS_PATH at <userData>/browsers so
// the download, the presence check, and every launchPersistentContext agree on one location.
//
// This mirrors the LLM model-store's download-and-gate shape (src/llm/model-store.ts + /api/llm/status).
// Browser-dependent features gate on isChromiumInstalled() — a missing browser surfaces a clear
// "install it from Settings" state instead of Playwright's cryptic launch error.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

export interface BrowserStatus {
  /** The Chromium binary is present on disk and launchable. */
  present: boolean;
  /** A download is in flight. */
  installing: boolean;
  /** The browser cache directory Playwright resolves against (PLAYWRIGHT_BROWSERS_PATH), for diagnostics. */
  browsersPath: string | null;
  error?: string;
}

interface InstallJob {
  promise: Promise<void>;
}

let job: InstallJob | null = null;
let lastError: string | undefined;

/** The Chromium executable Playwright expects at the current PLAYWRIGHT_BROWSERS_PATH (may not exist yet). */
export function chromiumExecutablePath(): string | null {
  try {
    const p = chromium.executablePath();
    return p || null;
  } catch {
    return null;
  }
}

/** True when the Chromium browser binary is actually present on disk (i.e. launchable). */
export function isChromiumInstalled(): boolean {
  const p = chromiumExecutablePath();
  return Boolean(p && existsSync(p));
}

export function browserStatus(): BrowserStatus {
  return {
    present: isChromiumInstalled(),
    installing: job !== null,
    browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || null,
    ...(lastError ? { error: lastError } : {}),
  };
}

/** Resolve the Playwright install CLI. playwright/playwright-core are esbuild externals, so require.resolve
 *  is preserved into the bundle and resolves from node_modules at runtime (never executed under vitest). */
function playwrightCliPath(): string {
  try {
    return require.resolve("playwright-core/cli.js");
  } catch {
    return require.resolve("playwright/cli.js");
  }
}

/**
 * Download Chromium into PLAYWRIGHT_BROWSERS_PATH via Playwright's own install CLI (spawned under the
 * current runtime — Electron-as-Node in the packaged app, plain node in dev). Concurrent calls share one
 * job; resolves when the process exits. No-op (started:false) when Chromium is already present. Never
 * throws — failures surface via browserStatus().error.
 */
export function installChromium(): { started: boolean } {
  if (isChromiumInstalled()) return { started: false };
  if (job) return { started: true };
  lastError = undefined;

  let cli: string;
  try {
    cli = playwrightCliPath();
  } catch (e) {
    lastError = `could not locate the Playwright install CLI: ${e instanceof Error ? e.message : String(e)}`;
    return { started: false };
  }

  const promise = new Promise<void>((resolve) => {
    // Settle exactly once, on WHICHEVER of error/exit fires. A fork-time spawn failure (EAGAIN/EMFILE/
    // ENOMEM under load) emits "error" but NOT "exit"; resolving only on "exit" would leave `job` stuck
    // non-null forever, pinning browserStatus().installing=true and short-circuiting every retry.
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      // PLAYWRIGHT_BROWSERS_PATH + ELECTRON_RUN_AS_NODE (packaged) are already in the engine's env.
      env: { ...process.env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (e) => {
      lastError = e.message;
      settle();
    });
    child.on("exit", (code) => {
      if (code !== 0 && !isChromiumInstalled()) {
        lastError = `browser install exited with code ${code}`;
      }
      settle();
    });
  });

  job = { promise };
  void promise.finally(() => {
    job = null;
  });
  return { started: true };
}

/** Thrown at the browser-launch chokepoint when Chromium has not been provisioned yet. */
export class BrowserNotInstalledError extends Error {
  constructor() {
    super("The browser engine isn't installed yet. Open Settings and install it to use Find jobs and Apply.");
    this.name = "BrowserNotInstalledError";
  }
}
