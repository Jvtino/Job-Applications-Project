#!/usr/bin/env node
// scripts/update-and-launch.mjs
//
// Explicit "Update & Launch": pull the latest release from GitHub, then hand off
// to the normal launcher (`npm run app`) which installs/rebuilds only when the
// code changed and opens the window detached. This is the deliberate, loud
// counterpart to the everyday ApplyPilot shortcut's passive auto-update — a
// single double-click that says, out loud, "get me the newest version and run it."
//
// Wired into `npm run app:update-launch`; the "Update ApplyPilot" Desktop
// shortcut (npm run app:install:update) runs exactly this.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertDevCheckout } from "./dev-guard.mjs";

const ROOT = process.cwd();
assertDevCheckout(ROOT);
const MIN_NODE = 22;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
// Releases live on main — that's what a consumer checkout tracks and updates from.
const RELEASE_BRANCH = "main";

const major = Number(process.versions.node.split(".")[0]);
if (major < MIN_NODE) {
  console.error(`✗ Node ${MIN_NODE}+ required (you have ${process.versions.node}).`);
  console.error("  Install Node 22+ from https://nodejs.org or:  brew install node@22");
  process.exit(1);
}

if (!existsSync(join(ROOT, "package.json")) || !existsSync(join(ROOT, "dashboard", "package.json"))) {
  console.error("✗ Run this from the ApplyPilot repo root (the folder with package.json).");
  console.error("  Example:  cd ~/path/to/Job-Applications-Project");
  process.exit(1);
}

function git(args, opts = {}) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
}

// Pull the latest release commit from GitHub, reporting clearly what happened.
// Guards mirror the everyday launcher's philosophy: never fast-forward a feature
// branch onto main, and never pull over uncommitted work. On any skip we still
// launch the current copy — updating should never leave the user unable to open
// the app.
function updateFromGitHub() {
  if (!existsSync(join(ROOT, ".git"))) {
    console.log("• Not a git checkout — skipping update, launching the current copy.");
    return;
  }

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout?.trim();
  if (branch !== RELEASE_BRANCH) {
    console.warn(
      `⚠ You're on branch "${branch}", not "${RELEASE_BRANCH}". Updates are published on ` +
        `${RELEASE_BRANCH}, so this won't pull them into a different branch.\n` +
        `  Launching your current copy. To track releases:  git checkout ${RELEASE_BRANCH}\n`
    );
    return;
  }

  const dirty = git(["status", "--porcelain"]).stdout?.trim();
  if (dirty) {
    console.warn(
      "⚠ This folder has local changes, so the update was skipped to protect them.\n" +
        "  Commit or stash them, then run Update again. Launching your current copy.\n"
    );
    return;
  }

  console.log(`▶ Checking GitHub for a newer version (origin/${RELEASE_BRANCH})…`);
  if (git(["fetch", "origin", RELEASE_BRANCH], { stdio: "inherit", encoding: undefined }).status !== 0) {
    console.warn("⚠ Couldn't reach GitHub — launching your current copy.\n");
    return;
  }

  const local = git(["rev-parse", "HEAD"]).stdout?.trim();
  const remote = git(["rev-parse", `origin/${RELEASE_BRANCH}`]).stdout?.trim();
  if (local && remote && local === remote) {
    console.log("✓ Already on the latest version.\n");
    return;
  }

  // Fast-forward when simply behind (a consumer checkout of main only moves forward, so this never
  // creates a merge commit). If history has DIVERGED, realign to origin/main rather than stranding the
  // user on old code — the working tree is confirmed clean above, and the prior commit is backed up to
  // a ref first so nothing is truly lost.
  const ff = git(["merge", "--ff-only", `origin/${RELEASE_BRANCH}`], { stdio: "inherit", encoding: undefined });
  if (ff.status !== 0) {
    console.warn("⚠ Local main had diverged from GitHub — realigning to the latest release.\n");
    git(["branch", "-f", "applypilot-pre-update-backup", "HEAD"], { stdio: "ignore" });
    const reset = git(["reset", "--hard", `origin/${RELEASE_BRANCH}`], { stdio: "inherit", encoding: undefined });
    if (reset.status !== 0) {
      console.warn("⚠ Could not update to the latest code — launching your current copy.\n");
      return;
    }
  }
  console.log("✓ Updated to the latest version from GitHub.\n");
}

console.log("ApplyPilot — Update & Launch");
console.log(`  Node ${process.versions.node} · ${ROOT}\n`);

updateFromGitHub();

// Hand off to the everyday launcher: it installs deps + rebuilds ONLY when the
// code changed (keyed off the pulled HEAD), stops any stale engine, and starts
// the window detached so it survives this process exiting.
const launch = spawnSync(NPM, ["run", "app"], { cwd: ROOT, stdio: "inherit", shell: false });
process.exit(launch.status ?? 0);
