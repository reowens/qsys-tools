#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# Update the external Homebrew tap cask from the just-built installer DMG.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DMG="${DMG:-$ROOT/dist/qsys-mac-installer.dmg}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/app/Info.plist")"
TAP="${1:-${QSYS_HOMEBREW_TAP:-}}"

say() { printf '\033[1;36m[brew-cask]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[brew-cask] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$DMG" ] || die "DMG not found: $DMG (run scripts/package.sh first, or set DMG=/path/to/qsys-mac-installer.dmg)"

if [ -z "$TAP" ]; then
  if [ -d "$ROOT/../../../homebrew-qsys/.git" ]; then
    TAP="$(cd "$ROOT/../../../homebrew-qsys" && pwd)"
  elif command -v brew >/dev/null 2>&1 && TAP="$(brew --repo reowens/qsys 2>/dev/null)"; then
    :
  else
    die "Homebrew tap checkout not found. Pass /path/to/homebrew-qsys or set QSYS_HOMEBREW_TAP."
  fi
fi

CASK="$TAP/Casks/qsys-mac-installer.rb"
[ -f "$CASK" ] || die "cask not found: $CASK"

SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
[ -n "$SHA" ] || die "could not compute SHA-256 for $DMG"

/usr/bin/perl -0pi -e \
  's/version "[^"]+"/version "'$VERSION'"/; s/sha256 "[a-f0-9]+"/sha256 "'$SHA'"/' \
  "$CASK"

grep -F "version \"$VERSION\"" "$CASK" >/dev/null || die "failed to set version in $CASK"
grep -F "sha256 \"$SHA\"" "$CASK" >/dev/null || die "failed to set sha256 in $CASK"

say "updated $CASK"
say "version: $VERSION"
say "sha256 : $SHA"
say "next: git -C '$TAP' diff -- Casks/qsys-mac-installer.rb"
say "next: brew audit --cask --online qsys-mac-installer"
