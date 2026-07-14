// scripts/dev-guard.mjs
//
// Dev-only tooling gate (commercial M1). The launch/update/install scripts assume a source tree
// with npm and Node on PATH — none of which exist for a customer running the packaged app (which
// doesn't even ship scripts/). Accept any source checkout (git clone OR a ZIP/tarball export,
// which has src/ but no .git); refuse only when the tree isn't ApplyPilot source at all.

import { existsSync } from "node:fs";
import { join } from "node:path";

export function assertDevCheckout(root) {
  if (existsSync(join(root, ".git")) || existsSync(join(root, "src"))) return;
  console.error("✗ This script only runs from an ApplyPilot source checkout (git clone or source download).");
  console.error("  If you installed the desktop app, it manages itself — open ApplyPilot from Applications.");
  process.exit(1);
}
