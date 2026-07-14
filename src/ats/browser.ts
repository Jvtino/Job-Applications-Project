// src/ats/browser.ts
//
// Playwright session manager. Design rules from the brief (hard constraints):
//   - HEADED by default, so the user can watch and intervene at any time.
//   - Uses the user's OWN persistent browser profile (they log in once, manually).
//   - Human-like pacing: randomized multi-second delays between actions.
//   - Hard per-host hourly cap and a daily ceiling on page opens; never retry aggressively.
//   - Automated scraping (discovery) respects robots.txt (see robots.ts); user-initiated actions
//     (add-by-URL, apply review) navigate like the user's own browser.
//   - NO anti-bot evasion: no fingerprint spoofing, no stealth args, no proxy rotation. If a
//     site blocks us or shows a challenge, we stop and surface the browser to the user.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BrowserNotInstalledError } from "./browser-provision";
import { chromium, type BrowserContext, type Page } from "playwright";
import { makePageContext, type PlaywrightPageContext } from "./page-context";
import { RobotsCache, RobotsDisallowedError, ROBOTS_FETCH_USER_AGENT, type RobotsFetcher } from "./robots";

export interface BrowserOptions {
  /** Headed by default (false only for automated tests). */
  headed?: boolean;
  /** Persistent user-data dir so logins survive across runs. Gitignored. */
  userDataDir?: string;
  perHostHourlyCap?: number;
  dailyCap?: number;
  minActionDelayMs?: number;
  maxActionDelayMs?: number;
  /** Opt-in: record a Playwright video of the session into this dir ("" = off). For demos/debugging. */
  recordVideoDir?: string;
  /**
   * When true, open() consults the host's robots.txt first and throws RobotsDisallowedError for
   * disallowed paths. Discovery (automated scraping) turns this on — runDiscovery toggles it via
   * setRespectRobots() so shared sessions keep the user-initiated apply flow unaffected.
   */
  respectRobots?: boolean;
}

/** Packaged app roots the profile under the OS user-data dir; dev keeps repo-relative. */
function defaultUserDataDir(): string {
  return process.env.APPLYPILOT_BROWSER_PROFILE_DIR?.trim() || "./browser-profile";
}

const DEFAULTS = {
  headed: true,
  get userDataDir() { return defaultUserDataDir(); },
  perHostHourlyCap: 20,
  dailyCap: 60,
  minActionDelayMs: 800,
  maxActionDelayMs: 2500,
  recordVideoDir: "",
  respectRobots: false,
};

export class RateLimitError extends Error {}

/**
 * What the apply orchestration needs from a browser session, whatever owns the actual browser:
 * BrowserSession launches its own (headed) Chromium; EmbeddedBrowserSession drives the desktop
 * app's in-app review panel over CDP. Both are visible to the user — never a hidden session.
 */
export interface EngineBrowserSession {
  start(): Promise<void>;
  open(url: string): Promise<PlaywrightPageContext>;
  pace(): Promise<void>;
  pages(): Page[];
  close(): Promise<void>;
}

/** In-session rate limiter for page opens (cross-RUN application caps live in the DB). */
export class RateLimiter {
  private opens: { host: string; ts: number }[] = [];
  constructor(private readonly perHostHourly: number, private readonly daily: number) {}

  record(host: string): void {
    const now = Date.now();
    this.opens = this.opens.filter((o) => now - o.ts < 24 * 3600_000);
    const dayCount = this.opens.length;
    const hourHostCount = this.opens.filter(
      (o) => o.host === host && now - o.ts < 3600_000
    ).length;
    if (dayCount >= this.daily) {
      throw new RateLimitError(`Daily page-open ceiling (${this.daily}) reached. Stopping for safety.`);
    }
    if (hourHostCount >= this.perHostHourly) {
      throw new RateLimitError(
        `Hourly cap for ${host} (${this.perHostHourly}) reached. Slow down to protect the account/site.`
      );
    }
    this.opens.push({ host, ts: now });
  }
}

export class BrowserSession implements EngineBrowserSession {
  private context?: BrowserContext;
  private readonly opts: Required<BrowserOptions>;
  private readonly limiter: RateLimiter;
  private robotsEnforced: boolean;
  private robotsCache?: RobotsCache;

  constructor(options: BrowserOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.limiter = new RateLimiter(this.opts.perHostHourlyCap, this.opts.dailyCap);
    this.robotsEnforced = this.opts.respectRobots;
  }

  /**
   * Toggle robots.txt enforcement for subsequent open() calls, returning the previous value so a
   * scoped caller (discovery) can restore it. The per-host verdict cache persists across toggles.
   */
  setRespectRobots(value: boolean): boolean {
    const prev = this.robotsEnforced;
    this.robotsEnforced = value;
    return prev;
  }

