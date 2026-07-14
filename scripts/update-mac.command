#!/bin/bash
# Double-click this file on macOS (or run: bash scripts/update-mac.command)
# Updates ApplyPilot and launches the app.

REPO_URL="https://github.com/Jvtino/Job-Applications-Project.git"
DEFAULT_TARGET="$HOME/Job-Applications-Project"

# If run from the repo's scripts/ folder, use that repo; otherwise use ~/Job-Applications-Project.
if [ -f "$(dirname "$0")/../package.json" ]; then
  cd "$(dirname "$0")/.." || exit 1
else
  cd "$DEFAULT_TARGET" 2>/dev/null || {
    echo "ERROR: ApplyPilot repo not found."
    echo ""
    echo "First-time setup: double-click scripts/setup-mac.command"
    echo "Or run:"
    echo "  git clone $REPO_URL $DEFAULT_TARGET"
    echo "  cd $DEFAULT_TARGET && npm run app:update && npm run app"
    read -r -p "Press Enter to close…"
    exit 1
  }
fi
REPO="$(pwd)"

echo "ApplyPilot updater"
echo "Repo: $REPO"
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

if [ ! -d ".git" ]; then
  echo "ERROR: This folder is not a git repository."
  echo "Run scripts/setup-mac.command for first-time install."
  read -r -p "Press Enter to close…"
  exit 1
fi

echo "→ Pulling latest code…"
if ! git pull origin main; then
  echo "ERROR: git pull failed. Check your internet connection and try again."
  read -r -p "Press Enter to close…"
  exit 1
fi

echo "→ Installing & building…"
if ! npm run app:update; then
  echo "ERROR: build failed. See messages above."
  read -r -p "Press Enter to close…"
  exit 1
fi

echo ""
echo "✓ Done. Launching ApplyPilot…"
npm run app
