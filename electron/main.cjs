// electron/main.cjs
//
// Thin Electron shell for ApplyPilot. It does NOT run the engine inside Electron's renderer/main
// runtime — it SPAWNS the engine (the local API, which also serves the built dashboard) as a CHILD
// PROCESS. Packaged builds run that child under Electron's own binary with ELECTRON_RUN_AS_NODE=1,
// so there is exactly ONE runtime to provision: better-sqlite3 is rebuilt for Electron's ABI by
// electron-builder (npmRebuild) and loads in the same ABI it was built for. Dev keeps the machine's
// `node` from PATH (dev npm install builds natives for that Node). The window just loads the
// single-origin app at http://127.0.0.1:<port>.
//
// PACKAGED FILE LOCATIONS: a signed, notarized .app is read-only (App Translocation), so the shell
// roots ALL mutable state under app.getPath("userData") (~/Library/Application Support/ApplyPilot)
// and hands the engine explicit paths via env: APPLYPILOT_DB_PATH, APPLYPILOT_ENV_PATH,
// APPLYPILOT_BROWSER_PROFILE_DIR. First packaged launch migrates (copies, never deletes) data from
// the legacy git-clone install at ~/Job-Applications-Project.
//
// EMBEDDED REVIEW PANEL: the shell can show the real employer application page INSIDE the app — a
// WebContentsView the dashboard positions via the preload bridge (window.applyPilotShell). The
// engine attaches to it over a loopback-only CDP endpoint and fills the form where the user can
// watch, then the user takes over the same page (login, verification, and the final Submit click —
// the app never clicks submit). Loopback CDP does expose browser control to local processes; this
// is a local-first single-user app, and APPLYPILOT_DISABLE_EMBEDDED=1 turns the whole feature off
// (the engine then falls back to a visible headed Playwright window).

const { app, BrowserWindow, WebContentsView, ipcMain, shell, safeStorage, session } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const PREFERRED_PORT = Number(process.env.APPLYPILOT_API_PORT) || 5179;
const CDP_PORT = process.env.APPLYPILOT_CDP_PORT || (app.isPackaged ? "0" : "5180");
const EMBEDDED_ENABLED = process.env.APPLYPILOT_DISABLE_EMBEDDED !== "1";
const NODE_BIN = process.env.APPLYPILOT_NODE || "node"; // dev only; packaged uses process.execPath

// Commercial M7 — control-surface hardening. The engine gets a bearer token (APPLYPILOT_AUTH_TOKEN)
// that flips the built-in /api auth seam from allow-all to bearer-required, so the loopback control
// surface is no longer unauthenticated to other local processes while the app sits idle. Precedence,
// resolved at spawn time (resolveAuthToken): a token the user configured — OS env, or the engine's own
// .env, which the SHELL does not auto-load — is respected (the documented Tailscale/phone setup);
// otherwise we mint an ephemeral per-launch token. Ephemeral means nothing at rest to steal and it
// touches no DB/.env — losing it only re-locks the API, never user data. The active token reaches the
// served dashboard via the preload bridge (ipc 'applypilot:auth-token'), gated on us actually owning the
// engine. /api/health stays exempt (access.requiresAuth) so the shell's own liveness probe keeps working.
const EPHEMERAL_AUTH_TOKEN = crypto.randomBytes(32).toString("hex");
let injectedAuthToken = ""; // the token actually injected into the engine we own; handed to the renderer

