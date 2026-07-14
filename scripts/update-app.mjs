#!/usr/bin/env node
// scripts/update-app.mjs
//
// One command to update the local ApplyPilot desktop app after pulling latest code.
// Run from the repo root:  npm run app:update

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertDevCheckout } from "./dev-guard.mjs";

const ROOT = process.cwd();
assertDevCheckout(ROOT);
const MIN_NODE = 22;

function run(cmd, args, opts = {}) {
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? ROOT, shell: false });
  if (r.status !== 0) {
    console.error(`\n✗ Failed: ${cmd} ${args.join(" ")} (exit ${r.status ?? "signal"})`);
    process.exit(r.status ?? 1);
  }
}

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

console.log("ApplyPilot — updating local app…");
console.log(`  Node ${process.versions.node} · ${ROOT}`);

run("npm", ["run", "app:stop"]);

run("npm", ["install"]);
run("npm", ["install"], { cwd: join(ROOT, "dashboard") });

// Playwright browsers — needed for Find jobs / automation. Skip if already installed.
console.log("\n▶ npx playwright install chromium  (skip if already installed)");
const pw = spawnSync("npx", ["playwright", "install", "chromium"], { stdio: "inherit", cwd: ROOT, shell: false });
if (pw.status !== 0) {
  console.warn("⚠ Playwright install had issues — automation may fail until you run:");
  console.warn("    npx playwright install chromium");
}

run("npm", ["run", "app:sync"]);

console.log(`
✓ Update complete.

Launch the app:
  npm run app
or double-click ApplyPilot on your Desktop (if you ran npm run app:install).

If git pull failed earlier, run separately:
  git pull origin main
`);
