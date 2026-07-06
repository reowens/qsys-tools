#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Owens
# build.sh — the "processor". Turns YOUR OWN downloaded Q-SYS Designer installer
# into a working macOS .app, using a free Wine build. Ships zero QSC bytes.
#
#   ./build.sh --installer "/path/to/Q-SYS Designer Installer 10.4.0.exe"
#
# Options (all also settable as env vars — see lib/recipe.sh):
#   --installer <path>   REQUIRED. Your own free download from qsys.com.
#   --prefix <dir>       Wine prefix to build into       (default ~/.qsys-mac/prefix)
#   --out <path>         .app to emit                    (default ~/Applications/Q-SYS Designer.app)
#   --wine-app <path>    Existing Wine .app to reuse     (default: download pinned build)
#   --skip-dotnet        Reuse an already-provisioned prefix (skip .NET install)
#   -h | --help
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALLER=""; SKIP_DOTNET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --installer) INSTALLER="$2"; shift 2;;
    --prefix)    export WINEPREFIX="$2"; shift 2;;
    --out)       export APP_OUT="$2"; shift 2;;
    --wine-app)  export WINE_APP="$2"; shift 2;;
    --skip-dotnet) SKIP_DOTNET=1; shift;;
    -h|--help)   grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

# shellcheck source=lib/recipe.sh
source "$HERE/lib/recipe.sh"

[ -n "$INSTALLER" ] || die "Pass --installer <path to your Q-SYS Designer Installer*.exe>. See --help."

say "Q-SYS Designer macOS BYO wrapper"
say "  prefix : $WINEPREFIX"
say "  output : $APP_OUT"
mkdir -p "$WRAP_HOME"

preflight
ensure_wine
init_prefix
[ "$SKIP_DOTNET" -eq 1 ] && say "Skipping .NET install (--skip-dotnet)" || install_dotnet
extract_installer "$INSTALLER"
assemble
apply_prefix_tweaks
check_hosts
emit_app
print_postscript
