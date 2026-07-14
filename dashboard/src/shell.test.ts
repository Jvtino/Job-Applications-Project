// Dashboard ↔ desktop-shell bridge (commercial M10). These helpers gate self-healing (Restart engine),
// the "forget site logins" wipe, and auto-auth — all of which must degrade cleanly to false in
// plain-browser dev (no shell) and never throw.
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  applyPilotShell,
  hasDesktopShell,
  hasEmbeddedReviewPanel,
  shellAuthToken,
  restartEngine,
  wipeReviewPanelLogins,
} from "./shell";

type MutableWindow = typeof window & { applyPilotShell?: unknown };

afterEach(() => {
  (window as MutableWindow).applyPilotShell = undefined;
});

describe("no desktop shell (plain-browser dev)", () => {
  it("reports absent and returns safe defaults", async () => {
    expect(applyPilotShell()).toBeUndefined();
    expect(hasDesktopShell()).toBe(false);
    expect(hasEmbeddedReviewPanel()).toBe(false);
    expect(shellAuthToken()).toBe("");
    expect(await restartEngine()).toBe(false);
    expect(await wipeReviewPanelLogins()).toBe(false);
  });
});

describe("inside the desktop shell", () => {
  it("reads the injected auth token, trimmed", () => {
    (window as MutableWindow).applyPilotShell = { authToken: "  tok  ", reviewPanel: {} };
    expect(hasDesktopShell()).toBe(true);
    expect(shellAuthToken()).toBe("tok");
  });

  it("delegates restartEngine + wipeReviewPanelLogins to the bridge", async () => {
    const restart = vi.fn().mockResolvedValue(true);
    const wipe = vi.fn().mockResolvedValue(true);
    (window as MutableWindow).applyPilotShell = { restartEngine: restart, wipeReviewLogins: wipe, reviewPanel: {} };
    expect(await restartEngine()).toBe(true);
    expect(restart).toHaveBeenCalledOnce();
    expect(await wipeReviewPanelLogins()).toBe(true);
    expect(wipe).toHaveBeenCalledOnce();
  });

  it("swallows a throwing bridge method rather than crashing the UI", async () => {
    (window as MutableWindow).applyPilotShell = {
      restartEngine: () => {
        throw new Error("boom");
      },
      reviewPanel: {},
    };
    expect(await restartEngine()).toBe(false);
  });
});