/** Read a single VALUE from a dotenv-style file (skips comments; strips surrounding quotes). "" if absent. */
function readEnvValue(envPath, name) {
  try {
    if (!envPath || !fs.existsSync(envPath)) return "";
    const text = fs.readFileSync(envPath, "utf8");
    const m = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.*)$`, "m").exec(text);
    if (!m) return "";
    return m[1].trim().replace(/^["']|["']$/g, "").trim();
  } catch {
    return "";
  }
}

/** Resolve the API token: OS env wins, then the engine's .env (which the shell itself never loads), then mint. */
function resolveAuthToken(envPath) {
  return (
    (process.env.APPLYPILOT_AUTH_TOKEN && process.env.APPLYPILOT_AUTH_TOKEN.trim()) ||
    readEnvValue(envPath, "APPLYPILOT_AUTH_TOKEN") ||
    EPHEMERAL_AUTH_TOKEN
  );
}

// Chosen at boot: PREFERRED_PORT when free (or already serving a healthy engine), else ephemeral.
let apiPort = PREFERRED_PORT;

// Must be set before app.whenReady — this is what the engine's EmbeddedBrowserSession attaches to.
// Packaged default is port 0: Chromium picks a free port and writes it to the DevToolsActivePort
// file under userData, which we read back before spawning the engine (no fixed-port collisions).
if (EMBEDDED_ENABLED) {
  app.commandLine.appendSwitch("remote-debugging-port", CDP_PORT);
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

let engine = null;
let win = null;
let engineOwned = false;
let engineStarting = false; // in-flight guard: boot() can re-enter via the 'activate' event
let engineDied = false; // set by the child's exit handler; cleared on each spawn
let engineCdpEndpoint = null; // set when the engine child was given a live CDP endpoint
let reviewView = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function stopEngine() {
  if (!engine) return;
  try {
    engine.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  engine = null;
  engineOwned = false;
}

function pingEngine(cb) {
  // once-guard: req.destroy() in the timeout path also fires 'error' — cb must run exactly once,
  // the async spawn chain built on top of this would otherwise double-spawn.
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    cb(ok);
  };
  const req = http.get(`http://127.0.0.1:${apiPort}/api/health`, (res) => {
    res.resume();
    finish(res.statusCode === 200);
  });
  req.on("error", () => finish(false));
  req.setTimeout(1500, () => {
    req.destroy();
    finish(false);
  });
}

/** True when nothing is listening on the port (loopback). */
function portFree(port, cb) {
  const probe = net
    .createServer()
    .once("error", () => cb(false))
    .once("listening", () => probe.close(() => cb(true)));
  probe.listen(port, "127.0.0.1");
}

/** Ask the OS for an ephemeral free port. Falls back to the preferred port on probe failure. */
function ephemeralPort(cb) {
  const probe = net.createServer();
  probe.once("error", () => cb(PREFERRED_PORT));
  probe.once("listening", () => {
    const port = probe.address().port;
    probe.close(() => cb(port));
  });
  probe.listen(0, "127.0.0.1");
}

/**
 * Decide which port the engine should serve on. Prefer the well-known dev port; if something else
 * owns it (another app, a stale engine we can reuse via pingEngine later), fall back to an
 * ephemeral port instead of killing whatever is listening.
 */
function chooseApiPort(cb) {
  apiPort = PREFERRED_PORT;
  pingEngine((alive) => {
    if (alive) return cb(); // healthy ApplyPilot engine already there — reuse it
    portFree(PREFERRED_PORT, (free) => {
      if (free) return cb();
      ephemeralPort((port) => {
        apiPort = port;
        console.log(`[applypilot] port ${PREFERRED_PORT} is busy — using ${apiPort}`);
        cb();
      });
    });
  });
}

/** electron-builder packs the app into app.asar; the engine child needs the unpacked real files. */
function unpackedPath(...segments) {
  const base = app.getAppPath();
  const real = base.includes("app.asar") ? base.replace("app.asar", "app.asar.unpacked") : base;
  return path.join(real, ...segments);
}

const { packagedDataEnv, migrateLegacyData } = require("./data-paths.cjs");
const { sealAndReadDbKey } = require("./key-store.cjs");
const { setupAutoUpdater } = require("./updater.cjs");

/**
 * With --remote-debugging-port=0, Chromium picks a free CDP port and writes
 * "<port>\n<path>" to the DevToolsActivePort file in userData shortly after startup.
 * A previous run's file would hand the engine a dead endpoint, so it is unlinked at
 * startup (below) and only a fresh write from THIS run is ever read.
 */
