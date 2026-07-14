// scripts/install-desktop.mjs
//
// Creates a Desktop shortcut that launches the Electron app.
//   macOS: ~/Desktop/<Name>.app (hand-rolled bundle, no quarantine)
//   Linux: ~/Desktop/<Name>.desktop
//
// Two variants:
//   npm run app:install          → "ApplyPilot"        → runs `npm run app`
//                                   (everyday launcher; passively self-updates on main)
//   npm run app:install:update   → "Update ApplyPilot" → runs `npm run app:update-launch`
//                                   (explicit: pull latest from GitHub, rebuild, then run)
// Run from the repo root.

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { assertDevCheckout } from "./dev-guard.mjs";

const REPO = process.cwd();
assertDevCheckout(REPO);
const DESKTOP = join(homedir(), "Desktop");
const LOG = "/tmp/applypilot-app.log";

// Shortcut variant: default everyday launcher, or the explicit "Update & Launch".
const UPDATE_MODE = process.argv.slice(2).includes("--update");
const SHORTCUT = UPDATE_MODE
  ? { name: "Update ApplyPilot", exec: "UpdateApplyPilot", script: "app:update-launch", bundleId: "com.applypilot.updatelauncher" }
  : { name: "ApplyPilot", exec: "ApplyPilot", script: "app", bundleId: "com.applypilot.devlauncher" };

// Keep this PATH in sync with launchers/ApplyPilot.command — both launchers
// must find the same node on a double-click (Finder gives them a minimal PATH).
// Stopping a stale engine and starting detached are handled by launch-app.mjs.
const LAUNCHER_BODY = `export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd ${JSON.stringify(REPO)} || exit 1
exec npm run ${SHORTCUT.script} >> ${JSON.stringify(LOG)} 2>&1
`;

function installMac() {
  const APP = join(DESKTOP, `${SHORTCUT.name}.app`);
  const CONTENTS = join(APP, "Contents");
  const MACOS = join(CONTENTS, "MacOS");
  const RESOURCES = join(CONTENTS, "Resources");
  mkdirSync(MACOS, { recursive: true });
  mkdirSync(RESOURCES, { recursive: true });

  const ICON_SRC = join(REPO, "build", "icon.icns");
  const hasIcon = existsSync(ICON_SRC);
  if (hasIcon) copyFileSync(ICON_SRC, join(RESOURCES, "icon.icns"));

  writeFileSync(
    join(CONTENTS, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${SHORTCUT.name}</string>
  <key>CFBundleDisplayName</key><string>${SHORTCUT.name}</string>
  <key>CFBundleIdentifier</key><string>${SHORTCUT.bundleId}</string>
  <key>CFBundleExecutable</key><string>${SHORTCUT.exec}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><false/>${hasIcon ? "\n  <key>CFBundleIconFile</key><string>icon</string>" : ""}
</dict></plist>
`
  );

  const execPath = join(MACOS, SHORTCUT.exec);
  writeFileSync(execPath, `#!/bin/bash\n${LAUNCHER_BODY}`);
  chmodSync(execPath, 0o755);

  console.log("Installed:", APP);
  console.log(`Double-click ${SHORTCUT.name} on your Desktop to launch (logs: ${LOG}).`);
  console.log("If macOS blocks it the first time: right-click → Open, then Open once.");
}

function installLinux() {
  const shortcut = join(DESKTOP, `${SHORTCUT.name}.desktop`);
  const iconCandidates = [
    join(REPO, "build", "icon.png"),
    join(REPO, "dashboard", "public", "logo.svg"),
  ];
  const icon = iconCandidates.find((p) => existsSync(p));
  const iconLine = icon ? `Icon=${icon}\n` : "";

  writeFileSync(
    shortcut,
    `[Desktop Entry]
Version=1.0
Type=Application
Name=${SHORTCUT.name}
Comment=Local-first job-application co-pilot
Exec=/bin/bash -lc ${JSON.stringify(LAUNCHER_BODY)}
Path=${REPO}
${iconLine}Terminal=false
Categories=Office;Productivity;
StartupNotify=true
`
  );
  chmodSync(shortcut, 0o755);

  console.log("Installed:", shortcut);
  console.log(`Double-click ${SHORTCUT.name} on your Desktop to launch (logs: ${LOG}).`);
  console.log("If your desktop environment asks, choose “Trust” or “Allow Launching”.");
}

mkdirSync(DESKTOP, { recursive: true });

const os = platform();
if (os === "darwin") {
  installMac();
} else if (os === "linux") {
  installLinux();
} else {
  console.error(`Desktop shortcut install is supported on macOS and Linux (got ${os}).`);
  console.error(`On Windows, pin a shortcut to: npm run ${SHORTCUT.script} (from the repo root).`);
  process.exit(1);
}
