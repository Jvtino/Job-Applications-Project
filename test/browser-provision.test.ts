// First-run Chromium provisioning (commercial M8). The actual download (~150 MB) is validated on a real
// machine; here we pin the status shape and the safety invariant that matters in CI: installChromium()
// is a no-op when a browser is already present, so tests never kick off a redundant download.

import { describe, it, expect } from "vitest";
import {
  browserStatus,
  isChromiumInstalled,
  chromiumExecutablePath,
  installChromium,
} from "../src/ats/browser-provision";

describe("browser provisioning (M8)", () => {
  it("reports a coherent status shape", () => {
    const s = browserStatus();
    expect(typeof s.present).toBe("boolean");
    expect(typeof s.installing).toBe("boolean");
    expect(s.browsersPath === null || typeof s.browsersPath === "string").toBe(true);
    expect(s.present).toBe(isChromiumInstalled());
  });

  it("resolves the Chromium executable path Playwright expects (may or may not exist yet)", () => {
    const p = chromiumExecutablePath();
    expect(p === null || typeof p === "string").toBe(true);
  });

  it("installChromium is a no-op when Chromium is already present (never re-downloads)", () => {
    if (!isChromiumInstalled()) return; // no browser in this env — don't trigger a real download
    expect(installChromium()).toEqual({ started: false });
    expect(browserStatus().installing).toBe(false);
  });
});
