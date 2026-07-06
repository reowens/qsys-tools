#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Owens
# bundle-deps.sh — Phase 3 (Tier B) build-time step. Populates app/Resources/{bin,cache}
# with everything first-run provisioning needs so the user's machine needs NO network and
# NO developer toolchain (no brew / clang / python3 / otool). Run once before xcodebuild;
# idempotent + cached (skips work already done). Ships only LGPL/MIT-redistributable bytes
# (Wine, .NET runtimes, p7zip, icoutils, libpng) + our own compiled shims. Zero QSC bytes.
#
#   scripts/bundle-deps.sh            # build the bundle (uses cached downloads if present)
#   FORCE=1 scripts/bundle-deps.sh    # rebuild everything from scratch
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
BIN="$HERE/app/Resources/bin"
CACHE_OUT="$HERE/app/Resources/cache"

# Pinned URLs + helpers come from the recipe — one source of truth for versions.
# shellcheck source=lib/recipe.sh
source "$HERE/lib/recipe.sh"

[ "$(uname -s)" = "Darwin" ] || die "macOS only (this bundles macOS-native tools)."
command -v install_name_tool >/dev/null 2>&1 || die "install_name_tool missing — install Command Line Tools (build machine only)."
command -v clang   >/dev/null 2>&1 || die "clang missing — needed to pre-compile the shims (build machine only)."
command -v python3 >/dev/null 2>&1 || die "python3 missing — needed to pre-patch the loader (build machine only)."

mkdir -p "$BIN" "$CACHE_OUT"

# ----------------------------------------------------------------------------
# 1. Offline deps cache: Wine tarball + the two .NET installers. Reuse the
#    developer cache (APFS clonefile → ~free) if present, else download pinned.
# ----------------------------------------------------------------------------
fetch() {  # $1 = url  $2 = expected sha256
  local url="$1" want="$2" name dst src
  name="$(basename "$url")"; dst="$CACHE_OUT/$name"; src="$CACHE/$name"
  if [ -f "$dst" ] && [ -z "${FORCE:-}" ]; then say "cache ✓ $name"
  elif [ -f "$src" ]; then say "cache ← $name (clonefile from $CACHE)"; cp -c "$src" "$dst" 2>/dev/null || cp "$src" "$dst"
  else say "cache ↓ $name"; curl -fL --progress-bar -o "$dst" "$url" || die "download failed: $url"; fi
  # Verify on ALL paths — a reused or clonefile'd cache gets the same integrity check as a
  # fresh download, so the bundle is only ever built from known-good bytes.
  verify_sha256 "$dst" "$want" "$name"
}
fetch "$WINE_URL"           "$WINE_SHA256"
fetch "$DOTNET_DESKTOP_URL" "$DOTNET_DESKTOP_SHA256"
fetch "$DOTNET_ASPNET_URL"  "$DOTNET_ASPNET_SHA256"

# ----------------------------------------------------------------------------
# 2. CLI tools the recipe shells out to. End-user machines have no Homebrew, so
#    copy the binaries + their non-system dylibs and rewrite absolute Homebrew
#    paths to @loader_path so they resolve from Resources/bin. Re-sign anything
#    we mutate (changing a load command invalidates the signature).
# ----------------------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "$1 missing on the build machine (brew install p7zip icoutils)."; }
need 7z; need wrestool; need icotool

# p7zip: the `7z` front-end dlopens `7z.so` from its OWN directory → ship both together.
# (Both link only system frameworks — verified — so no extra dylibs.) Homebrew's `7z` on
# PATH is a one-line shell wrapper pointing at the real binary in lib/p7zip/ — resolve it.
P7WRAP="$(command -v 7z)"
P7REAL="$(sed -nE 's/^[^"]*"([^"]+)".*/\1/p' "$P7WRAP" 2>/dev/null | head -1)"
if [ -z "$P7REAL" ] || [ ! -f "$P7REAL" ]; then P7REAL="$P7WRAP"; fi   # not a wrapper → use as-is
P7LIB="$(dirname "$P7REAL")"
[ -f "$P7LIB/7z.so" ] || die "7z.so not next to the 7z binary ($P7LIB) — unexpected p7zip layout."
say "tool ← 7z (self-locating wrapper) + 7z.bin + 7z.so ($P7LIB)"
cp -f "$P7REAL" "$BIN/7z.bin"
cp -f "$P7LIB/7z.so" "$BIN/7z.so"
# p7zip's front-end finds its plugin (7z.so, internally "7z.dll") from argv[0]'s directory —
# but ONLY when argv[0] carries a path. Invoked as bare `7z` via PATH (argv[0]="7z", no slash)
# it falls back to ./7z.dll relative to CWD and dies ("cannot find the code that works with
# archives"). Homebrew sidesteps this with a wrapper that calls the real binary by absolute
# path; mirror that, self-locating so it resolves wherever the .app lands.
rm -f "$BIN/7z"   # a prior run may have left the raw binary here (mode 555 → can't truncate)
cat > "$BIN/7z" <<'WRAP'
#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/7z.bin" "$@"
WRAP
chmod +x "$BIN/7z"

