// src/ats/embedded-browser.ts
//
// The IN-APP review panel session. The Electron shell shows the real employer page inside the
// desktop app (a WebContentsView pointed at /review-panel) and exposes its Chromium over a local
// CDP endpoint; this session attaches to that page with Playwright and fills it there — so the user
// literally watches the form being filled inside the app, then takes over the same page to fix
// fields, log in, pass human checks, and click the employer's Submit button THEMSELVES.
//
// Same hard rules as BrowserSession: human pacing, per-host/daily caps, no stealth, no evasion.
// The app never clicks submit. If the panel (or the CDP endpoint) isn't available, callers fall
// back to a visible headed window (BrowserSession) — never a hidden one.

import { chromium, type Browser, type Page } from "playwright";
import { makePageContext, type PlaywrightPageContext } from "./page-context";
import { RateLimiter, type EngineBrowserSession } from "./browser";

/** Pathname the Electron shell loads into the review panel; how we find its page over CDP. */
export const REVIEW_PANEL_PATH = "/review-panel";

/** The desktop shell's CDP endpoint (set by electron/main.cjs when it spawns the engine). */
export function embeddedCdpEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = (env.APPLYPILOT_EMBEDDED_CDP ?? "").trim();
  return value || undefined;
}

export interface EmbeddedBrowserOptions {
  /** CDP endpoint of the desktop shell. Defaults to APPLYPILOT_EMBEDDED_CDP. */
  cdpEndpoint?: string;
  /** Pathname of the panel's placeholder page. */
  markerPath?: string;
  /** How long to wait for the shell to open the panel before giving up. */
  connectTimeoutMs?: number;
  perHostHourlyCap?: number;
  dailyCap?: number;
  minActionDelayMs?: number;
  maxActionDelayMs?: number;
}

const DEFAULTS = {
  markerPath: REVIEW_PANEL_PATH,
  connectTimeoutMs: 15_000,
  perHostHourlyCap: 20,
  dailyCap: 60,
  minActionDelayMs: 800,
  maxActionDelayMs: 2500,
};

export class EmbeddedBrowserSession implements EngineBrowserSession {
  private browser?: Browser;
  private page?: Page;
  private readonly opts: Required<Omit<EmbeddedBrowserOptions, "cdpEndpoint">> & { cdpEndpoint?: string };
  private readonly limiter: RateLimiter;

  constructor(options: EmbeddedBrowserOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.limiter = new RateLimiter(this.opts.perHostHourlyCap, this.opts.dailyCap);
  }

  /** Attach to the desktop shell over CDP and find the open review panel's page. */
  async start(): Promise<void> {
    const endpoint = this.opts.cdpEndpoint ?? embeddedCdpEndpoint();
    if (!endpoint) {
      throw new Error("The desktop app's review panel isn't available (no CDP endpoint configured).");
    }
    const deadline = Date.now() + this.opts.connectTimeoutMs;
    this.browser = await chromium.connectOverCDP(endpoint, { timeout: this.opts.connectTimeoutMs });
    try {
      // The dashboard asks the shell to open the panel right before it starts the apply, so the
      // page may appear a beat after we connect — poll until the deadline.
      while (!this.page && Date.now() < deadline) {
        this.page = this.findPanelPage();
        if (!this.page) await sleep(250);
      }
      if (!this.page) {
        throw new Error("The in-app review panel isn't open. Open the apply from the desktop app, or retry.");
      }
      // Same esbuild keepNames shim BrowserSession installs (see browser.ts) — applies from the
      // next navigation, and open() always navigates before any page script runs.
      await this.page.addInitScript({
        content: "globalThis.__name = globalThis.__name || function (f) { return f; };",
      });
    } catch (err) {
      await this.browser.close().catch(() => {});
      this.browser = undefined;
      this.page = undefined;
      throw err;
    }
  }

  /** Navigate the panel's page to the URL, enforcing the per-host/daily caps and a human delay. */
  async open(url: string): Promise<PlaywrightPageContext> {
    if (!this.page) throw new Error("EmbeddedBrowserSession not started.");
    this.limiter.record(safeHost(url));
    await this.pace();
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    return makePageContext(this.page);
  }

  /** Randomized multi-second pause to pace actions like a human. */
  async pace(): Promise<void> {
    const { minActionDelayMs: lo, maxActionDelayMs: hi } = this.opts;
    await sleep(lo + Math.floor(Math.random() * Math.max(1, hi - lo)));
  }

  pages(): Page[] {
    return this.page ? [this.page] : [];
  }

  /**
   * Disconnect from the shell. The panel and whatever page is loaded in it stay visible — the shell
   * (dashboard) owns the panel's lifecycle, so the user never loses the page they're working in.
   */
  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    this.page = undefined;
  }

  private findPanelPage(): Page | undefined {
    for (const context of this.browser?.contexts() ?? []) {
      for (const page of context.pages()) {
        try {
          if (new URL(page.url()).pathname === this.opts.markerPath) return page;
        } catch {
          // Non-URL targets (about:blank variants, devtools) — not the panel.
        }
      }
    }
    return undefined;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
