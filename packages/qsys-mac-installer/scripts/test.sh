#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# Local validation for the Q-SYS Designer macOS wrapper.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
DERIVED_DATA="$ROOT/app/build/DerivedData"

say() { printf '\033[1;36m[test]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[test] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

say "checking shell syntax"
bash -n \
  "$ROOT/lib/recipe.sh" \
  "$ROOT/provision.sh" \
  "$ROOT/build.sh" \
  "$ROOT/launch.sh" \
  "$ROOT/qsys-mac" \
  "$ROOT/scripts/smoke-provision.sh" \
  "$ROOT/scripts/test-process-cleanup.sh" \
  "$ROOT/scripts/test.sh" \
  "$ROOT/scripts/update-homebrew-cask.sh"

say "checking Designer launch-path WINEDLLOVERRIDES parity"
# Every Designer launch path must set the same load-bearing overrides: mshtml=d (mscoree ON,
# off breaks the managed loader) and mountmgr.sys=d (stops the /Volumes raw-device scan).
# Three paths: launch.sh (dev), recipe.sh emit_app (generated .app), DataDir.swift (installed GUI).
for pair in \
  "$ROOT/launch.sh:WINEDLLOVERRIDES=\"mshtml=d;mountmgr.sys=d\"" \
  "$ROOT/lib/recipe.sh:WINEDLLOVERRIDES=\"mshtml=d;mountmgr.sys=d\"" \
  "$ROOT/app/Sources/Shared/DataDir.swift:env\[\"WINEDLLOVERRIDES\"\] = \"mshtml=d;mountmgr.sys=d\""; do
  file="${pair%%:*}"; pattern="${pair#*:}"
  grep -q "$pattern" "$file" || die "launch-path override drift: expected '$pattern' in $file"
done

say "checking MSI path-containment guard (malicious-table fixtures)"
# Drives assemble-msi.py's safe_join with hostile MSI-style paths. The Swift
# assembler mirrors the same rules (safeJoin) and is proven equivalent against
# real installers by compare-assemble-msi.sh.
python3 - "$ROOT/lib/assemble-msi.py" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("am", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

root = "/tmp/qsys-guard-root"
# Benign shapes must pass and stay under root.
for child in ("a.txt", "dir/sub/a.txt", "dir//a.txt", "weird..name/..file"):
    joined = m.safe_join(root, child)
    assert joined == root or joined.startswith(root + "/"), (child, joined)
# Hostile shapes must abort the assembly (SystemExit).
for child in ("../a.txt", "dir/../../a.txt", "/etc/passwd", "..", "a/../..", "../../../../tmp/x"):
    try:
        m.safe_join(root, child)
    except SystemExit:
        pass
    else:
        raise AssertionError(f"hostile path accepted: {child!r}")
print("ok: safe_join rejects absolute/parent-relative MSI paths, accepts benign ones")
PY

if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  say "checking diff whitespace"
  git -C "$REPO" diff --check -- packages/qsys-mac-installer
fi

say "checking headless-SSH pre-flight probe"
# is_headless_ssh() must fire ONLY on SSH + an unowned GUI console (/dev/console == root), and
# QSYS_ASSUME_GUI=1 must force past it. Mock the console owner via a PATH `stat` shim and vary
# SSH_CONNECTION so the check is hermetic (no real session/console needed).
(
  # shellcheck source=../lib/recipe.sh
  source "$ROOT/lib/recipe.sh"
  shim="$(mktemp -d)"
  trap 'rm -rf "$shim"' EXIT
  export PATH="$shim:$PATH"
  console_owner() { printf '#!/bin/bash\necho %s\n' "$1" > "$shim/stat"; chmod +x "$shim/stat"; }
  # subshell body so the per-case env never leaks to the next case
  probe() ( export SSH_CONNECTION="$1" SSH_TTY="" QSYS_ASSUME_GUI="$2"; is_headless_ssh )

  console_owner root
  probe "1.2.3.4 5 22 22" 0 || die "probe missed a headless SSH session (SSH + console=root)"
  if probe "" 0;                then die "probe fired on a local (non-SSH) session"; fi
  console_owner someuser
  if probe "1.2.3.4 5 22 22" 0; then die "probe fired when a user owns the GUI console (e.g. screen sharing)"; fi
  console_owner root
  if probe "1.2.3.4 5 22 22" 1; then die "QSYS_ASSUME_GUI=1 did not override the probe"; fi
)
say "  ok: probe fires only on SSH + unowned console, honors QSYS_ASSUME_GUI"

say "checking loopback probe (qsys-mac doctor)"
# loopback_status() must never cry wolf: "BLOCKED" is only legitimate when a listener was
# demonstrably in LISTEN and the connect still failed. Two traps this guards against —
# (1) `nc -l` LINGERS instead of exiting when the port is already taken, so process-alive is
# not a bind test; (2) if the probe itself can't run, that is inconclusive, not a firewall
# problem. Hermetic: shims lsof rather than needing a real firewall.
(
  # shellcheck source=../qsys-mac
  # Pull in just the function — running the helper would execute a command.
  eval "$(sed -n '/^loopback_status()/,/^}/p' "$ROOT/qsys-mac")"
  shim="$(mktemp -d)"
  trap 'rm -rf "$shim"' EXIT

  out="$(loopback_status)"
  case "$out" in
    ok*) ;;
    *) die "loopback probe did not report ok on a machine with working loopback (got: $out)" ;;
  esac

  # Ports already occupied: loopback still demonstrably works, so this must stay "ok" —
  # a busy port is not evidence of blocking.
  # disown so bash's job control doesn't print "Terminated: 15" when we reap them — that
  # noise reads like a test failure in CI output.
  for p in 49731 49732 49733; do /usr/bin/nc -l 127.0.0.1 "$p" >/dev/null 2>&1 & disown; done
  sleep 0.5
  out="$(loopback_status)"
  pkill -f "nc -l 127.0.0.1 4973" >/dev/null 2>&1 || true
  case "$out" in
    ok*) ;;
    *) die "loopback probe mis-reported busy probe ports as a firewall block (got: $out)" ;;
  esac

  # Probe cannot confirm a listener → must be inconclusive, never BLOCKED.
  printf '#!/bin/bash\nexit 1\n' > "$shim/lsof"; chmod +x "$shim/lsof"
  out="$(PATH="$shim:$PATH"; eval "$(sed -n '/^loopback_status()/,/^}/p' "$ROOT/qsys-mac" | sed 's|/usr/sbin/lsof|lsof|')"; loopback_status)"
  case "$out" in
    inconclusive*) ;;
    *) die "loopback probe should be inconclusive when no listener can be confirmed (got: $out)" ;;
  esac
)
say "  ok: probe reports ok/inconclusive correctly and never false-blocks"

say "checking process cleanup harness"
"$ROOT/scripts/test-process-cleanup.sh"

if [ "${QSYS_SKIP_XCODE:-0}" = "1" ]; then
  say "skipping Xcode build (QSYS_SKIP_XCODE=1)"
else
  command -v xcodegen >/dev/null 2>&1 || die "xcodegen not found"
  command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found"

  say "generating Xcode project"
  xcodegen generate --spec "$ROOT/app/project.yml" --project "$ROOT/app"

  say "building Launcher"
  xcodebuild -quiet \
    -project "$ROOT/app/QSYSDesigner.xcodeproj" \
    -scheme Launcher \
    -configuration Debug \
    -derivedDataPath "$DERIVED_DATA" \
    build

  say "building Installer"
  xcodebuild -quiet \
    -project "$ROOT/app/QSYSDesigner.xcodeproj" \
    -scheme Installer \
    -configuration Debug \
    -derivedDataPath "$DERIVED_DATA" \
    build
fi

say "all checks passed"
