// scripts/build-engine.mjs
//
// Bundles the Node engine (the local API + dashboard server entry, src/cli/dashboard-api.ts) into a
// single CommonJS file at app-build/engine.cjs, so the PACKAGED app needs neither tsx nor the TS
// source. Native + heavy deps are kept external (loaded from node_modules at runtime, which
// electron-builder bundles and rebuilds for the Electron ABI).

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "src/cli/dashboard-api.ts")],
  outfile: join(root, "app-build/engine.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // Keep deps external — esbuild only bundles our own code; node_modules ships in the .app.
  external: [
    "better-sqlite3", "playwright", "playwright-core", "electron", "fsevents",
    "@anthropic-ai/sdk", "docx", "mammoth", "pdf-lib", "unpdf", "zod",
    "node-llama-cpp", // ESM + native binding; loaded via dynamic import at runtime
  ],
  logLevel: "info",
});

console.log("engine bundled -> app-build/engine.cjs");
