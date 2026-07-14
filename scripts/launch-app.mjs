#!/usr/bin/env node
// scripts/launch-app.mjs
//
// Desktop entrypoint: pull latest main when safely possible, install/build only
// when something actually changed, then open Electron detached from the
// terminal. Wired into `npm run app` so every launcher (Desktop .app, .command,
// CLI) shares this one update/launch flow.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertDevCheckout } from "./dev-guard.mjs";

const ROOT = process.cwd();
assertDevCheckout(ROOT);
const MIN_NODE = 22;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE) {
  console.error(`✗ Node ${MIN_NODE}+ required (you have ${process.versions.node}).`);
  console.error("  Install Node 22+ from https://nodejs.org or:  brew install node@22");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? ROOT, shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function isWorkingTreeDirty() {
  const status = git(["status", "--porcelain"]);
  return status.status === 0 && status.stdout.trim().length > 0;
}

function tryAutoUpdate() {
  if (!existsSync(join(ROOT, ".git"))) return;

  // Only auto-update a main checkout — pulling origin/main into a feature
  // branch would merge main into it as a side effect of launching the app.
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.status !== 0 || branch.stdout.trim() !== "main") return;

  spawnSync("git", ["fetch", "origin", "main"], { cwd: ROOT, stdio: "ignore" });
  const local = git(["rev-parse", "HEAD"]);
  const remote = git(["rev-parse", "origin/main"]);
  if (local.status !== 0 || remote.status !== 0) return;
  if (local.stdout.trim() === remote.stdout.trim()) return;

  // Never auto-pull over uncommitted local changes — a `git pull` would fail or
  // clobber the user's work-in-progress. Launch the current copy and let them
  // resolve it deliberately.
  if (isWorkingTreeDirty()) {
    console.warn(
      "\n⚠ ApplyPilot — a newer version is on GitHub, but files in this folder were changed locally.\n" +
        "  Skipping auto-update to protect those changes. Commit, stash, or delete the stray files,\n" +
        "  then relaunch to update.\n"
    );
    return;
  }

  console.log("\nApplyPilot — new version on GitHub, updating…\n");
  // Fast-forward when simply behind. If main has DIVERGED from origin/main (a stray local commit, or
  // an old non-ff pull that left a merge commit), a plain `git pull` errors ("Need to specify how to
  // reconcile divergent branches") and strands the user on old code. The working tree is confirmed
  // clean above and a consumer checkout only tracks main, so realign to origin/main instead — saving
  // the prior commit to a backup ref first so nothing is truly lost.
  const ff = spawnSync("git", ["merge", "--ff-only", "origin/main"], { cwd: ROOT, stdio: "inherit" });
  if (ff.status !== 0) {
    console.warn("\n⚠ Local main had diverged from GitHub — realigning to the latest release.\n");
    spawnSync("git", ["branch", "-f", "applypilot-pre-update-backup", "HEAD"], { cwd: ROOT, stdio: "ignore" });
    const reset = spawnSync("git", ["reset", "--hard", "origin/main"], { cwd: ROOT, stdio: "inherit" });
    if (reset.status !== 0) {
      console.warn("\n⚠ Could not update to the latest code — launching your current copy.\n");
    }
  }
  // Installing/building for the new commit is ensureSynced()'s job: it keys off
  // the sync marker, so a pull whose install later fails is retried next launch.
}

// Refresh launcher copies (the file the user double-clicked, plus an existing
// Desktop copy) from the in-repo version. Runs after the pull, so a launcher
// fix arrives on the same run that downloads it. Write-then-rename only: a
// bash process may still be reading one of these files, and rename swaps the
// directory entry without touching the inode it is reading.
function refreshLaunchers() {
  const src = join(ROOT, "launchers", "ApplyPilot.command");
  if (!existsSync(src)) return;
  const srcBuf = readFileSync(src);

  const targets = new Set();
  if (process.env.APPLYPILOT_LAUNCHER_FILE) {
    targets.add(resolve(process.env.APPLYPILOT_LAUNCHER_FILE));
  }
  const desktopCopy = join(homedir(), "Desktop", "ApplyPilot.command");
  if (existsSync(desktopCopy)) targets.add(resolve(desktopCopy)); // refresh, never create

  for (const dst of targets) {
    try {
      if (dst === resolve(src) || !existsSync(dst)) continue;
      if (srcBuf.equals(readFileSync(dst))) continue;
      const tmp = `${dst}.update-${process.pid}`;
      writeFileSync(tmp, srcBuf, { mode: 0o755 });
      renameSync(tmp, dst);
      console.log(`✓ Updated launcher: ${dst}`);
    } catch (err) {
      console.warn(`⚠ Could not update launcher ${dst}: ${err.message}`);
    }
  }
}

// Install dependencies and rebuild only when needed. The marker is written only
// after install + build succeed, so a failed or interrupted update is retried
// on the next launch instead of leaving the app half-updated forever.
function ensureSynced() {
  const marker = join(ROOT, "data", ".launch-sync");
  const head = git(["rev-parse", "HEAD"]).stdout?.trim() || "unknown";
  const depsPresent =
    existsSync(join(ROOT, "node_modules")) && existsSync(join(ROOT, "dashboard", "node_modules"));
  const synced = existsSync(marker) && readFileSync(marker, "utf8").trim() === head;

  if (!depsPresent || !synced) {
    console.log(
      depsPresent
        ? "\nApplyPilot — code changed, installing & rebuilding…\n"
        : "\nApplyPilot — first run: installing dependencies (one time, this takes several minutes)…\n"
    );
    run(NPM, ["install"]);
    run(NPM, ["install"], { cwd: join(ROOT, "dashboard") });

    // Playwright's Chromium — needed for Find jobs / automation. Idempotent
    // (skips when already in the cache); warn-only so a download hiccup doesn't
    // block opening the app.
    const pw = spawnSync(NPX, ["playwright", "install", "chromium"], {
      stdio: "inherit",
      cwd: ROOT,
      shell: false,
    });
    if (pw.status !== 0) {
      console.warn("⚠ Playwright install had issues — automation may fail until you run:");
      console.warn("    npx playwright install chromium");
    }

    run(NPM, ["run", "app:sync"]);
    mkdirSync(join(ROOT, "data"), { recursive: true });
    writeFileSync(marker, `${head}\n`);
  } else if (!existsSync(join(ROOT, "dashboard", "dist", "index.html")) || isWorkingTreeDirty()) {
    // Local edits (dev) or a missing build output: rebuild the dashboard like
    // the old flow did. The common clean, already-synced launch skips this.
    run(NPM, ["run", "app:build"]);
  }
}

function startApp() {
  const logPath = join(tmpdir(), "applypilot-app.log");
  const log = openSync(logPath, "a");
  // Detached + unref: the app must survive the user closing this terminal
  // window (a double-clicked .command leaves one open).
  const child = spawn(NPM, ["run", "app:start"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  console.log("\n✓ ApplyPilot is starting — the window will appear in a moment.");
  console.log(`  You can close this terminal window. (App log: ${logPath})`);
}

tryAutoUpdate();
refreshLaunchers();
ensureSynced();
run("node", [join(ROOT, "scripts", "stop-app.mjs")]); // stop a stale engine; waits for the port to free
startApp();
