#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# launch.sh — run an already-built prefix without the emitted .app (dev/debug).
# Uses the same pinned recipe build.sh bakes into the .app. Pass a design path
# (or extra wine args) and it becomes argv[0], opened cleanly.
#
#   ./launch.sh                       # open Designer
#   ./launch.sh "C:\\path\\to\\design.qsys"
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/recipe.sh
source "$HERE/lib/recipe.sh"

EXE="$(find "$WINEPREFIX/drive_c/$APP_SUBDIR" -iname 'Q-Sys Designer.exe' 2>/dev/null | head -1)"
[ -n "$EXE" ] || die "Designer.exe not in prefix $WINEPREFIX — run ./build.sh first."
say "launching: $EXE"

# The pinned recipe — every token load-bearing (see README "The recipe, decoded"):
#   WINEDLLOVERRIDES=mshtml=d        -> mscoree ON (off breaks the IL-only managed loader)
#   …;mountmgr.sys=d                 -> kill the DiskArbitration /Volumes scan whose raw-device
#                                       open() trips the macOS removable-volume TCC prompt; C:/Z:
#                                       still resolve via static dosdevices symlinks (no mountmgr)
#   DOTNET_EnableWriteXorExecute=0   -> Rosetta 2 W^X compat for the .NET 8 JIT
#   LIBGL_ALWAYS_SOFTWARE=1 + reg key -> WPF software render (else black window)
#   NO CEF flags                     -> CefSharp adds --no-sandbox itself; a leading
#                                       flag poisons Designer's argv[0] design-loader.
# exec wine directly (not via /usr/bin/env, a SIP platform binary).
export DOTNET_EnableWriteXorExecute=0
export LIBGL_ALWAYS_SOFTWARE=1
export WINEDLLOVERRIDES="mshtml=d;mountmgr.sys=d"
# Give the bold menu bar its name: rewrite the unix loader's embedded CFBundleName.
patch_loader_bundle_name "$WINEDIR"
# Populate the (otherwise empty) macOS app menu: compile + inject the in-process shim.
export QSYS_MENU_NAME="$APP_NAME"
SHIM="$WRAP_HOME/appmenu.dylib"
compile_app_menu_shim "$SHIM" && export DYLD_INSERT_LIBRARIES="$SHIM"
start_wine_reaper "$$"

# Opt-in debug logging. `QSYS_DEBUG=1 ./launch.sh` cranks Wine diagnostics — all errors +
# warnings + SEH exception traces (so a raised managed exception like 0xe0434352 and any
# native failure right before it both land on disk); fixmes stay off, they're pure noise —
# and tees ALL output to a logfile. Override the channels with QSYS_WINEDEBUG, the path with
# QSYS_LOG. A normal launch is unchanged: silent, recipe default WINEDEBUG=fixme-all,err-all.
if [ -n "${QSYS_DEBUG:-}" ]; then
  LOG="${QSYS_LOG:-$WRAP_HOME/designer.log}"
  export WINEDEBUG="${QSYS_WINEDEBUG:-err+all,warn+all,fixme-all,+seh}"
  say "debug logging on — $LOG"
  exec "$WINE" "$EXE" "$@" >"$LOG" 2>&1
fi
exec "$WINE" "$EXE" "$@"
