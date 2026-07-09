#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# package.sh — build, sign, notarize, staple the two-bundle Q-SYS Mac Installer + .dmg.
#
# Two bundles ship in one notarized dmg:
#   • Launcher  "Q-SYS Designer.app"          — DevID-signed + hardened runtime so the installer
#                can notarize the nested code. Embedded in the installer's Resources. At INSTALL
#                time the installer copies it to /Applications, bakes the user-extracted QSC icon
#                into Contents/Resources, and ad-hoc re-signs it (Emit.swift) — so the emitted
#                app is ad-hoc but locally-created (not quarantined → Gatekeeper opens it).
#   • Installer "Q-SYS Mac Installer.app"    — setup UI + recipe Resources (provision.sh, lib,
#                Resources/bin toolchain, Resources/cache Wine+.NET) + the embedded launcher.
#                Signed inner→outer WITHOUT --deep (so the nested launcher's signature survives),
#                notarized, stapled, then wrapped in a dmg that's itself signed + notarized.
#
# Wine is NOT in either bundle — it ships as a tarball in Resources/cache and is extracted +
# ad-hoc-signed into ~/Library/Application Support at PROVISION time, outside notarization.
#
# Credentials — supplied at run time; nothing here is committed:
#   DEV_ID          "Developer ID Application: Robert Owens (7GSPYYN5X8)"  (name or 40-char hash)
#                   Default "-" = ad-hoc → a DRY run that proves build+embed+sign+dmg without a cert.
#   NOTARY_PROFILE  a stored `xcrun notarytool store-credentials <name>` profile. Unset = sign-only.
#
# Prereq: run scripts/bundle-deps.sh once to populate app/Resources/{bin,cache}.
#
# Usage:
#   scripts/package.sh                                  # dry: build + ad-hoc sign + unsigned dmg
#   DEV_ID="Developer ID Application: … (7GSPYYN5X8)" \
#     NOTARY_PROFILE=qsys-notary  scripts/package.sh    # real: sign + notarize + staple + dmg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPDIR="$ROOT/app"
PROJ="$APPDIR/QSYSDesigner.xcodeproj"
ENTITLEMENTS="${ENTITLEMENTS:-$APPDIR/QSYSDesigner.entitlements}"            # launcher/Wine: JIT/W^X/no-libval
INSTALLER_ENTITLEMENTS="${INSTALLER_ENTITLEMENTS:-$APPDIR/Installer.entitlements}"  # installer: minimal (A6)
DEV_ID="${DEV_ID:--}"                       # "-" = ad-hoc (dry run)
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
TEAM_ID="${TEAM_ID:-7GSPYYN5X8}"
DIST="${DIST:-$ROOT/dist}"
BUILD="$APPDIR/app/build"                    # gitignored build output (matches the dev convention)
LAUNCHER="$BUILD/launcher/Q-SYS Designer.app"
INSTALLER="$BUILD/installer/Q-SYS Mac Installer.app"
VOL="Q-SYS Mac Installer"
DMG="$DIST/qsys-mac-installer.dmg"