try {
  fs.rmSync(path.join(app.getPath("userData"), "DevToolsActivePort"), { force: true });
} catch {
  /* first run: userData may not exist yet */
}

function readCdpEndpoint(cb, tries = 20) {
  if (!EMBEDDED_ENABLED) return cb(null);
  if (CDP_PORT !== "0") return cb(`http://127.0.0.1:${CDP_PORT}`);
  const file = path.join(app.getPath("userData"), "DevToolsActivePort");
  fs.readFile(file, "utf8", (err, text) => {
    const port = err ? NaN : Number(String(text).split("\n")[0]);
    if (Number.isFinite(port) && port > 0) return cb(`http://127.0.0.1:${port}`);
    if (tries <= 0) {
      console.error("[applypilot] CDP port never appeared — embedded review panel disabled for this run");
      return cb(null);
    }
    setTimeout(() => readCdpEndpoint(cb, tries - 1), 250);
  });
}

function spawnEngine(cdpEndpoint) {
  const packaged = app.isPackaged;
  const env = {
    ...process.env,
    APPLYPILOT_API_PORT: String(apiPort),
    // Tells the engine it can fill inside the app's review panel (EmbeddedBrowserSession).
    ...(cdpEndpoint ? { APPLYPILOT_EMBEDDED_CDP: cdpEndpoint } : {}),
  };

  if (packaged) {
    // ONE runtime: the engine runs under Electron's own binary in Node mode, so native modules
    // rebuilt for Electron's ABI (npmRebuild) load correctly, and customers need no Node install.
    const dataEnv = packagedDataEnv(app.getPath("userData"));
    migrateLegacyData(dataEnv, path.join(os.homedir(), "Job-Applications-Project"));
    // Resolve the bearer token AFTER migration so a legacy .env copied into place is seen. A token the
    // user put in <userData>/.env is respected; otherwise an ephemeral one is minted (commercial M7).
    injectedAuthToken = resolveAuthToken(dataEnv.APPLYPILOT_ENV_PATH);
    // Encryption at rest (commercial M7): seal/read the data-encryption key from the OS keychain and
    // inject it as APPLYPILOT_ENCRYPTION_KEY. MUST run AFTER migrateLegacyData so a copied-in legacy
    // DB/.env is seen — the key is minted only on a provably-fresh datastore (never over existing data).
    const dbKey = sealAndReadDbKey(safeStorage, app.getPath("userData"), {
      dbPath: dataEnv.APPLYPILOT_DB_PATH,
      envPath: dataEnv.APPLYPILOT_ENV_PATH,
    });
    engine = spawn(process.execPath, [unpackedPath("app-build", "engine.cjs")], {
      cwd: app.getPath("userData"), // never the read-only bundle
      env: {
        ...env,
        ...dataEnv,
        ELECTRON_RUN_AS_NODE: "1",
        APPLYPILOT_AUTH_TOKEN: injectedAuthToken,
        APPLYPILOT_WEB_ROOT: unpackedPath("dashboard", "dist"),
        // Chromium is downloaded on first run into userData (commercial M8) — never bundled in the DMG.
        // Point Playwright's cache here so the download, presence check, and launch all agree. Respect an
        // explicit override (e.g. a power user pointing at a shared cache).
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH
          ? {}
          : { PLAYWRIGHT_BROWSERS_PATH: path.join(app.getPath("userData"), "browsers") }),
        // Keychain-sealed DEK wins over any .env value (injected env takes precedence over loadEnvFile).
        // null → leave the engine's own .env key handling (or plaintext) untouched.
        ...(dbKey ? { APPLYPILOT_ENCRYPTION_KEY: dbKey } : {}),
      },
      stdio: "inherit",
    });
  } else {
    injectedAuthToken = resolveAuthToken(path.join(ROOT, ".env"));
    engine = spawn(NODE_BIN, ["--import", "tsx", path.join("src", "cli", "dashboard-api.ts")], {
      cwd: ROOT,
      env: { ...env, APPLYPILOT_AUTH_TOKEN: injectedAuthToken, APPLYPILOT_WEB_ROOT: path.join(ROOT, "dashboard", "dist") },
      stdio: "inherit",
    });
  }
  engineOwned = true;
  engineDied = false;
  engine.on("error", (e) => {
    engineDied = true;
    console.error("[applypilot] engine spawn error:", e);
  });
  engine.on("exit", (code) => {
    engine = null;
    engineOwned = false;
    engineDied = true;
    if (code) console.error("[applypilot] engine exited:", code);
  });
}

