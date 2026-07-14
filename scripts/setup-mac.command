#!/bin/bash
# First-time setup on macOS: clone ApplyPilot, install deps, build, and launch.
# Double-click this file, or run: bash scripts/setup-mac.command

set -e
TARGET="${APPLYPILOT_HOME:-$HOME/Job-Applications-Project}"
REPO_URL="https://github.com/Jvtino/Job-Applications-Project.git"

echo "ApplyPilot — first-time setup"
echo "Install location: $TARGET"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed."
  echo "Install Node 22+ from https://nodejs.org or run: brew install node@22"
  read -r -p "Press Enter to close…"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node 22+ required (you have $(node -v))."
  read -r -p "Press Enter to close…"
  exit 1
fi

if [ ! -d "$TARGET/.git" ]; then
  echo "→ Cloning repository…"
  git clone "$REPO_URL" "$TARGET"
else
  echo "→ Repository already exists at $TARGET"
fi

cd "$TARGET" || exit 1
echo "→ Updating…"
git pull origin main
echo "→ Installing & building…"
npm run app:update
npx playwright install chromium
echo ""
echo "✓ Setup complete. Launching ApplyPilot…"
npm run app
