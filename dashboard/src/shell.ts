// dashboard/src/shell.ts
//
// Typed access to the desktop shell's preload bridge (electron/preload.cjs). Present only inside
// the ApplyPilot desktop app; absent in plain-browser dev mode. The bridge exposes exactly one
// capability: the embedded review panel — the shell-owned browser view that shows the REAL employer
// application page inside the app, in a rectangle the dashboard reserves and keeps in sync.

export interface ReviewPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ApplyPilotShell {
  /** Loopback /api bearer token injected into the engine, so the desktop app auto-authenticates
   *  (commercial M7). Empty/absent in plain-browser dev or when the shell doesn't own the engine. */
  authToken?: string;
  /** Clear the embedded review panel's persistent career-site logins (commercial M7). */
  wipeReviewLogins?(): Promise<boolean>;
  /** Restart the local engine and reload the app (commercial M9 self-healing). */
  restartEngine?(): Promise<boolean>;
  reviewPanel: {
    open(bounds: ReviewPanelBounds): Promise<boolean>;
    setBounds(bounds: ReviewPanelBounds): void;
    close(): Promise<boolean>;
  };
}

export function applyPilotShell(): ApplyPilotShell | undefined {
  return (window as { applyPilotShell?: ApplyPilotShell }).applyPilotShell;
}

/** The desktop shell's injected API token, if running inside the app. Empty string otherwise. */
export function shellAuthToken(): string {
  const t = applyPilotShell()?.authToken;
  return typeof t === "string" ? t.trim() : "";
}

/**
 * Ask the shell to clear the embedded review panel's stored career-site logins (commercial M7). Returns
 * false in plain-browser dev (no shell) or if the bridge method is absent — the engine's own profile
 * wipe is separate. The engine cannot reach this Electron session partition, so this is the only way.
 */
export async function wipeReviewPanelLogins(): Promise<boolean> {
  try {
    const fn = applyPilotShell()?.wipeReviewLogins;
    return fn ? await fn() : false;
  } catch {
    return false;
  }
}

/** True inside the desktop app, where the fill can happen in the embedded review panel. */
export function hasEmbeddedReviewPanel(): boolean {
  return Boolean(applyPilotShell());
}

/** True inside the desktop shell (vs. plain-browser dev), where the engine can be restarted in-app. */
export function hasDesktopShell(): boolean {
  return Boolean(applyPilotShell());
}

/**
 * Ask the desktop shell to restart the local engine and reload the app (commercial M9 self-healing).
 * Returns false in plain-browser dev (no shell) or if the bridge method is absent — the caller should
 * fall back to a plain reload/retry. The shell reloads the window itself on success.
 */
export async function restartEngine(): Promise<boolean> {
  try {
    const fn = applyPilotShell()?.restartEngine;
    return fn ? await fn() : false;
  } catch {
    return false;
  }
}

/** The window-coordinate rectangle of an element, for mirroring to the shell panel. */
export function boundsOf(el: HTMLElement): ReviewPanelBounds {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export async function openReviewPanelAt(bounds: ReviewPanelBounds): Promise<boolean> {
  const shell = applyPilotShell();
  if (!shell) return false;
  try {
    return await shell.reviewPanel.open(bounds);
  } catch {
    return false;
  }
}

export function openReviewPanel(el: HTMLElement): Promise<boolean> {
  return openReviewPanelAt(boundsOf(el));
}

export function syncReviewPanelBounds(el: HTMLElement): void {
  applyPilotShell()?.reviewPanel.setBounds(boundsOf(el));
}

export async function closeReviewPanel(): Promise<void> {
  try {
    await applyPilotShell()?.reviewPanel.close();
  } catch {
    // The shell tears the panel down with the window anyway.
  }
}
