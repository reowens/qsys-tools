#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Owens
# Compare Python and native MSI assemblers against the same extracted installer.
# This is a derisking harness; it does not change provisioning defaults.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/app/Resources/bin"
INSTALLER="${1:-}"

say() { printf '\033[1;36m[compare]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[compare] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$INSTALLER" ] || die "usage: scripts/compare-assemble-msi.sh <Q-SYS Designer Installer*.exe>"
[ -f "$INSTALLER" ] || die "installer not found: $INSTALLER"
[ -x "$BIN/qsys-assemble-msi" ] || die "native helper missing: $BIN/qsys-assemble-msi (run scripts/bundle-deps.sh)"
command -v python3 >/dev/null 2>&1 || die "python3 missing"

SEVENZ="$BIN/7z"
[ -x "$SEVENZ" ] || SEVENZ="$(command -v 7z || true)"
[ -n "$SEVENZ" ] || die "7z missing"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
EXTRACT="$TMP/extract"
PY_OUT="$TMP/python"
NATIVE_OUT="$TMP/native"
mkdir -p "$EXTRACT" "$PY_OUT" "$NATIVE_OUT"

say "extracting installer"
"$SEVENZ" x -y -o"$EXTRACT" "$INSTALLER" >/dev/null
MSI="$(find "$EXTRACT" -maxdepth 1 -iname '*.msi' -print -quit 2>/dev/null)"
[ -n "$MSI" ] && [ -f "$MSI" ] || die "installer MSI not found under $EXTRACT"

say "running Python assembler"
PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  python3 "$ROOT/lib/assemble-msi.py" "$MSI" "$EXTRACT" "$PY_OUT"

say "running native assembler"
PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin" \
  "$BIN/qsys-assemble-msi" "$MSI" "$EXTRACT" "$NATIVE_OUT"

manifest() {
  local dir="$1"
  (cd "$dir" && find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    local rel="${file#./}" hash size
    hash="$(shasum -a 256 "$file" | awk '{print $1}')"
    size="$(stat -f%z "$file")"
    printf '%s\t%s\t%s\n' "$hash" "$size" "$rel"
  done)
}

manifest "$PY_OUT" > "$TMP/python.manifest"
manifest "$NATIVE_OUT" > "$TMP/native.manifest"

say "comparing manifests"
if ! diff -u "$TMP/python.manifest" "$TMP/native.manifest"; then
  die "native assembler output differs from Python output"
fi

count="$(wc -l < "$TMP/native.manifest" | tr -d ' ')"
luax="$(grep -ci '\.luax$' "$TMP/native.manifest" || true)"
[ "$luax" -gt 0 ] || die "native output has no .luax component definitions"
say "match: $count files ($luax .luax component defs)"
