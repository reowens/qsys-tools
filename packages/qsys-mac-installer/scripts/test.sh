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