say()  { printf '\033[1;36m[pkg]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pkg] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[pkg] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$ENTITLEMENTS" ] || die "Entitlements not found: $ENTITLEMENTS"
[ -f "$INSTALLER_ENTITLEMENTS" ] || die "Installer entitlements not found: $INSTALLER_ENTITLEMENTS"
[ -d "$APPDIR/Resources/bin" ] && [ -d "$APPDIR/Resources/cache" ] \
  || die "app/Resources/{bin,cache} missing — run scripts/bundle-deps.sh first."
command -v xcodegen >/dev/null 2>&1 || die "xcodegen not found (brew install xcodegen)."

REAL=0
if [ "$DEV_ID" != "-" ]; then
  REAL=1
  security find-identity -v -p codesigning 2>/dev/null | grep -qF "$DEV_ID" \
    || die "Signing identity not in keychain: '$DEV_ID'. Create a *Developer ID Application* cert under team $TEAM_ID."
fi
[ "$REAL" -eq 1 ] || warn "DRY RUN (ad-hoc, no timestamp, no notarize) — proves build+embed+sign+dmg only."

# --- timestamp + hardened runtime only apply to a real Developer ID signature ---
TS=(); RT=()
if [ "$REAL" -eq 1 ]; then TS=(--timestamp); RT=(--options runtime); fi

sign_lib()  { codesign --force ${RT[@]+"${RT[@]}"} ${TS[@]+"${TS[@]}"} -s "$DEV_ID" "$1"; }                                # dylib/.so: hardened runtime, no entitlements
sign_tool() { codesign --force ${RT[@]+"${RT[@]}"} ${TS[@]+"${TS[@]}"} -s "$DEV_ID" "$1"; }                                # bundled CLI tool (7z/wrestool/icotool/iconpad/loader template): hardened runtime for notarization, but NO JIT/W^X/library-validation entitlements — they need none, and disable-library-validation here is needless attack surface (same-team @loader_path dylibs already pass LV under Developer ID)
sign_exec() { codesign --force ${RT[@]+"${RT[@]}"} ${TS[@]+"${TS[@]}"} --entitlements "$2" -s "$DEV_ID" "$1"; }              # an app process — $2 = its entitlements (launcher: Wine's JIT/W^X/no-libval; installer: minimal, A6)
is_macho()  { file "$1" 2>/dev/null | grep -q "Mach-O"; }

# Submit to Apple notary and FAIL unless the result is explicitly "Accepted" (A11). The exit code of
# `notarytool submit --wait` alone is unreliable across toolchains — it has shipped versions that
# return 0 on an Invalid result — so we capture the output and assert the status line. $1 = artifact,
# $2 = human label.
notarize() {
  local artifact="$1" label="$2" out
  out="$(xcrun notarytool submit "$artifact" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)" \
    || { printf '%s\n' "$out" | sed 's/^/  /'; die "$label notarization submit failed."; }
  printf '%s\n' "$out" | sed 's/^/  /'
  printf '%s\n' "$out" | grep -qE '[[:space:]]status:[[:space:]]+Accepted([[:space:]]|$)' \
    || die "$label notarization was NOT Accepted — inspect: xcrun notarytool log <submission-id> --keychain-profile $NOTARY_PROFILE"
}

# --- build both targets (ad-hoc; package.sh re-signs below) ---
# Strip any Python bytecode cache first so it can't ride into the notarized bundle via the lib/
# folder-reference Resource (A18) — __pycache__ is build-host detritus from importing
# patch-loader-plist.py, not something the shipped app ever runs.
find "$ROOT/lib" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$ROOT/lib" -name '*.pyc' -delete 2>/dev/null || true
say "Generating project + building both targets…"
xcodegen generate --spec "$APPDIR/project.yml" --project "$APPDIR" >/dev/null
mkdir -p "$BUILD"
rm -rf "$BUILD/launcher" "$BUILD/installer" "$BUILD/DerivedData"
for t in Launcher Installer; do
  out="$BUILD/$(echo "$t" | tr '[:upper:]' '[:lower:]')"
  xcodebuild -project "$PROJ" -scheme "$t" -configuration Release \
    -derivedDataPath "$BUILD/DerivedData" \
    CONFIGURATION_BUILD_DIR="$out" CODE_SIGN_IDENTITY="-" build >"$BUILD/$t.log" 2>&1 \
    || { tail -30 "$BUILD/$t.log"; die "$t build failed (see $BUILD/$t.log)."; }
  say "  built $t"
done
[ -d "$LAUNCHER" ]  || die "Launcher build missing: $LAUNCHER"
[ -d "$INSTALLER" ] || die "Installer build missing: $INSTALLER"

# --- Step A: sign the Launcher (DevID + hardened runtime → the installer can notarize it) ---
say "Signing the Launcher (for the installer's notarization)…"
sign_exec "$LAUNCHER" "$ENTITLEMENTS"   # simple bundle, no nested Mach-O — one wrapper sign carries the JIT/W^X/no-libval set
codesign --verify --strict --verbose=2 "$LAUNCHER" 2>&1 | sed 's/^/  /' \
  || warn "launcher verify issues (expected under ad-hoc dry run)."

# --- Step B: embed the signed Launcher into the Installer's Resources (BEFORE signing it) ---
say "Embedding the Launcher into the Installer…"
rm -rf "$INSTALLER/Contents/Resources/Launcher.app"
/usr/bin/ditto "$LAUNCHER" "$INSTALLER/Contents/Resources/Launcher.app"

# --- Step C: sign the Installer inner → outer, NEVER --deep (preserve the nested launcher) ---
say "Deep-signing the Installer inner → outer (no --deep over the nested launcher)…"
shopt -s nullglob
for f in "$INSTALLER"/Contents/Resources/bin/*; do
  [ -f "$f" ] && is_macho "$f" || continue
  case "$f" in
    *.dylib|*.so) sign_lib  "$f"; say "  lib  $(basename "$f")" ;;
    *)            sign_tool "$f"; say "  tool $(basename "$f")" ;;   # CLI tools: no app entitlements (see sign_tool)
  esac
done
MAIN="$INSTALLER/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INSTALLER/Contents/Info.plist")"
[ -f "$MAIN" ] && { sign_exec "$MAIN" "$INSTALLER_ENTITLEMENTS"; say "  exec $(basename "$MAIN") (installer, minimal entitlements)"; }
codesign --force ${RT[@]+"${RT[@]}"} ${TS[@]+"${TS[@]}"} --entitlements "$INSTALLER_ENTITLEMENTS" -s "$DEV_ID" "$INSTALLER"  # NO --deep (preserve nested launcher's JIT sig); installer itself = minimal (A6)
say "  app  $(basename "$INSTALLER")"

# --- gates: the nested launcher must survive the outer sign ---
say "Verifying signatures (the nested launcher must still be valid)…"
codesign --verify --strict "$INSTALLER/Contents/Resources/Launcher.app" 2>&1 | sed 's/^/  nested: /' \
  || warn "nested launcher verify issues (expected under ad-hoc dry run)."
codesign --verify --deep --strict "$INSTALLER" 2>&1 | sed 's/^/  installer: /' \
  || warn "installer verify issues (expected under ad-hoc dry run)."

# --- Step D: notarize + staple the Installer (real creds only) ---
if [ "$REAL" -eq 1 ] && [ -n "$NOTARY_PROFILE" ]; then
  mkdir -p "$DIST"; ZIP="$DIST/installer-notarize.zip"
  say "Zipping + submitting the Installer to Apple notary (this waits)…"
  /usr/bin/ditto -c -k --keepParent "$INSTALLER" "$ZIP"
  notarize "$ZIP" "installer"
  say "Stapling the Installer…"
  xcrun stapler staple "$INSTALLER" || die "stapler staple failed for the Installer."
  xcrun stapler validate "$INSTALLER" || die "staple validation failed for the Installer — the notarization ticket isn't attached."
  rm -f "$ZIP"
else
  warn "Skipping notarize/staple (need DEV_ID + NOTARY_PROFILE)."
fi

# --- Step E: dmg (NO /Applications symlink — the installer places the app itself) ---
say "Building $DMG …"
mkdir -p "$DIST"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
/usr/bin/ditto "$INSTALLER" "$STAGE/$(basename "$INSTALLER")"
# The distributed dmg MUST carry the GPL component source offer + dep notices, the wrapper's
# MIT license text (LICENSE), and the full text of every bundled component's license
# (licenses/). Fail CLOSED — a missing legal file aborts the build instead of shipping a
# non-compliant dmg that still reports "Done" (the old `&&cp||warn` did the latter).
cp "$ROOT/THIRD-PARTY-NOTICES.md" "$STAGE/THIRD-PARTY-NOTICES.md" \
  || die "THIRD-PARTY-NOTICES.md missing — the dmg must carry the dep notices + icoutils GPLv3 offer."
cp "$ROOT/LICENSE" "$STAGE/LICENSE" \
  || die "LICENSE missing — the dmg must carry the wrapper's MIT license text."
mkdir -p "$STAGE/licenses"
for _lic in GPL-2.0.txt GPL-3.0.txt LGPL-2.1.txt MIT-dotnet.txt libpng-LICENSE.txt PCRE2-LICENCE.md; do
  cp "$ROOT/licenses/$_lic" "$STAGE/licenses/$_lic" \
    || die "licenses/$_lic missing — the dmg must ship every bundled component's full license text."
done
# Volume icon: the original download-arrow install glyph becomes the dmg's Finder icon.
if [ -f "$APPDIR/AppIcon.icns" ]; then
  cp "$APPDIR/AppIcon.icns" "$STAGE/.VolumeIcon.icns"
  /usr/bin/SetFile -a C "$STAGE" 2>/dev/null || warn "SetFile unavailable — dmg volume icon may not show."
else
  warn "app/AppIcon.icns missing — dmg will use the generic volume icon."
fi
rm -f "$DMG"
hdiutil create -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
say "  dmg  $DMG"

# --- Step F: sign + notarize + staple the dmg ---
if [ "$REAL" -eq 1 ]; then
  codesign --force ${TS[@]+"${TS[@]}"} -s "$DEV_ID" "$DMG"
  if [ -n "$NOTARY_PROFILE" ]; then
    say "Notarizing the dmg…"
    notarize "$DMG" "dmg"
    xcrun stapler staple "$DMG" || die "stapler staple failed for the dmg."
    xcrun stapler validate "$DMG" || die "staple validation failed for the dmg — the notarization ticket isn't attached."
    say "Gatekeeper assessment:"; spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1 | sed 's/^/  /' || true
  fi
fi

say "Done → $DMG"
if [ -f "$DMG" ]; then
  VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPDIR/Info.plist" 2>/dev/null || printf 'unknown')"
  SHA="$(shasum -a 256 "$DMG" 2>/dev/null | awk '{print $1}')"
  say "Release metadata: qsys-mac-installer $VERSION sha256 $SHA"
  say "Next: scripts/update-homebrew-cask.sh /path/to/homebrew-qsys"
fi
[ "$REAL" -eq 1 ] || say "That was a DRY run. Re-run with DEV_ID + NOTARY_PROFILE set to produce a shippable, notarized dmg."
