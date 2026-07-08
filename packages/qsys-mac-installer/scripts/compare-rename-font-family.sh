#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# Compare Python and native font-family renamers across the bundled Selawik fonts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/app/Resources/bin"
FONT_DIR="${1:-$ROOT/assets/fonts/selawik}"

say() { printf '\033[1;36m[font-compare]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[font-compare] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$FONT_DIR" ] || die "font dir not found: $FONT_DIR"
[ -x "$BIN/qsys-rename-font-family" ] || die "native helper missing: $BIN/qsys-rename-font-family (run scripts/bundle-deps.sh)"
command -v python3 >/dev/null 2>&1 || die "python3 missing"

shopt -s nullglob
fonts=("$FONT_DIR"/*.ttf)
[ "${#fonts[@]}" -gt 0 ] || die "no .ttf fonts found in $FONT_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

count=0
for font in "${fonts[@]}"; do
  base="$(basename "$font")"
  py="$TMP/python-$base"
  native="$TMP/native-$base"
  say "checking $base"
  python3 "$ROOT/lib/rename-font-family.py" "$font" "$py" "Selawik" "Segoe UI" >/dev/null
  "$BIN/qsys-rename-font-family" "$font" "$native" "Selawik" "Segoe UI" >/dev/null
  if ! cmp -s "$py" "$native"; then
    shasum -a 256 "$py" "$native" >&2 || true
    die "native output differs from Python output for $base"
  fi
  count=$((count + 1))
done

say "match: $count font(s)"
