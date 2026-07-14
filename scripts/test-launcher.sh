#!/bin/bash
# End-to-end simulation of the Desktop launcher + launch-app.mjs flow.
# Run from anywhere:  bash scripts/test-launcher.sh
#
# Builds a throwaway origin repo from this checkout, a fake $HOME with a
# stubbed npm/npx toolchain (real git and node), and drives the launcher
# through first run, updates, repairs, and every guard path. No network,
# no real installs; everything happens in a mktemp dir.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/applypilot-launcher-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check() { # check <desc> <cmd...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}

# ---- Fake origin: committed copy of this checkout's tracked files ----
ORIGIN_SRC="$WORK/origin-src"
mkdir -p "$ORIGIN_SRC"
(cd "$REPO" && git ls-files -z | tar --null -T - -cf - 2>/dev/null) | (cd "$ORIGIN_SRC" && tar -xf -)
git -C "$ORIGIN_SRC" init -q -b main
git -C "$ORIGIN_SRC" -c user.email=t@t -c user.name=t add -A
git -C "$ORIGIN_SRC" -c user.email=t@t -c user.name=t commit -qm v1
# The bare-repo name must contain "Job-Applications-Project" — the launcher's
# foreign-repo guard checks the origin URL for it.
ORIGIN="$WORK/Job-Applications-Project.git"
git clone -q --bare "$ORIGIN_SRC" "$ORIGIN"
REPO_URL_FILE="file://$ORIGIN"

# ---- Fake HOME with stub toolchain in ~/.local/node/bin ----
FH="$WORK/home"
BIN="$FH/.local/node/bin"
mkdir -p "$FH/Desktop" "$BIN"
ln -s "$(command -v node)" "$BIN/node"
export NPMLOG="$WORK/npm.log"
cat > "$BIN/npm" <<'EOF'
#!/bin/bash
echo "npm $* (cwd=$PWD)" >> "$NPMLOG"
case "$1 ${2:-}" in
  "run app")       exec node "scripts/launch-app.mjs" ;;
  "run app:sync")  mkdir -p dashboard/dist && echo built > dashboard/dist/index.html ;;
  "run app:build") mkdir -p dashboard/dist && echo built > dashboard/dist/index.html ;;
  "run app:start") sleep 1 ;;
  "install "|"install") mkdir -p node_modules && touch node_modules/.stub ;;
esac
exit 0
EOF
cat > "$BIN/npx" <<'EOF'
#!/bin/bash
echo "npx $*" >> "$NPMLOG"
exit 0
EOF
chmod +x "$BIN/npm" "$BIN/npx"

# Desktop launcher copy, pointed at the fake origin; keep the origin's copy
# identical so the self-refresh is a no-op at v1.
DL="$FH/Desktop/ApplyPilot.command"
sed "s|REPO_URL=\"https://github.com/Jvtino/Job-Applications-Project.git\"|REPO_URL=\"$REPO_URL_FILE\"|" \
  "$REPO/launchers/ApplyPilot.command" > "$DL"
chmod +x "$DL"
cp "$DL" "$ORIGIN_SRC/launchers/ApplyPilot.command"
git -C "$ORIGIN_SRC" -c user.email=t@t -c user.name=t add -A
git -C "$ORIGIN_SRC" -c user.email=t@t -c user.name=t commit -qam "point launcher at test origin"
git -C "$ORIGIN_SRC" push -q "$ORIGIN" main

APP="$FH/Job-Applications-Project"

run_launcher() { # run_launcher <logfile>
  HOME="$FH" APPLYPILOT_HOME="" timeout 120 bash "$DL" </dev/null >"$1" 2>&1
}

echo "== Scenario A: first run on a clean 'Mac' =="
: > "$NPMLOG"
run_launcher "$WORK/a.log"; RC=$?
check "exits 0 (rc=$RC)" test "$RC" -eq 0
check "cloned into ~/Job-Applications-Project" test -d "$APP/.git"
check "shallow clone" test -f "$APP/.git/shallow"
check "root npm install ran" grep -q "npm install (cwd=$APP)" "$NPMLOG"
check "dashboard npm install ran" grep -q "npm install (cwd=$APP/dashboard)" "$NPMLOG"
check "playwright chromium install ran" grep -q "npx playwright install chromium" "$NPMLOG"
check "app:sync ran" grep -q "npm run app:sync" "$NPMLOG"
check "sync marker written" test -f "$APP/data/.launch-sync"
check "marker == HEAD" test "$(cat "$APP/data/.launch-sync")" = "$(git -C "$APP" rev-parse HEAD)"
check "app started detached" grep -q "ApplyPilot is starting" "$WORK/a.log"
check "first-run message shown" grep -q "first run: installing dependencies" "$WORK/a.log"

echo "== Scenario B: second run — fast path, no reinstall/rebuild =="
: > "$NPMLOG"
run_launcher "$WORK/b.log"; RC=$?
check "exits 0 (rc=$RC)" test "$RC" -eq 0
check "no npm install" bash -c "! grep -q 'npm install' '$NPMLOG'"
check "no app:sync" bash -c "! grep -q 'app:sync' '$NPMLOG'"
check "no app:build" bash -c "! grep -q 'app:build' '$NPMLOG'"
check "app started" grep -q "ApplyPilot is starting" "$WORK/b.log"

