#!/bin/bash
# ============================================================================
#  ApplyPilot — Desktop launcher (GitHub-first)
#  Double-click this file. On first run it downloads ApplyPilot from GitHub;
#  after that the in-repo updater (scripts/launch-app.mjs) pulls updates when
#  it safely can, installs/builds only when the code changed, and opens the
#  desktop app.
#
#  This file is a thin bootstrap on purpose: everything that changes over time
#  lives in the repo and arrives via git pull. After each update,
#  scripts/launch-app.mjs refreshes existing copies of this launcher with a
#  write-then-rename (never overwriting a script while it runs).
#
#  Your private data (profile, resumes, local database, browser logins) lives
#  only on this Mac and is git-ignored — it is never uploaded and never erased
#  by an update.
# ============================================================================

REPO_URL="https://github.com/Jvtino/Job-Applications-Project.git"
BRANCH="main"
NAME="ApplyPilot"

# Absolute path of the copy the user actually launched, captured before any cd,
# so scripts/launch-app.mjs can refresh this exact file after an update.
case "$0" in
  /*) APPLYPILOT_LAUNCHER_FILE="$0" ;;
  *)  APPLYPILOT_LAUNCHER_FILE="$PWD/$0" ;;
esac
export APPLYPILOT_LAUNCHER_FILE

# Where the app lives: one canonical location shared with setup-mac.command and
# update-mac.command. APPLYPILOT_HOME overrides, and an existing install in
# either known location is reused instead of cloning a second copy.
if [ -n "${APPLYPILOT_HOME:-}" ]; then
  APP_DIR="$APPLYPILOT_HOME"
elif [ -d "$HOME/Job-Applications-Project/.git" ]; then
  APP_DIR="$HOME/Job-Applications-Project"
elif [ -d "$HOME/ApplyPilot/.git" ]; then
  APP_DIR="$HOME/ApplyPilot"
else
  APP_DIR="$HOME/Job-Applications-Project"
fi

export PATH="$HOME/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
die() { printf "\n\033[1m%s\033[0m\n" "$1"; read -r -p "Press Return to close this window."; exit 1; }

[ -t 1 ] && clear
say "🛩  $NAME — starting up (everything comes from GitHub)"

# 1) Required tools, with friendly install hints. `git --version` actually runs
#    git: on a Mac without the Command Line Tools, /usr/bin/git exists as an
#    Apple stub (so `command -v git` would pass), but running it fails and pops
#    Apple's install dialog — exactly when this message should appear.
if ! git --version >/dev/null 2>&1; then
  die "Git isn't installed yet.
   A box may have just popped up offering to install the Command Line Tools —
   click Install, wait for it to finish, then double-click this icon again.
   (If no box appeared, open Terminal and run:  xcode-select --install )"
fi
if ! command -v node >/dev/null 2>&1; then
  die "Node.js isn't installed.
   1. Go to https://nodejs.org and click the big green \"LTS\" button.
   2. Install it (keep clicking Continue) — ApplyPilot needs version 22 or newer.
   3. Double-click this icon again."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  die "ApplyPilot needs Node.js 22 or newer — you have $(node -v 2>/dev/null || echo "an unknown version").
   Install the LTS version from https://nodejs.org, then double-click this icon again."
fi

# 2) First run: download the app. Every later update is handled by
#    scripts/launch-app.mjs (invoked at the end of this script).
if [ ! -d "$APP_DIR/.git" ]; then
  if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    die "The folder $APP_DIR already exists but doesn't contain ApplyPilot.
   Move or rename that folder, then double-click this icon again."
  fi
  say "First run — downloading $NAME from GitHub…"
  git clone --depth 1 --single-branch --branch "$BRANCH" "$REPO_URL" "$APP_DIR" \
    || die "Download failed.
   If a Command Line Tools install box just appeared, click Install, wait for it
   to finish, then double-click this icon again.
   Otherwise check your internet connection and try again."
fi

# Guard against a different git project squatting the app folder — never run a
# foreign repo's npm scripts.
ORIGIN_URL="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null)"
case "$ORIGIN_URL" in
  *Job-Applications-Project*) ;;
  *) die "The folder $APP_DIR contains a different git project (origin: ${ORIGIN_URL:-unknown}).
   Move it aside — or set APPLYPILOT_HOME to your ApplyPilot folder — then relaunch." ;;
esac

# Repair a half-finished download (e.g. the first clone was interrupted during
# checkout: .git exists but files are missing). Restores tracked files only —
# data/, .env, and browser profiles are git-ignored and untouched.
if [ ! -f "$APP_DIR/package.json" ]; then
  say "Repairing an incomplete download…"
  git -C "$APP_DIR" reset --hard HEAD \
    || die "Could not repair $APP_DIR. Delete that folder, then double-click this icon again."
fi

cd "$APP_DIR" || die "Could not open $APP_DIR."

# 3) Hand off to the in-repo updater+launcher (pull when safe, install/build
#    when needed, then start the app detached from this window).
say "Updating and starting $NAME…"
exec npm run app
