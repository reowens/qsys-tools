#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# provision.sh — first-run provisioning for the Q-SYS Designer macOS app.
#
# Drives the recipe to populate WRAP_HOME (the app's data dir, normally under
# ~/Library/Application Support) from the user's OWN installer. Unlike build.sh it
# does NOT emit a .app — the Swift app IS the app; this just fills its data dir
# (Wine + prefix + the menu shim + the patched loader name). Zero QSC code.
#
#   WRAP_HOME="$HOME/Library/Application Support/Q-SYS Designer" \
#     provision.sh "/path/to/Q-SYS Designer Installer 10.4.0.exe"
#
# Streams progress on stdout — the Swift setup UI tails it. Two kinds of lines:
#   • human  — the recipe's [qsys] … lines, shown verbatim in the log pane.
#   • machine — @@QSYS:STEP n total label@@  and  @@QSYS:EXTRACT pct@@ — parsed by the
#               UI to drive the determinate progress bar, and stripped from the log.
#
# Failure/cancel handling: any step dying (set -e) or a cancel (SIGTERM/SIGINT from the
# UI's Cancel button) runs targeted cleanup of just the in-flight step's partial output,
# so a retry resumes from a clean point instead of inheriting a corrupt half-artifact.
# Completed expensive steps (Wine, the installer extract) are idempotently reused.
#
# CLI escape hatch: FULL_WIPE=1 clears all prior provisioning state first (a from-scratch
# redo). Not used by the app's default path — the app relies on targeted cleanup + resume.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="${1:?usage: provision.sh <path to your Q-SYS Designer Installer*.exe>}"

# Direct CLI runs should find bundled/native helpers without a manual PATH edit. The native GUI
# still supplies a security-ordered PATH explicitly.
for d in "$HERE/bin" "$HERE/app/Resources/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH

# shellcheck source=lib/recipe.sh
source "$HERE/lib/recipe.sh"

# --- progress + cleanup state (globals; the trap and extract_installer read these) ---
export QSYS_PROGRESS=1     # tells extract_installer to emit @@QSYS:EXTRACT@@ + run cancellably
TOTAL_STEPS=7
STEP_NUM=0
CURRENT_STEP=""            # key of the in-flight step → what cleanup_partial scrubs on failure
EXTRACT_PID=""             # set by extract_installer while 7z runs; killed on cancel
DONE=0                     # flips to 1 only after a complete, successful provision

emit_step() {  # $1 = human label, $2 = cleanup key
  STEP_NUM=$((STEP_NUM + 1))
  CURRENT_STEP="$2"
  printf '@@QSYS:STEP %s %s %s@@\n' "$STEP_NUM" "$TOTAL_STEPS" "$1"
}

# Remove only the in-flight step's partial output. The recipe's other steps skip-if-present
# (Wine, the reused extract) or are harmlessly idempotent (wineboot, the silent .NET installers,
# the finalize tweaks), so scrubbing just the corrupt-able big extracts is enough to make a retry
# safe. Never written: the .provisioned marker — drop it defensively in case a prior run left one.
cleanup_partial() {
  case "$CURRENT_STEP" in
    wine)    rm -rf "$WINE_APP" ;;                          # half-extracted Wine
    prefix)  rm -rf "$WINEPREFIX" ;;                        # half-initialised prefix
    extract) rm -rf "${EXTRACT:-$WRAP_HOME/extract}" ;;     # half-extracted installer (no sentinel)
    *) : ;;                                                 # dotnet/assemble/finalize: idempotent re-run
  esac
  rm -f "$WRAP_HOME/.provisioned"
}

