#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# Exercise the Wine/provisioning process cleanup paths without a real Wine install or Q-SYS installer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP=""
TOKENS=()

tsay() { printf '\033[1;36m[cleanup-test]\033[0m %s\n' "$*"; }
tdie() { printf '\033[1;31m[cleanup-test] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

pids_matching_token() {
  local token="$1"
  ps -axo pid=,command= | awk -v token="$token" '
    index($0, token) && !index($0, " awk ") { print $1 }
  '
}

show_token_processes() {
  local token="$1" pids
  pids="$(pids_matching_token "$token")"
  [ -n "$pids" ] || return 0
  ps -o pid,ppid,pgid,stat,%cpu,%mem,etime,command -p "$(printf '%s\n' "$pids" | paste -sd, -)" >&2 || true
}

assert_no_token_processes() {
  local token="$1" pids
  pids="$(pids_matching_token "$token")"
  if [ -n "$pids" ]; then
    show_token_processes "$token"
    tdie "leftover process(es) matched token: $token"
  fi
}

wait_for_log_count() {
  local want="$1" file="$2" label="$3" count i
  for i in {1..50}; do
    count=0
    [ -f "$file" ] && count="$(wc -l <"$file" | tr -d ' ')"
    [ "$count" -ge "$want" ] && return 0
    sleep 0.1
  done
  tdie "$label did not write $want wineserver log line(s)"
}

run_filtering_intentional_terms() {
  local err="$TMP/stderr.$RANDOM" rc restore_errexit=0
  case $- in *e*) restore_errexit=1; set +e ;; esac
  "$@" 2>"$err"
  rc=$?
  if [ -s "$err" ]; then
    grep -v 'Terminated: 15' "$err" >&2 || true
  fi
  rm -f "$err"
  [ "$restore_errexit" -eq 1 ] && set -e
  return "$rc"
}

cleanup() {
  local token pids pid
  for token in "${TOKENS[@]:-}"; do
    pids="$(pids_matching_token "$token")"
    while IFS= read -r pid; do
      [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done <<<"$pids"
  done
  [ -n "$TMP" ] && rm -rf "$TMP"
}
trap cleanup EXIT

TMP="$(mktemp -d)"
export WRAP_HOME="$TMP/wrap"
export WINEPREFIX="$TMP/prefix"
export WINE_APP="$TMP/Wine Staging.app"
mkdir -p "$WINE_APP/Contents/Resources/wine/bin" "$WINEPREFIX"

# shellcheck source=../lib/recipe.sh
source "$ROOT/lib/recipe.sh"

export QSYS_FAKE_WINESERVER_LOG="$TMP/wineserver.log"
cat >"$WINEDIR/bin/wineserver" <<'SH'
#!/bin/bash
printf '%s\t%s\n' "${WINEPREFIX:-}" "$*" >>"${QSYS_FAKE_WINESERVER_LOG:?}"
exit 0
SH
chmod +x "$WINEDIR/bin/wineserver"

tsay "stop_wine_for_prefix invokes wineserver -k with the test prefix"
: >"$QSYS_FAKE_WINESERVER_LOG"
stop_wine_for_prefix
wait_for_log_count 1 "$QSYS_FAKE_WINESERVER_LOG" "stop_wine_for_prefix"
grep -F "${WINEPREFIX}"$'\t''-k' "$QSYS_FAKE_WINESERVER_LOG" >/dev/null \
  || tdie "stop_wine_for_prefix called wineserver with the wrong prefix/args"

tsay "start_wine_reaper invokes wineserver -k after the watched process exits"
: >"$QSYS_FAKE_WINESERVER_LOG"
sleep 0.2 &
watched=$!
start_wine_reaper "$watched"
wait "$watched" || true
wait_for_log_count 1 "$QSYS_FAKE_WINESERVER_LOG" "start_wine_reaper"
grep -F "${WINEPREFIX}"$'\t''-k' "$QSYS_FAKE_WINESERVER_LOG" >/dev/null \
  || tdie "start_wine_reaper called wineserver with the wrong prefix/args"

tsay "kill_process_tree kills a wrapper shell and its grandchild"
token="qsys-tree-kill-test-$$-$RANDOM"
TOKENS+=("$token")
bash -c 'bash -c '\''exec /usr/bin/yes "$1" >/dev/null'\'' _ "$1" & wait' _ "$token" &
root_pid=$!
sleep 0.5
[ -n "$(pids_matching_token "$token")" ] || tdie "tree-kill fixture did not start"
run_filtering_intentional_terms kill_process_tree "$root_pid"
wait "$root_pid" 2>/dev/null || true
sleep 1
assert_no_token_processes "$token"

tsay "run_dotnet_installer timeout does not orphan a Wine child"
token="qsys-dotnet-timeout-test-$$-$RANDOM"
TOKENS+=("$token")
old_wine="$WINE"
old_timeout="$DOTNET_INSTALL_TIMEOUT_SECONDS"
WINE=/usr/bin/yes
DOTNET_INSTALL_TIMEOUT_SECONDS=1
set +e
run_filtering_intentional_terms run_dotnet_installer "Harness" "$token"
rc=$?
set -e
WINE="$old_wine"
DOTNET_INSTALL_TIMEOUT_SECONDS="$old_timeout"
[ "$rc" -eq 124 ] || tdie "run_dotnet_installer returned $rc, expected timeout 124"
sleep 1
assert_no_token_processes "$token"

tsay "all process cleanup checks passed"
