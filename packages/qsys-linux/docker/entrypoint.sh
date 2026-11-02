#!/bin/bash
# Supervise a private authenticated desktop and one process group. --init is
# recommended so orphaned Wine/CEF children are also reaped by the container.
set -Eeuo pipefail
umask 077

fail() { echo "[qsys-docker] $*" >&2; exit 1; }
mode=${1:-check}
if (($#)); then shift; fi
case "$mode" in
    check) (($# == 0)) || fail 'check takes no arguments' ;;
    smoke) ;;
    exec) (($# > 0)) || fail 'exec requires a command' ;;
    *) fail 'usage: check | smoke [args...] | exec <argv...>' ;;
esac
[[ $(id -u) == 1000 && $(id -g) == 1000 ]] || fail 'run as image user 1000:1000'
export HOME=/home/qsys USER=qsys XDG_DATA_HOME=/work
export TMPDIR=${TMPDIR:-/work/tmp}
export DISPLAY=${DISPLAY:-:99}
[[ $DISPLAY =~ ^:[0-9]+$ ]] || fail 'DISPLAY must be a private local display (:number)'
screen=${QSYS_SCREEN:-1920x1200x24}
[[ $screen =~ ^[0-9]+x[0-9]+x24$ ]] || fail 'QSYS_SCREEN must be WIDTHxHEIGHTx24'
export LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe
unset WAYLAND_DISPLAY
mkdir -p "$TMPDIR" /work/qsys-designer /cache /artifacts
for directory in "$HOME" "$TMPDIR" /work /cache /artifacts; do
    [[ -w $directory ]] || fail "not writable: $directory (use owned volumes)"
done
runtime=$(mktemp -d "$TMPDIR/desktop.XXXXXXXX")
export XAUTHORITY="$runtime/Xauthority" XDG_RUNTIME_DIR="$runtime"
xvfb_pid= wm_pid= child_pid=
cleanup() {
    status=$?
    trap - EXIT
    trap '' TERM INT HUP
    # Only our process groups; never pkill a global Wine/display process.
    for pid in "$child_pid" "$wm_pid" "$xvfb_pid"; do
        if [[ -n $pid ]]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
    done
    # Bound cleanup even if Wine ignores TERM.
    for attempt in {1..240}; do
        alive=0
        for pid in "$child_pid" "$wm_pid" "$xvfb_pid"; do
            if [[ -n $pid ]] && kill -0 -- "-$pid" 2>/dev/null; then alive=1; fi
        done
        ((alive)) || break
        sleep 0.1
    done
    for pid in "$child_pid" "$wm_pid" "$xvfb_pid"; do
        if [[ -n $pid ]]; then kill -KILL -- "-$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
    done
    rm -rf "$runtime"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

touch "$XAUTHORITY"
cookie=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
xauth -f "$XAUTHORITY" add "$DISPLAY" MIT-MAGIC-COOKIE-1 "$cookie"
setsid Xvfb "$DISPLAY" -screen 0 "$screen" -dpi 96 -auth "$XAUTHORITY" -nolisten tcp -noreset \
    > /artifacts/xvfb.log 2>&1 &
xvfb_pid=$!
ready=0
for attempt in {1..100}; do
    kill -0 "$xvfb_pid" 2>/dev/null || fail 'Xvfb exited (see /artifacts/xvfb.log)'
    if xdpyinfo >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.1
done
((ready)) || fail 'Xvfb readiness timeout'
xset s off
xset s noblank
xset -dpms 2>/dev/null || true
setsid openbox --sm-disable > /artifacts/openbox.log 2>&1 &
wm_pid=$!
ready=0
for attempt in {1..100}; do
    kill -0 "$wm_pid" 2>/dev/null || fail 'Openbox exited (see /artifacts/openbox.log)'
    if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x'; then ready=1; break; fi
    sleep 0.1
done
((ready)) || fail 'Openbox readiness timeout'

check_runtime() {
    qsys-linux --help
    for executable in python3 node apt-get dpkg-deb bsdtar ldd 7z msiinfo wrestool \
                      xdotool xclip xdpyinfo xprop xwininfo scrot import fc-match; do
        command -v "$executable" >/dev/null || return 1
    done
    test -r /opt/qsys-test/smoke.py
    test -r /opt/qsys-test/qrc-smoke.mjs
    test -r /opt/qsys-test/execution.py
    test -r /opt/qsys-test/compatibility.json
    test -r /opt/qsys-test/qemu-pin.json
    test -r /opt/qsys-test/wine-procmem.so
    test -x /opt/qsys-test/shims/qsys-linux
    test -x /opt/qsys-test/shims/dpkg-deb
    [[ $(command -v dpkg-deb) == /usr/local/bin/dpkg-deb ]] || return 1
    for immutable in /usr/local /usr/local/bin /usr/local/lib \
                     /usr/local/lib/node_modules /opt/qsys-test \
                     /usr/local/bin/node /usr/local/bin/dpkg-deb \
                     /usr/local/lib/node_modules/qsys-linux; do
        [[ $(stat -c '%u' "$immutable") == 0 && ! -w $immutable ]] || return 1
    done
    test -r /usr/local/lib/node_modules/qsys-linux/lib/support/assemble-msi.py
    test -n "$(find /usr/local/lib/node_modules/qsys-linux/lib/support/fonts -name '*.ttf' -print -quit)"
    fc-match -f '%{family}\n' Selawik | grep -qx Selawik
    echo 'Selawik font available'
    (cd /opt/qsys-test && node --input-type=module -e 'await import("qsys-qrc")')
    # A second unauthenticated client must be refused; otherwise this is not a
    # successful authenticated desktop check.
    if XAUTHORITY=/dev/null xdpyinfo >/dev/null 2>&1; then
        echo 'X server unexpectedly accepted an unauthenticated client' >&2
        return 1
    fi
    echo '[qsys-docker] runtime check passed (no vendor application tested)'
}
case "$mode" in
    check) check_runtime; exit $? ;;
    smoke) command=(python3 /opt/qsys-test/execution.py "$@") ;;
    exec) command=("$@") ;;
esac
setsid "${command[@]}" &
child_pid=$!
# A desktop failure while the command is running is a failing run too.
set +e
wait -n -p finished "$child_pid" "$xvfb_pid" "$wm_pid"
status=$?
set -e
if [[ $finished != "$child_pid" ]]; then
    fail 'desktop exited while command was running (see /artifacts desktop logs)'
fi
exit "$status"
