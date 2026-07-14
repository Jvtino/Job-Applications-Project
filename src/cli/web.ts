// src/cli/web.ts
//
// Browser-first entrypoint for ApplyPilot. This serves the built React dashboard from the
// same Node API process that Electron already uses, without launching the Electron shell.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { startApiServer } from "../server/api";

const port = Number(process.env.APPLYPILOT_API_PORT) || 5179;
const webRoot = resolve(process.env.APPLYPILOT_WEB_ROOT?.trim() || "dashboard/dist");

if (!existsSync(webRoot)) {
  process.stderr.write(
    `Built dashboard not found at ${webRoot}.\n` +
      "Run: npm run web:build\n"
  );
  process.exit(1);
}

startApiServer(port, { webRoot });
