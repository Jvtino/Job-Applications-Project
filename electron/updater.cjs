// electron/updater.cjs
//
// Self-update for the PACKAGED app (commercial M8) via electron-updater against the generic release
// feed baked in from package.json `build.publish` (owner hosts latest-mac.yml + the zip/dmg + blockmaps).
// Dev/unpackaged builds have no app-update.yml, so this is a deliberate no-op unless app.isPackaged —
// the git-clone dev flow keeps its own git-pull update path (scripts/launch-app.mjs), which never runs
// in a customer install (it ships no scripts/ or src/, and self-guards via assertDevCheckout).
//
// Squirrel.Mac REFUSES to install an update into an unsigned/ad-hoc-signed app, so a real self-update
// round-trip depends on the owner's Developer ID signing (M8 blocked-on-human) — this wiring is the
// app-side half.
//
// The relaunch is USER-CONSENTED, not silent: on 'update-downloaded' we prompt (Restart now / Later)
// rather than force-quitting under a half-finished employer application or a running search. Crucially
// we DO NOT pre-kill the engine before quitAndInstall — electron-updater fires 'update-downloaded'
// BEFORE it validates/installs the update (native signature check happens inside quitAndInstall), so a
// refused install (e.g. the still-unsigned build) or any transient staging failure would otherwise
// leave a live window pointed at a dead engine with no respawn path. Instead we let quitAndInstall run
// the normal app quit, and the existing before-quit -> stopEngine (electron/main.cjs) releases the
// engine's ports + SQLite/browser-profile handles as part of that real quit.

let started = false;

/**
 * @param {{ app: import('electron').App, log?: Console }} deps
 */
function setupAutoUpdater({ app, log = console }) {
  if (started) return;
  if (!app.isPackaged) {
    log.log?.("[applypilot] auto-update disabled (dev / unpackaged build).");
    return;
  }
  started = true;

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    log.error?.("[applypilot] electron-updater unavailable — auto-update disabled:", e);
    return;
  }

  autoUpdater.autoDownload = true;
  // Off by default so nothing installs behind the user's back; the "Later" choice below turns it on so
  // a consented update lands cleanly on the next normal quit (before-quit stops the engine first).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("error", (err) => log.error?.("[applypilot] auto-update error:", (err && err.message) || err));
  autoUpdater.on("update-available", (info) => log.log?.(`[applypilot] update available: ${info && info.version}`));
  autoUpdater.on("update-not-available", () => log.log?.("[applypilot] app is up to date."));
  autoUpdater.on("update-downloaded", async (info) => {
    const version = (info && info.version) || "";
    log.log?.(`[applypilot] update ${version} downloaded — prompting to restart.`);
    try {
      const { dialog } = require("electron");
      const { response } = await dialog.showMessageBox({
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: "Update ready",
        message: `ApplyPilot ${version} is ready to install.`,
        detail:
          "Restart to finish updating. Any in-progress application or job search will stop. " +
          "Choose Later to update the next time you quit ApplyPilot.",
      });
      if (response === 0) {
        // quitAndInstall runs the normal app quit -> before-quit -> stopEngine releases ports/handles.
        // No pre-kill here, so a refused/failed install never strands a live window on a dead engine.
        autoUpdater.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
      } else {
        autoUpdater.autoInstallOnAppQuit = true;
      }
    } catch (e) {
      log.error?.("[applypilot] update prompt failed:", (e && e.message) || e);
    }
  });

  autoUpdater
    .checkForUpdatesAndNotify()
    .catch((e) => log.error?.("[applypilot] update check failed:", (e && e.message) || e));
}

module.exports = { setupAutoUpdater };
