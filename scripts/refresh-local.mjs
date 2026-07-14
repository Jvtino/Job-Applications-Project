#!/usr/bin/env node
// Pull latest main + rebuild the local app. Run from the repo root: npm run app:refresh

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertDevCheckout } from "./dev-guard.mjs";

const ROOT = process.cwd();
assertDevCheckout(ROOT);

function run(cmd, args, opts = {}) {
  console.log(`\n▶ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? ROOT, shell: false });
  if (r.status !== 0) {
    console.error(`\n✗ Failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(join(ROOT, "package.json"))) {
  console.error("✗ Run this from the ApplyPilot repo root (folder with package.json).");
  process.exit(1);
}

console.log("ApplyPilot — refresh local install from GitHub…");
console.log(`  ${ROOT}\n`);

run("npm", ["run", "app:stop"]);
run("git", ["pull", "origin", "main"]);
run("npm", ["run", "app:update"]);
run("npm", ["run", "app:install"]);

console.log(`
✓ Refresh complete.

Launch:
  • Double-click ApplyPilot on your Desktop
  • or: npm run app

Logs: /tmp/applypilot-app.log
`);