# icoutils: wrestool links only libSystem; icotool links Homebrew libpng16 → bundle libpng
# and point icotool at it via @loader_path.
say "tool ← wrestool"
cp -f "$(command -v wrestool)" "$BIN/wrestool"
say "tool ← icotool (+ libpng16)"
cp -f "$(command -v icotool)" "$BIN/icotool"
PNG="$(otool -L "$BIN/icotool" | awk '/libpng16.*\.dylib/{print $1; exit}')"
[ -n "$PNG" ] && [ -f "$PNG" ] || die "could not locate libpng16 for icotool ($PNG)."
cp -f "$PNG" "$BIN/libpng16.16.dylib"
chmod u+w "$BIN/libpng16.16.dylib" "$BIN/icotool"
install_name_tool -change "$PNG" "@loader_path/libpng16.16.dylib" "$BIN/icotool"
codesign --force -s - "$BIN/libpng16.16.dylib" >/dev/null 2>&1 || true
codesign --force -s - "$BIN/icotool"            >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------
# 3. Pre-compile the in-process shims (universal: arm64 native + the x86_64 slice
#    Wine needs under Rosetta). End-user machines have no clang.
# ----------------------------------------------------------------------------
say "shim ← appmenu.dylib (universal)"
clang -arch x86_64 -arch arm64 -dynamiclib -framework Cocoa -fobjc-arc \
  -mmacosx-version-min=11.0 -o "$BIN/appmenu.dylib" "$RECIPE_DIR/appmenu.m"
codesign --force -s - "$BIN/appmenu.dylib" >/dev/null 2>&1 || true

say "helper ← iconpad (universal)"
clang -arch x86_64 -arch arm64 -framework Cocoa -fobjc-arc \
  -mmacosx-version-min=11.0 -o "$BIN/iconpad" "$RECIPE_DIR/icon-pad.m"
codesign --force -s - "$BIN/iconpad" >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------
# 4. Pre-patch the Wine unix loader's embedded CFBundleName (the bold menu-bar
#    name). The bundled tarball is pinned → its loader bytes are deterministic,
#    so this build-time patched copy is byte-correct for the loader the user will
#    extract. The recipe drops it in place at provision time (no python3/otool).
# ----------------------------------------------------------------------------
say "loader ← pre-patching embedded plist name → $APP_NAME"
LP_REL="Wine Staging.app/Contents/Resources/wine/lib/wine/x86_64-unix/wine"
TMP="$(mktemp -d)"
tar -xJf "$CACHE_OUT/$(basename "$WINE_URL")" -C "$TMP" "$LP_REL" || die "could not extract loader from the bundled tarball."
python3 "$RECIPE_DIR/patch-loader-plist.py" "$TMP/$LP_REL" "$APP_NAME" "com.byo.qsys-designer-wine" \
  || die "loader pre-patch failed (plist didn't fit?)."
cp -f "$TMP/$LP_REL" "$BIN/wine-loader-prepatched"
codesign --force -s - "$BIN/wine-loader-prepatched" >/dev/null 2>&1 || true
rm -rf "$TMP"

# ----------------------------------------------------------------------------
say "Bundle ready:"
du -sh "$CACHE_OUT" "$BIN" 2>/dev/null | sed 's/^/    /'
say "Next: xcodegen generate --spec app/project.yml --project app && xcodebuild …"