function ensureEngine(cb) {
  if (engineStarting) return waitForEngine(cb);
  engineStarting = true;
  const done = (err) => {
    engineStarting = false;
    cb(err);
  };
  chooseApiPort(() => {
    pingEngine((alive) => {
      if (alive) {
        // Reused engine: with a fixed CDP port (dev) its endpoint is ours too; with the packaged
        // per-run port (0) its endpoint belongs to a previous Chromium — treat as no-CDP.
        engineCdpEndpoint = EMBEDDED_ENABLED && CDP_PORT !== "0" ? `http://127.0.0.1:${CDP_PORT}` : null;
        return done();
      }
      if (engineOwned && engine) return waitForEngine(done);
      readCdpEndpoint((cdpEndpoint) => {
        engineCdpEndpoint = cdpEndpoint;
        spawnEngine(cdpEndpoint);
        waitForEngine(done);
      });
    });
  });
}

function waitForEngine(cb, tries = 80) {
  pingEngine((alive) => {
    if (alive) return cb();
    // Fail fast when the child we spawned already exited — polling out the remaining budget
    // would just open a window against a dead (or foreign) port.
    if (engineDied) {
      return cb(new Error(`engine exited before becoming ready on port ${apiPort}. Quit and reopen ApplyPilot.`));
    }
    if (tries <= 0) {
      return cb(new Error(`engine did not become ready on port ${apiPort}. Quit and reopen ApplyPilot.`));
    }
    setTimeout(() => waitForEngine(cb, tries - 1), 250);
  });
}

// ---- Embedded review panel -----------------------------------------------------------------
// The dashboard (via preload) opens/positions/closes a WebContentsView that shows the REAL employer
// application page inside the app window. A persistent partition keeps career-site logins across
// sessions. The engine finds this view over CDP by its /review-panel URL and fills the form there.

function clampBounds(b) {
  if (!b || typeof b !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) };
}

function openReviewPanel(bounds) {
  // No live CDP endpoint means the engine can't fill inside the panel — refuse to open it, or an
  // empty view would float over the dashboard while the engine uses a headed window instead.
  if (!win || !EMBEDDED_ENABLED || !engineCdpEndpoint) return false;
  if (!reviewView) {
    reviewView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:applypilot-review",
      },
    });
    reviewView.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
    win.contentView.addChildView(reviewView);
    reviewView.webContents.loadURL(`http://127.0.0.1:${apiPort}/review-panel`);
  }
  setReviewPanelBounds(bounds);
  return true;
}

function setReviewPanelBounds(bounds) {
  const b = clampBounds(bounds);
  if (reviewView && b) reviewView.setBounds(b);
}

function closeReviewPanel() {
  if (!reviewView) return;
  try {
    if (win) win.contentView.removeChildView(reviewView);
    reviewView.webContents.close();
  } catch {
    /* window already tearing down */
  }
  reviewView = null;
}

ipcMain.handle("review-panel:open", (_event, bounds) => openReviewPanel(bounds));
ipcMain.on("review-panel:set-bounds", (_event, bounds) => setReviewPanelBounds(bounds));
ipcMain.handle("review-panel:close", () => {
  closeReviewPanel();
  return true;
});

