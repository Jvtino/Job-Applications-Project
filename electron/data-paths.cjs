// electron/data-paths.cjs
//
// Where the PACKAGED app keeps mutable state, and the one-time copy-only migration from the
// legacy git-clone install. Kept free of Electron imports so the engine test suite can exercise
// the exact code the shell runs (main.cjs passes app.getPath("userData") / os.homedir()).

const path = require("node:path");
const fs = require("node:fs");

/** Env block handed to the engine child: every mutable path rooted under the user-data dir. */
function packagedDataEnv(dataRoot) {
  const dataDir = path.join(dataRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    APPLYPILOT_DB_PATH: path.join(dataDir, "applypilot.sqlite"),
    APPLYPILOT_ENV_PATH: path.join(dataRoot, ".env"),
    APPLYPILOT_BROWSER_PROFILE_DIR: path.join(dataRoot, "browser-profile"),
  };
}

/** Marker written only after a migration decision is final — the DB itself is a poor sentinel
 *  because an interrupted copy would leave it present with everything else missing. */
function markerPath(dataEnv) {
  return path.join(path.dirname(dataEnv.APPLYPILOT_DB_PATH), ".migration-complete");
}

/**
 * One-time, copy-only migration from a legacy git-clone install. Copy-only and idempotent:
 * force:false everywhere means existing destination files are never overwritten and originals are
 * never touched, so an interrupted run simply resumes on the next launch (the completion marker is
 * written last). An install that already has its own database and no legacy dir is sealed with the
 * marker so a repo cloned later is never merged into live data. Returns true when anything was copied.
 */
function migrateLegacyData(dataEnv, legacyRoot, log = console) {
  const marker = markerPath(dataEnv);
  try {
    if (fs.existsSync(marker)) return false;
    const legacyDb = path.join(legacyRoot, "data", "applypilot.sqlite");
    if (!fs.existsSync(legacyDb)) {
      // No legacy install. If this app already built its own DB, seal it: a dev checkout that
      // appears later must not be merged into an established workspace.
      if (fs.existsSync(dataEnv.APPLYPILOT_DB_PATH)) fs.writeFileSync(marker, new Date().toISOString());
      return false;
    }
    log.log?.(`[applypilot] first launch — copying data from ${legacyRoot} (originals kept)`);
    fs.cpSync(path.join(legacyRoot, "data"), path.dirname(dataEnv.APPLYPILOT_DB_PATH), {
      recursive: true,
      errorOnExist: false,
      force: false,
    });
    const legacyEnv = path.join(legacyRoot, ".env");
    if (fs.existsSync(legacyEnv) && !fs.existsSync(dataEnv.APPLYPILOT_ENV_PATH)) {
      fs.copyFileSync(legacyEnv, dataEnv.APPLYPILOT_ENV_PATH);
      fs.chmodSync(dataEnv.APPLYPILOT_ENV_PATH, 0o600);
    }
    // Two Chromium profiles: apply sessions and the discovery-side "-discovery" sibling.
    // force:false merge (not an exists-guard) so a torn partial copy heals on the next run.
    for (const suffix of ["", "-discovery"]) {
      const legacyProfile = path.join(legacyRoot, `browser-profile${suffix}`);
      if (fs.existsSync(legacyProfile)) {
        fs.cpSync(legacyProfile, `${dataEnv.APPLYPILOT_BROWSER_PROFILE_DIR}${suffix}`, {
          recursive: true,
          errorOnExist: false,
          force: false,
        });
      }
    }
    fs.writeFileSync(marker, new Date().toISOString());
    return true;
  } catch (err) {
    // Best-effort: no marker is written, so the copy-only merge resumes on the next launch.
    log.error?.("[applypilot] legacy data migration incomplete (will retry next launch):", err);
    return false;
  }
}

module.exports = { packagedDataEnv, migrateLegacyData, markerPath };
