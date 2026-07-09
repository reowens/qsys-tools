#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# Real smoke test: provision from a user-supplied Designer installer into a temp data dir,
# optionally launch briefly, then assert Wine leaves no prefix-bound processes behind.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER=""
KEEP="${KEEP:-0}"
LAUNCH_SECONDS="${QSYS_SMOKE_LAUNCH_SECONDS:-30}"
TMP_PARENT="${QSYS_SMOKE_TMP_PARENT:-${TMPDIR:-/tmp}}"
TMP=""
DATA=""

say() { printf '\033[1;36m[smoke]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[smoke] WARN:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[smoke] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  printf 'usage: scripts/smoke-provision.sh [--keep] [--no-launch | --launch-seconds N] <Q-SYS Designer Installer*.exe>\n' >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --no-launch) LAUNCH_SECONDS=0; shift ;;
    --launch-seconds)
      [ $# -ge 2 ] || { usage; exit 2; }
      LAUNCH_SECONDS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      [ -z "$INSTALLER" ] || { usage; exit 2; }
      INSTALLER="$1"; shift ;;
  esac
done

[ -n "$INSTALLER" ] || { usage; exit 2; }
[ -f "$INSTALLER" ] || die "installer not found: $INSTALLER"
case "$LAUNCH_SECONDS" in ''|*[!0-9]*) die "--launch-seconds must be a non-negative integer" ;; esac

stop_temp_wine() {
  [ -n "$DATA" ] || return 0
  local wineserver="$DATA/Wine Staging.app/Contents/Resources/wine/bin/wineserver"
  [ -x "$wineserver" ] && WINEPREFIX="$DATA/prefix" "$wineserver" -k >/dev/null 2>&1 || true
}

leftover_processes() {
  [ -n "$DATA" ] || return 0
  ps -axo pid,ppid,pgid,stat,%cpu,%mem,etime,command | awk -v d="$DATA" '
    index($0, d) && !index($0, " awk ") { print }
  '
}

assert_no_leftovers() {
  local label="$1" leftovers
  leftovers="$(leftover_processes)"
  if [ -n "$leftovers" ]; then
    printf '%s\n' "$leftovers" >&2
    die "leftover temp-prefix process(es) after $label"
  fi
}

cleanup() {
  local rc=$?
  stop_temp_wine
  if [ -n "$TMP" ]; then
    if [ "$KEEP" = "1" ] || [ "$rc" -ne 0 ]; then
      warn "kept temp dir: $TMP"
    else
      rm -rf "$TMP"
    fi
  fi
}
trap cleanup EXIT

[ -d "$TMP_PARENT" ] || die "temp parent not found: $TMP_PARENT"
TMP="$(mktemp -d "${TMP_PARENT%/}/qsys-real-provision.XXXXXX")"
DATA="$TMP/data"
say "temp dir: $TMP"

say "provisioning isolated data dir"
WRAP_HOME="$DATA" \
CACHE="$ROOT/app/Resources/cache" \
QSYS_PREBUILT_APPMENU="$ROOT/app/Resources/bin/appmenu.dylib" \
QSYS_PREBUILT_ICONPAD="$ROOT/app/Resources/bin/iconpad" \
QSYS_PREPATCHED_LOADER="$ROOT/app/Resources/bin/wine-loader-prepatched" \
PATH="$ROOT/app/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  /bin/bash "$ROOT/provision.sh" "$INSTALLER"

stop_temp_wine
sleep 2
assert_no_leftovers "provision"

if [ "$LAUNCH_SECONDS" -gt 0 ]; then
  say "launching for ${LAUNCH_SECONDS}s, then forcing Wine exit"
  log="$TMP/launch.log"
  WRAP_HOME="$DATA" \
  WINEPREFIX="$DATA/prefix" \
  WINE_APP="$DATA/Wine Staging.app" \
  QSYS_DEBUG=1 \
  QSYS_LOG="$log" \
    "$ROOT/launch.sh" &
  launch_pid=$!
  sleep "$LAUNCH_SECONDS"
  if ! kill -0 "$launch_pid" 2>/dev/null; then
    wait "$launch_pid" 2>/dev/null || true
    die "launch exited before the ${LAUNCH_SECONDS}s smoke window completed; log: $log"
  fi
  kill "$launch_pid" 2>/dev/null || true
  wait "$launch_pid" 2>/dev/null || true
  sleep 8
  assert_no_leftovers "launch termination"
  if command -v rg >/dev/null 2>&1 && [ -f "$log" ]; then
    if rg -n 'Unhandled exception|0xe0434352|err:seh|backtrace|Assertion failed|panic' "$log" >&2; then
      die "launch log contains crash signatures: $log"
    fi
  fi
fi

say "smoke passed"