// Hand the loopback API bearer token to the served dashboard so it auto-authenticates inside the
// desktop app (commercial M7). Synchronous so it is available before the SPA's first fetch. Gated on
// engineOwned: we only vouch for the token when we spawned the engine we injected it into — if this
// launch reused a foreign/pre-existing engine (whose token we don't know), we hand back "" so the
// dashboard falls back to a manually-entered token rather than sending a mismatched one.
ipcMain.on("applypilot:auth-token", (event) => {
  event.returnValue = engineOwned ? injectedAuthToken : "";
});

// Clear the embedded review panel's persistent partition — the WebContentsView career-site cookies/logins
// (commercial M7 "forget site logins"). The engine (a child process) has NO access to Electron's session
// API, so the browser-profile wipe there cannot reach this store; only the shell can. Close the panel
// first so nothing re-persists into a partition being cleared.
ipcMain.handle("applypilot:wipe-review-logins", async () => {
  try {
    closeReviewPanel();
    await session.fromPartition("persist:applypilot-review").clearStorageData();
    return true;
  } catch (e) {
    console.error("[applypilot] review-panel login wipe failed:", e);
    return false;
  }
});

// Restart the engine child on demand (commercial M9 — the "Restart engine" self-healing button). The
// shell owns the process, so a stuck/exited engine is one click away from recovery instead of a
// developer instruction. Stop the child, re-run ensureEngine (fresh spawn, re-injected token — the
// ephemeral token is stable across the app's lifetime, so the renderer's cached token stays valid),
// then reload the window at the (re-chosen) port so the SPA reconnects. Resolves true on success.
ipcMain.handle("applypilot:restart-engine", async () => {
  return await new Promise((resolve) => {
    const spawnFresh = () => {
      engineStarting = false; // no legitimate in-flight boot exists at restart time; force a fresh spawn
      ensureEngine((err) => {
        if (err) {
          console.error("[applypilot] engine restart failed:", err.message);
          resolve(false);
          return;
        }
        // A fresh spawn set engineOwned=true and re-injected the (stable) token, so the reloaded SPA
        // re-authenticates. Reload at the re-chosen port so the renderer reconnects.
        if (win) {
          try {
            win.loadURL(`http://127.0.0.1:${apiPort}/`);
          } catch (e) {
            console.error("[applypilot] window reload after restart failed:", e);
          }
        }
        resolve(true);
      });
    };
    const dying = engine;
    if (!dying) {
      spawnFresh();
      return;
    }
    // SIGTERM is ASYNC. If we ensureEngine() immediately, its health probe still reaches the dying
    // child's open loopback port, sees 200, and takes the "reuse a healthy engine" branch — so nothing
    // respawns, engineOwned stays false, and the reloaded dashboard gets an empty token → 401 lockout.
    // Wait for the old child to actually EXIT (SIGKILL fallback) before spawning the replacement.
    let settled = false;
    const onGone = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      spawnFresh();
    };
    const killTimer = setTimeout(() => {
      try {
        dying.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      onGone();
    }, 4000);
    dying.once("exit", onGone);
    stopEngine();
  });
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 640,
    title: "ApplyPilot",
    backgroundColor: "#fbf7f0",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  win.loadURL(`http://127.0.0.1:${apiPort}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    closeReviewPanel();
    win = null;
  });
}

function boot() {
  ensureEngine((err) => {
    if (err) console.error("[applypilot]", err.message);
    createWindow();
  });
}

if (gotLock) {
  app.whenReady().then(() => {
    boot();
    // Self-update the packaged app from the release feed (no-op in dev). Idempotent; prompts before
    // restarting and quits through the normal before-quit -> stopEngine path (commercial M8).
    setupAutoUpdater({ app });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
    });
  });

  // Always quit when the window closes — otherwise the API child keeps port 5179 and the next
  // `npm run app` fails with "address already in use" (especially common on macOS).
  app.on("window-all-closed", () => {
    stopEngine();
    app.quit();
  });

  app.on("before-quit", () => {
    stopEngine();
  });
}
