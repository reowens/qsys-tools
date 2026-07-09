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
