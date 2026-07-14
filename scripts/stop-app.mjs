#!/usr/bin/env node
// scripts/stop-app.mjs — stop a stale ApplyPilot API / free port 5179 before relaunching.

import { spawnSync } from "node:child_process";

const PORT = process.env.APPLYPILOT_API_PORT || "5179";

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidsOnPort(port) {
  const found = spawnSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" });
  return (found.stdout || "").trim().split("\n").filter(Boolean);
}

// Wait (bounded) for the port to actually free — the relauncher spawns a new
// engine right after this script, and a lingering listener would make the new
// engine die with EADDRINUSE.
function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsOnPort(port).length === 0) return true;
    sleep(250);
  }
  return pidsOnPort(port).length === 0;
}

function killPort(port) {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
      ],
      { stdio: "inherit" }
    );
    return r.status === 0;
  }

  const pids = pidsOnPort(port);
  if (!pids.length) return false;
  for (const pid of pids) {
    spawnSync("kill", ["-TERM", pid]);
  }
  if (!waitForPortFree(port, 5000)) {
    for (const pid of pidsOnPort(port)) {
      spawnSync("kill", ["-KILL", pid]);
    }
    if (!waitForPortFree(port, 2000)) {
      console.warn(`⚠ Port ${port} is still in use — the next launch may fail to bind.`);
    }
  }
  return true;
}

console.log(`Stopping ApplyPilot processes on port ${PORT}…`);
const stopped = killPort(PORT);
if (stopped) {
  console.log("✓ Stopped stale engine. You can run: npm run app");
} else {
  console.log("No process was listening on that port.");
}