on_exit() {
  local rc=$?
  [ -n "${EXTRACT_PID:-}" ] && kill "$EXTRACT_PID" 2>/dev/null || true
  if [ "$DONE" -ne 1 ]; then
    warn "provisioning did not finish (exit $rc) — cleaning up partial '$CURRENT_STEP' state."
    cleanup_partial
  fi
}
# Convert every fatal async signal into a clean exit so the EXIT trap ALWAYS runs cleanup_partial:
#   INT/TERM = the UI's Cancel button; PIPE = the UI's stdout pipe closed (window/app gone mid-run);
#   HUP = controlling terminal / SSH session hangup. Without trapping PIPE/HUP a broken pipe or
#   hangup kills the script outright — skipping cleanup and stranding a half-written prefix/extract.
trap 'exit 130' INT TERM
trap 'exit 141' PIPE
trap 'exit 129' HUP
trap on_exit EXIT

say "Provisioning Q-SYS Designer → $WRAP_HOME"
mkdir -p "$WRAP_HOME"

if [ "${FULL_WIPE:-0}" = "1" ]; then
  say "FULL_WIPE=1 — clearing prior provisioning state (cache kept)…"
  rm -rf "$WINEPREFIX" "$WINE_APP" "$WRAP_HOME/extract" \
         "$WRAP_HOME/.provisioned" "$WRAP_HOME/appmenu.dylib" "$WRAP_HOME/QSYSDesigner.icns"
fi

emit_step "Checking your Mac" check
preflight
check_disk_space "$INSTALLER"

emit_step "Setting up Wine" wine
ensure_wine            # extracts/uses the (bundled, Tier B) Wine into $WINE_APP

emit_step "Initializing the Windows environment" prefix
init_prefix

emit_step "Installing the .NET runtime" dotnet
install_dotnet         # uses the (bundled, Tier B) cached installers

emit_step "Extracting your installer" extract
extract_installer "$INSTALLER"

emit_step "Assembling Q-SYS Designer" assemble
assemble               # MSI-maps the complete app payload into the prefix's Designer dir
cleanup_extract        # reclaim the ~1.6 GB installer-extract scratch (assemble was its last consumer)

emit_step "Finishing up" finalize
apply_prefix_tweaks
check_hosts
say "compiling the app-menu shim…"
compile_app_menu_shim "$WRAP_HOME/appmenu.dylib" || warn "shim compile failed — menu will be sparse"
say "setting the menu-bar app name…"
patch_loader_bundle_name "$WINEDIR" || true
say "extracting the app icon…"
extract_app_icon "$WRAP_HOME/QSYSDesigner.icns" || warn "icon extraction failed — Designer will use the generic Wine icon (cosmetic)"

# The app-menu shim is REQUIRED — a silent miss is the bare-menu bug (2026-06-22 second machine).
# compile_app_menu_shim already die()s on a failed bundled copy; assert here too so the shim can
# never be absent behind a written ".provisioned" marker. (Loader name-patch + icon are cosmetic.)
[ -f "$WRAP_HOME/appmenu.dylib" ] || die "app-menu shim missing after provisioning — the menu would be broken"

# Clear quarantine from everything we just laid down. If the app arrived via a download
# or AirDrop it carries com.apple.quarantine, and `cp` propagates that xattr onto the
# App Support copy of appmenu.dylib (+ the loose loader). DYLD then asks Gatekeeper to
# verify those ad-hoc-signed dylibs on dlopen → on a clean machine that fails with
# "Apple could not verify appmenu.dylib…" and Designer can't launch. These are files the
# notarized app generated locally on the user's own machine from their own installer, so
# clearing quarantine here is correct (same reason Wine's own dylibs need it).
say "Preparing the installed runtime for first launch…"
xattr -dr com.apple.quarantine "$WRAP_HOME" 2>/dev/null || true

# Schema stamp BEFORE the .provisioned marker: a kill between the two writes leaves an
# unstamped-but-unmarked dir (re-provisions), never a marked dir the launcher would trust
# while it's really an older layout (the 2026-07-02 stale-prefix NRE).
printf '%s\n' "$RECIPE_SCHEMA" > "$WRAP_HOME/.qsys-recipe-schema"
date > "$WRAP_HOME/.provisioned"
DONE=1
say "Done — provisioned into $WRAP_HOME"