echo "== Scenario C: origin ships an update (incl. launcher change) =="
echo "# v2 marker" >> "$ORIGIN_SRC/launchers/ApplyPilot.command"
echo "v2" > "$ORIGIN_SRC/VERSION-TEST"
git -C "$ORIGIN_SRC" -c user.email=t@t -c user.name=t add -A
git -C "$ORIGIN_SRC" -c user.email=t@t -c user.name=t commit -qam v2
git -C "$ORIGIN_SRC" push -q "$ORIGIN" main
: > "$NPMLOG"
run_launcher "$WORK/c.log"; RC=$?
check "exits 0 (rc=$RC)" test "$RC" -eq 0
check "pulled the update" test -f "$APP/VERSION-TEST"
check "reinstall+resync after update" grep -q "app:sync" "$NPMLOG"
check "Desktop launcher refreshed same run" grep -q "# v2 marker" "$DL"
check "refresh logged" grep -q "Updated launcher" "$WORK/c.log"
check "marker advanced to new HEAD" test "$(cat "$APP/data/.launch-sync")" = "$(git -C "$APP" rev-parse HEAD)"
check "no leftover temp files on Desktop" bash -c "! ls '$FH/Desktop' | grep -q '.update-'"

echo "== Scenario D: dirty tree — update skipped with warning, app still opens =="
echo stray > "$APP/stray-file.txt"
echo "v3" > "$ORIGIN_SRC/VERSION-TEST"
git -C "$ORIGIN_SRC" -c user.email=t@t -c user.name=t add -A
git -C "$ORIGIN_SRC" -c user.email=t@t -c user.name=t commit -qam v3
git -C "$ORIGIN_SRC" push -q "$ORIGIN" main
: > "$NPMLOG"
run_launcher "$WORK/d.log"; RC=$?
check "exits 0 (rc=$RC)" test "$RC" -eq 0
check "pull skipped" test "$(cat "$APP/VERSION-TEST")" = "v2"
check "warning shown" grep -q "Skipping auto-update" "$WORK/d.log"
check "app still started" grep -q "ApplyPilot is starting" "$WORK/d.log"
rm "$APP/stray-file.txt"

echo "== Scenario E: interrupted checkout repair =="
rm "$APP/package.json"
: > "$NPMLOG"
run_launcher "$WORK/e.log"; RC=$?
check "exits 0 (rc=$RC)" test "$RC" -eq 0
check "repair message" grep -q "Repairing an incomplete download" "$WORK/e.log"
check "package.json restored" test -f "$APP/package.json"
check "user data survived repair" test -f "$APP/data/.launch-sync"

echo "== Scenario F: pre-existing non-empty folder without .git =="
FH2="$WORK/home2"; mkdir -p "$FH2/Desktop" "$FH2/.local"
cp -a "$FH/.local/node" "$FH2/.local/"
mkdir -p "$FH2/Job-Applications-Project"; echo x > "$FH2/Job-Applications-Project/.env"
HOME="$FH2" APPLYPILOT_HOME="" timeout 60 bash "$DL" </dev/null >"$WORK/f.log" 2>&1; RC=$?
check "exits nonzero (rc=$RC)" test "$RC" -ne 0
check "clear guidance (not a network error)" grep -q "doesn't contain ApplyPilot" "$WORK/f.log"

echo "== Scenario G: foreign repo squatting the folder =="
rm -rf "$FH2/Job-Applications-Project"
git init -q "$FH2/Job-Applications-Project" && git -C "$FH2/Job-Applications-Project" remote add origin https://example.com/other/project.git
HOME="$FH2" APPLYPILOT_HOME="" timeout 60 bash "$DL" </dev/null >"$WORK/g.log" 2>&1; RC=$?
check "exits nonzero (rc=$RC)" test "$RC" -ne 0
check "foreign-repo message" grep -q "different git project" "$WORK/g.log"

echo "== Scenario H: old Node is rejected before anything runs =="
FH3="$WORK/home3"; BIN3="$FH3/.local/node/bin"; mkdir -p "$FH3/Desktop" "$BIN3"
cat > "$BIN3/node" <<'EOF'
#!/bin/bash
case "$1" in
  -p) echo 18 ;;
  -v) echo v18.20.0 ;;
esac
exit 0
EOF
chmod +x "$BIN3/node"
HOME="$FH3" APPLYPILOT_HOME="" timeout 60 bash "$DL" </dev/null >"$WORK/h.log" 2>&1; RC=$?
check "exits nonzero (rc=$RC)" test "$RC" -ne 0
check "friendly Node-22 message" grep -q "needs Node.js 22 or newer" "$WORK/h.log"
check "nothing was cloned" test ! -e "$FH3/Job-Applications-Project"

echo "== Scenario I: existing install at ~/ApplyPilot is adopted (no second clone) =="
FH4="$WORK/home4"; mkdir -p "$FH4/Desktop" "$FH4/.local"
cp -a "$FH/.local/node" "$FH4/.local/"
git clone -q "$ORIGIN" "$FH4/ApplyPilot"
: > "$NPMLOG"
HOME="$FH4" APPLYPILOT_HOME="" timeout 120 bash "$DL" </dev/null >"$WORK/i.log" 2>&1; RC=$?
check "exits 0 (rc=$RC)" test "$RC" -eq 0
check "no second clone at ~/Job-Applications-Project" test ! -e "$FH4/Job-Applications-Project"
check "ran inside ~/ApplyPilot" grep -q "cwd=$FH4/ApplyPilot" "$NPMLOG"

echo
echo "RESULT: $PASS passed, $FAIL failed"
exit "$FAIL"
