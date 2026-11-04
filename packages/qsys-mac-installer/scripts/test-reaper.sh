#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# Build the launcher and exercise its reaper against fake Designers: no Wine, no Q-SYS installer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'pkill -f "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

tsay() { printf '\033[1;36m[reaper-test]\033[0m %s\n' "$*"; }
tdie() { printf '\033[1;31m[reaper-test] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

export CFFIXED_USER_HOME="$TMP/home"
DATA="$CFFIXED_USER_HOME/Library/Application Support/Q-SYS Designer"
BIN="$DATA/Wine Staging.app/Contents/Resources/wine/bin"
mkdir -p "$BIN"
export QSYS_FAKE_LOG="$TMP/wineserver.log"
cat >"$BIN/wineserver" <<'SH'
#!/bin/bash
echo "$*" >>"$QSYS_FAKE_LOG"
SH
chmod +x "$BIN/wineserver"
# macOS kills a copied system binary, so the stand-in Designer is built here.
printf '#include <stdlib.h>\n#include <unistd.h>\nint main(int c, char **v) { sleep(atoi(v[c - 1])); }\n' | cc -x c - -o "$BIN/fake-wine"
cp "$BIN/fake-wine" "$TMP/elsewhere"

LAUNCHER="$TMP/launcher"
swiftc -O "$ROOT/app/Sources/Shared/"*.swift "$ROOT/app/Sources/Launcher/main.swift" -o "$LAUNCHER"

# Start a sleeping process with a chosen executable and command line.
fake() { (exec -a "$2" "$1" "$3") & LAST=$!; }
DESIGNER='C:\QSC\Q-Sys Designer\Q-Sys Designer.exe Z:\tmp\b.qsys'
HELPER='C:\QSC\Q-Sys Designer\CefSharp.BrowserSubprocess.exe --type=gpu Q-Sys Designer.exe'

reap() { QSYS_REAPER=1 "$LAUNCHER" --reap "$1" & REAPER=$!; }
stops() { [ -f "$QSYS_FAKE_LOG" ] && grep -c -- '-k' "$QSYS_FAKE_LOG" || echo 0; }
wait_exit() { local i; for i in {1..60}; do kill -0 "$1" 2>/dev/null || return 0; sleep 0.25; done; tdie "$2"; }
reset() { rm -f "$QSYS_FAKE_LOG"; }

tsay "the first design closes first: Wine stays up until the second closes"
reset
fake "$BIN/fake-wine" "$DESIGNER" 30; second=$LAST
sleep 1 & watched=$!
reap "$watched"
wait "$watched" || true
sleep 3
kill -0 "$REAPER" 2>/dev/null || tdie "reaper left while a Designer was running"
[ "$(stops)" = 0 ] || tdie "Wine was stopped while a Designer was running"
kill "$second"; wait "$second" 2>/dev/null || true
wait_exit "$REAPER" "reaper did not finish after the last Designer closed"
[ "$(stops)" = 1 ] || tdie "expected 1 Wine stop after the last Designer closed, got $(stops)"

tsay "the only design closes: Wine stops at once"
reset
sleep 1 & watched=$!
reap "$watched"
wait "$watched" || true
wait_exit "$REAPER" "reaper did not finish with no Designer running"
[ "$(stops)" = 1 ] || tdie "expected 1 Wine stop, got $(stops)"

tsay "a crash leaves only a helper: the helper does not hold Wine up"
reset
fake "$BIN/fake-wine" "$HELPER" 30; helper=$LAST
sleep 30 & watched=$!
reap "$watched"
sleep 1
kill -9 "$watched"; wait "$watched" 2>/dev/null || true
wait_exit "$REAPER" "a helper process held the reaper up"
[ "$(stops)" = 1 ] || tdie "expected 1 Wine stop after the crash, got $(stops)"
kill "$helper"; wait "$helper" 2>/dev/null || true

tsay "a Designer from another install does not hold Wine up"
reset
fake "$TMP/elsewhere" "$DESIGNER" 30; other=$LAST
sleep 1 & watched=$!
reap "$watched"
wait "$watched" || true
wait_exit "$REAPER" "a Designer on another install held the reaper up"
[ "$(stops)" = 1 ] || tdie "expected 1 Wine stop, got $(stops)"
kill "$other"; wait "$other" 2>/dev/null || true

tsay "a second reaper waits and takes over if the first one dies"
reset
sleep 30 & first=$!
reap "$first"; primary=$REAPER
sleep 1
sleep 30 & later=$!
reap "$later"; second=$REAPER
sleep 1
kill -0 "$second" 2>/dev/null || tdie "the second reaper left"
kill -9 "$primary"; wait "$primary" 2>/dev/null || true
sleep 1
kill -0 "$second" 2>/dev/null || tdie "the second reaper did not take over"
[ "$(stops)" = 0 ] || tdie "Wine was stopped while a watched process was running"
kill "$first" "$later"; wait "$first" "$later" 2>/dev/null || true
wait_exit "$second" "the second reaper did not finish"
[ "$(stops)" = 1 ] || tdie "expected 1 Wine stop, got $(stops)"

tsay "all reaper checks passed"