  async start(): Promise<void> {
    // launchPersistentContext keeps cookies/logins in userDataDir. No stealth/UA spoofing.
    const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: !this.opts.headed,
      viewport: null,
    };
    // Opt-in screen recording (demos/debugging). Video flushes to disk when the context closes.
    if (this.opts.recordVideoDir) {
      launchOpts.recordVideo = { dir: this.opts.recordVideoDir, size: { width: 1280, height: 800 } };
    }
    try {
      this.context = await chromium.launchPersistentContext(this.opts.userDataDir, launchOpts);
    } catch (err) {
      // A prior run that didn't close cleanly leaves Chromium's profile-singleton lock behind, and
      // the next launch then fails with "profile appears to be in use" (the classic "opens then
      // crashes"). Clear the stale lock files and retry ONCE. If it still fails, surface the error.
      if (isProfileLockError(err)) {
        clearProfileLocks(this.opts.userDataDir);
        this.context = await chromium.launchPersistentContext(this.opts.userDataDir, launchOpts);
      } else if (isMissingBrowserError(err)) {
        // Commercial M8: the packaged app downloads Chromium on first run to userData, so a fresh
        // install has no browser yet. Turn Playwright's cryptic "Executable doesn't exist" into a clear,
        // actionable error. Gated on the ACTUAL launch failure (not a pre-check), so an out-of-band
        // Chromium at a nonstandard path — CI, dev container — is never wrongly blocked.
        throw new BrowserNotInstalledError();
      } else {
        throw err;
      }
    }
    // esbuild's keepNames (used by tsx) wraps named functions with a `__name` helper. When we
    // pass such a function to page.evaluate, the helper is undefined in the page. Define a
    // no-op shim (raw string so the bundler can't rewrite it) before any page script runs.
    await this.context.addInitScript({
      content: "globalThis.__name = globalThis.__name || function (f) { return f; };",
    });
  }

  /** Open a URL in a new page, enforcing robots.txt (when on), per-host/daily caps, and pacing. */
  async open(url: string): Promise<PlaywrightPageContext> {
    if (!this.context) throw new Error("BrowserSession not started.");
    if (this.robotsEnforced) {
      // Checked before the rate limiter so a disallowed URL doesn't consume page-open quota. The
      // robots probe rides the browser's OWN request context (this.context.request) so it shares
      // the exact proxy + certificate + cookie egress the scrape uses — a mismatch there would let
      // a corporate-proxy/TLS-inspection environment silently disallow all discovery.
      this.robotsCache ??= new RobotsCache({ fetcher: this.browserRobotsFetcher() });
      if (!(await this.robotsCache.isAllowed(url))) throw new RobotsDisallowedError(url);
    }
    const host = safeHost(url);
    this.limiter.record(host);
    await this.pace();
    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    return makePageContext(page);
  }

  /** robots.txt fetcher backed by the browser context's request stack (same egress as scraping). */
  private browserRobotsFetcher(): RobotsFetcher {
    return async (robotsUrl, { timeoutMs, maxBytes }) => {
      const ctx = this.context;
      if (!ctx) throw new Error("BrowserSession not started.");
      const res = await ctx.request.get(robotsUrl, {
        headers: { "user-agent": ROBOTS_FETCH_USER_AGENT, accept: "text/plain,*/*" },
        timeout: timeoutMs,
        maxRedirects: 5,
        failOnStatusCode: false,
      });
      // Guard memory: skip a declared-huge body (redirect-to-a-giant-file etc.) — treat as no rules.
      const declared = Number(res.headers()["content-length"] ?? "");
      if (Number.isFinite(declared) && declared > maxBytes * 20) {
        return { status: res.status(), text: "" };
      }
      const body = await res.body();
      return { status: res.status(), text: body.subarray(0, maxBytes).toString("utf8") };
    };
  }

  /** Randomized multi-second pause to pace actions like a human. */
  async pace(): Promise<void> {
    const { minActionDelayMs: lo, maxActionDelayMs: hi } = this.opts;
    const ms = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
    await new Promise((r) => setTimeout(r, ms));
  }

  /** Open pages in the context (the headed window the user reviews/submits in). */
  pages(): Page[] {
    return this.context?.pages() ?? [];
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/** A launch failure caused by a leftover profile-singleton lock (vs. a real, unrecoverable error). */
function isProfileLockError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes("profile") ||
    msg.includes("singletonlock") ||
    msg.includes("processsingleton") ||
    msg.includes("already in use") ||
    msg.includes("appears to be in use")
  );
}

/** A launch failure caused by Chromium not being provisioned yet (fresh packaged install, M8). */
function isMissingBrowserError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return msg.includes("executable doesn't exist") || msg.includes("playwright install");
}

/** Remove Chromium's singleton lock artifacts so a fresh launch can take the profile. Best-effort. */
function clearProfileLocks(userDataDir: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      rmSync(join(userDataDir, name), { force: true });
    } catch {
      // Ignore — if we can't remove it, the retry will surface the original error.
    }
  }
}

/** The base Chromium profile dir (packaged: <userData>/browser-profile; dev: ./browser-profile). */
export function browserProfileDir(): string {
  return defaultUserDataDir();
}

/**
 * Delete the persistent Chromium profile(s) — the stored career-site cookies/logins — for a clean slate
 * (commercial M7 browser-profile wipe). Removes the apply profile AND its discovery-side "-discovery"
 * sibling, and NOTHING else: the delete is scoped strictly to those two resolved paths. Callers MUST
 * stop all browser sessions first (an open Chromium holding the profile can leave a half-deleted, corrupt
 * directory). Best-effort per path; returns the paths actually removed.
 */
export function wipeBrowserProfiles(baseDir: string = defaultUserDataDir()): { removed: string[] } {
  const removed: string[] = [];
  for (const dir of [baseDir, `${baseDir}-discovery`]) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch {
      // best-effort — a still-locked profile will surface on the next launch attempt
    }
  }
  return { removed };
}
