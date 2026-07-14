// electron/preload.cjs
//
// The ONLY bridge between the dashboard and the desktop shell. Exposes just the review-panel
// controls: the dashboard reserves a rectangle in its layout and mirrors that rectangle here so the
// shell can show the real employer application page (a WebContentsView) in that spot. Nothing else
// from Node/Electron is exposed. When this bridge is absent (plain-browser dev mode), the dashboard
// falls back to the engine's visible headed browser window.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("applyPilotShell", {
  // Loopback /api bearer token, resolved synchronously so it is present before the SPA's first fetch
  // (commercial M7). Empty string when the shell doesn't own the engine — the dashboard then falls back
  // to a manually-entered token. Read once at preload time; the token is stable for the app's lifetime.
  authToken: (() => {
    try {
      return ipcRenderer.sendSync("applypilot:auth-token") || "";
    } catch {
      return "";
    }
  })(),
  /** Clear the embedded review panel's persistent career-site logins (commercial M7 "forget site logins").
   *  Resolves true when the partition was cleared. Only the shell can reach this store; the engine cannot. */
  wipeReviewLogins: () => ipcRenderer.invoke("applypilot:wipe-review-logins"),
  /** Restart the local engine and reload the app (commercial M9 self-healing). Resolves true on success. */
  restartEngine: () => ipcRenderer.invoke("applypilot:restart-engine"),
  reviewPanel: {
    /** Open (or re-show) the embedded panel at these window coordinates. Resolves false if disabled. */
    open: (bounds) => ipcRenderer.invoke("review-panel:open", bounds),
    /** Keep the panel glued to the dashboard's reserved rectangle (resize/scroll/layout changes). */
    setBounds: (bounds) => ipcRenderer.send("review-panel:set-bounds", bounds),
    /** Remove the panel (the apply session ended or was cancelled). */
    close: () => ipcRenderer.invoke("review-panel:close"),
  },
});
