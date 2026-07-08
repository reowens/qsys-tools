# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
# shellcheck shell=bash
# recipe.sh — shared library for the Q-SYS Designer macOS BYO wrapper.
#
# This file contains ZERO QSC bytes. It is a recipe: it knows how to drive a
# free Wine build, install the .NET 8 runtime, extract the user's OWN downloaded
# Q-SYS Designer installer, and assemble the extracted files into a working
# Wine prefix. The user supplies their own free download; nothing here ships it.
#
# Sourced by build.sh and (the env block) by the emitted .app launcher.

set -o pipefail

# ----------------------------------------------------------------------------
# Config — every value overridable via the environment before sourcing.
# ----------------------------------------------------------------------------
: "${WRAP_HOME:=$HOME/.qsys-mac}"              # where we build the prefix + keep Wine
: "${WINEPREFIX:=$WRAP_HOME/prefix}"            # the Wine bottle
: "${WINE_APP:=$WRAP_HOME/Wine Staging.app}"    # the free Wine build (downloaded if absent)
: "${APP_OUT:=$HOME/Applications/Q-SYS Designer.app}"  # the .app we emit
: "${APP_SUBDIR:=QSC/Q-Sys Designer}"           # install path inside drive_c
: "${APP_NAME:=Q-SYS Designer}"                 # Dock/Finder name + menu-bar name
: "${ICON_SCALE:=0.82}"                          # icon artwork size within the tile (rest = transparent margin, macOS-style)

# Provision-schema version, stamped into $WRAP_HOME/.qsys-recipe-schema after a successful
# provision. Bump when a prefix laid down by an older recipe is BROKEN for the current app —
# the launcher refuses to boot a lower-schema prefix and points the user at the installer
# (which re-assembles unconditionally). Keep in sync with DataDir.requiredRecipeSchema.
#   v2 = MSI-mapped full assembly (326 .luax) + brand-font HKLM registrations + Segoe UI
#        shim (bug 59925); a v1 (hand-picked ~40%) prefix NREs on inventory drags.
: "${RECIPE_SCHEMA:=2}"

# Directory this recipe lives in. Resolves even when sourced.
RECIPE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pinned free dependencies. URLs rot — see README "When a download 404s".
: "${WINE_URL:=https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.10/wine-staging-11.10-osx64.tar.xz}"
: "${DOTNET_DESKTOP_URL:=https://builds.dotnet.microsoft.com/dotnet/WindowsDesktop/8.0.28/windowsdesktop-runtime-8.0.28-win-x64.exe}"
: "${DOTNET_ASPNET_URL:=https://builds.dotnet.microsoft.com/dotnet/aspnetcore/Runtime/8.0.28/aspnetcore-runtime-8.0.28-win-x64.exe}"
: "${DOTNET_INSTALL_TIMEOUT_SECONDS:=900}"

# SHA-256 of each pinned artifact — checked before we ever extract/run it, on a fresh
# download AND on the bundled cache (a tampered or swapped cache is rejected too). The two
# .NET hashes are cross-checked against Microsoft's published release metadata
# (dotnet/release-metadata/8.0/releases.json, 8.0.28). Gcenx ships no checksum, so Wine is
# pinned to the audited build that passed provisioning + notarization. Bump these whenever
# the URLs above change version.
: "${WINE_SHA256:=940bdd1a177872020be01c5c33917cb8eecc1cc3193ad554914fb6efd90d7889}"
: "${DOTNET_DESKTOP_SHA256:=8819b8680a7a7668097bb031a856a5469159c8d6a8cfb2a6b2c0be44e74cb0c1}"
: "${DOTNET_ASPNET_SHA256:=f2b7bd56946ca20061241c0f4ab1e869dbd69b3cf4dd280650d7ea1d46a0b605}"

: "${CACHE:=$WRAP_HOME/cache}"                  # bundled (Tier B) deps live here; override to the app's Resources/cache
WINEDIR="$WINE_APP/Contents/Resources/wine"
WINE="$WINEDIR/bin/wine"
# Naming: a "renamed loader" does NOT change what macOS shows — wine re-execs into
# its core image at lib/wine/x86_64-unix/wine and the OS keys identity on that
# (verified 3 ways + Wine source). The bold MENU-BAR name is AppKit's applicationName,
# which it reads ONCE at init from the *main bundle's* CFBundleName (via LaunchServices)
# — NOT from menu-item titles and NOT from the process name. For a loose executable,
# CFBundleGetMainBundle() synthesizes a bundle from the loader's own dir and reads an
# Info.plist sitting beside it if present. So:
#   • Dock/Finder name  -> the .app's CFBundleName (works via LaunchServices/open).
#   • Menu-bar name     -> patch the unix loader's EMBEDDED __info_plist CFBundleName
#                          (patch_loader_bundle_name). Fixes the bold app menu AND the
#                          "Quit/Hide <name>" items, on STOCK wine. No winemac patch,
#                          no DYLD shim, no custom Wine build — Rosetta-proof. (An
#                          on-disk adjacent Info.plist was tried and is NOT reliable.)
#   • Little Snitch     -> the patched plist also sets the bundle id; whether LS adopts
#                          it is user-verifiable (see print_postscript).

export WINEPREFIX
export WINEDEBUG="${WINEDEBUG:-fixme-all,err-all}"

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------
say()  { printf '\033[1;36m[qsys]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[qsys] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[qsys] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Refuse an artifact whose bytes don't match its pinned SHA-256 — used on every fetched OR
# bundled dependency so a tampered download, a MITM'd CDN, or a swapped cache can't reach
# the installer/extractor. shasum (Perl) ships with macOS.
verify_sha256() {  # $1 = file  $2 = expected sha256 (hex)  $3 = human label
  local file="$1" want="$2" label="$3" got
  got="$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')"
  [ -n "$got" ] || die "Couldn't compute the checksum of $label ($file)."
  [ "$got" = "$want" ] || die "$label failed its integrity check — expected SHA-256 $want but got $got. Refusing to use a tampered or wrong file: $file"
}

run_dotnet_installer() {  # $1 = human label  $2 = installer path
  local label="$1" installer="$2" timeout="$DOTNET_INSTALL_TIMEOUT_SECONDS" status_file pid elapsed=0 status
  case "$timeout" in ''|*[!0-9]*) timeout=900 ;; esac
  [ "$timeout" -gt 0 ] || timeout=900

  status_file="$(mktemp "${TMPDIR:-/tmp}/qsys-dotnet-status.XXXXXX")" || return 1
  rm -f "$status_file"
  (
    set +e
    WINEDLLOVERRIDES="mscoree,mshtml=" "$WINE" "$installer" /install /quiet /norestart >/dev/null 2>&1
    printf '%s\n' "$?" >"$status_file"
  ) &
  pid=$!

  while [ ! -f "$status_file" ]; do
    if [ "$elapsed" -ge "$timeout" ]; then
      warn "$label runtime installer did not exit after ${timeout}s; stopping Wine for this prefix."
      [ -x "$WINEDIR/bin/wineserver" ] && "$WINEDIR/bin/wineserver" -k >/dev/null 2>&1 || true
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rm -f "$status_file"
      return 124
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  wait "$pid" 2>/dev/null || true
  status="$(<"$status_file")"
  rm -f "$status_file"
  case "$status" in ''|*[!0-9]*) return 1 ;; esac
  return "$status"
}

native_helper_path() {  # $1 = override env var name  $2 = command name
  local override="${!1:-}" helper
  if [ -n "$override" ]; then
    [ -x "$override" ] || return 1
    printf '%s\n' "$override"
    return 0
  fi
  helper="$(command -v "$2" 2>/dev/null || true)"
  [ -n "$helper" ] && [ -x "$helper" ] || return 1
  printf '%s\n' "$helper"
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
preflight() {
  [ "$(uname -s)" = "Darwin" ] || die "macOS only."
  [ "$(uname -m)" = "arm64" ]  || warn "Not Apple Silicon — the recipe was proven on arm64 + Rosetta 2 only."
  command -v 7z   >/dev/null 2>&1 || die "p7zip missing. Install:  brew install p7zip"
  command -v msiinfo >/dev/null 2>&1 || die "msiinfo missing. Packaged installers should include it in Resources/bin; source builds can install it with: brew install msitools"
  if [ "${QSYS_USE_PYTHON_HELPERS:-0}" = "1" ]; then
    command -v python3 >/dev/null 2>&1 || die "QSYS_USE_PYTHON_HELPERS=1 was set, but python3 is missing. Install Python or unset QSYS_USE_PYTHON_HELPERS to use the bundled native helpers."
  else
    native_helper_path QSYS_ASSEMBLE_MSI qsys-assemble-msi >/dev/null \
      || die "native MSI assembler missing. Packaged installers include it in Resources/bin; source builds should run scripts/bundle-deps.sh or set QSYS_ASSEMBLE_MSI."
    native_helper_path QSYS_RENAME_FONT_FAMILY qsys-rename-font-family >/dev/null \
      || die "native font renamer missing. Packaged installers include it in Resources/bin; source builds should run scripts/bundle-deps.sh or set QSYS_RENAME_FONT_FAMILY."
  fi
  command -v curl >/dev/null 2>&1 || die "curl missing."
  command -v wrestool >/dev/null 2>&1 || warn "icoutils missing (brew install icoutils) — the app will use a generic icon."
  /usr/bin/pgrep -q oahd 2>/dev/null || warn "Rosetta 2 may not be installed. Install:  softwareupdate --install-rosetta --agree-to-license"
}

# Fail fast before the long pole if the volume can't hold the work. WRAP_HOME must already exist so
# df reads the right volume. A8: the concurrent peak is ~4.5–5 GB, not ~installer + 2 GB — the old
# gate undercounted and let setup start on a volume that then filled mid-provision.
check_disk_space() {  # $1 = installer path
  local installer="$1" instbytes instmb peakmb availkb availmb peakgb availgb
  instbytes=$(stat -f%z "$installer" 2>/dev/null || echo 0)
  # Concurrent peak in WRAP_HOME during provision: the extract scratch (~installer size) coexists
  # with the assembled drive_c Designer install (~installer size again) PLUS Wine extracted
  # (~0.7–1 GB from the 181 MB xz) + the .NET 8 runtime in the prefix (~0.25 GB) + the prefix base.
  # That's ~4 GB on top of the installer-proportional term — so +4096 MiB headroom (the function's
  # original design intent; the prior +2048 contradicted its own "~4 GB" comment). The scratch is
  # reclaimed after assembly, so the install SETTLES to ~2 GB; the gate guards the transient peak.
  instmb=$(( instbytes / 1048576 ))
  peakmb=$(( instmb + 4096 ))
  availkb=$(df -k "$WRAP_HOME" 2>/dev/null | awk 'NR==2{print $4}')
  availmb=$(( ${availkb:-0} / 1024 ))
  peakgb=$(( (peakmb + 1023) / 1024 ))   # round up for display so we never understate the need
  availgb=$(( availmb / 1024 ))
  if [ "$availmb" -lt "$peakmb" ]; then
    die "Not enough free space: setup needs about ${peakgb} GB free while it runs (most is temporary — Q-SYS Designer settles to ~2 GB once installed). You have ${availgb} GB free."
  fi
  say "Disk space OK (${availgb} GB free; setup peaks ~${peakgb} GB, the install settles to ~2 GB)."
}

# ----------------------------------------------------------------------------
# Wine — use an existing free build or download the pinned one.
# ----------------------------------------------------------------------------
ensure_wine() {
  if [ -x "$WINE" ]; then say "Wine present: $WINE_APP"; else
    mkdir -p "$CACHE" "$(dirname "$WINE_APP")"
    local tar="$CACHE/$(basename "$WINE_URL")"
    [ -f "$tar" ] || { say "Downloading free Wine build…"; curl -fL --progress-bar -o "$tar" "$WINE_URL" \
      || die "Wine download failed ($WINE_URL). See README 'When a download 404s'."; }
    verify_sha256 "$tar" "$WINE_SHA256" "the Wine build"
    say "Extracting Wine…"
    tar -xJf "$tar" -C "$(dirname "$WINE_APP")" || die "Wine extract failed."
    # The tarball top-level dir name may vary; normalize to $WINE_APP.
    if [ ! -x "$WINE" ]; then
      local found; found="$(find "$(dirname "$WINE_APP")" -maxdepth 2 -name 'wine' -path '*/bin/wine' -type f 2>/dev/null | head -1)"
      [ -n "$found" ] || die "Could not locate the wine binary after extract."
      local approot; approot="$(cd "$(dirname "$found")/../../../.." && pwd)"
      [ "$approot" = "$WINE_APP" ] || { rm -rf "$WINE_APP"; mv "$approot" "$WINE_APP"; }
    fi
  fi
  # Gatekeeper: ad-hoc sign + de-quarantine so the unsigned build runs.
  say "Preparing the bundled Wine runtime for first launch…"
  xattr -dr com.apple.quarantine "$WINE_APP" 2>/dev/null || true
  codesign --force --deep -s - "$WINE_APP" >/dev/null 2>&1 || warn "codesign returned nonzero (often fine)."
}

# ----------------------------------------------------------------------------
# Prefix + .NET 8 runtimes
# ----------------------------------------------------------------------------
init_prefix() {
  local user; user="$(/usr/bin/id -un)"
  local profile="$WINEPREFIX/drive_c/users/$user"

  # Don't let Wine wire the Windows profile to the Mac home. By default wineboot symlinks
  # Desktop/Documents/Downloads/Music/Pictures/Videos straight to ~/Desktop, ~/Downloads, …
  # — so the very act of booting the prefix (and later Designer) reaches into TCC-protected
  # folders and macOS throws unprompted "wants to access your Downloads" dialogs. For a tool
  # people run for real work that reads like spyware. Instead we pre-create empty, prefix-local
  # dirs: Wine leaves an existing real directory alone (never replaces one with a symlink), so
  # nothing in the prefix ever points at the Mac home. Users reach their files on demand through
  # Wine's Z: drive (Z:\ = /), which only prompts if and when they actually browse there.
  mkdir -p "$profile"/{Desktop,Documents,Downloads,Music,Pictures,Videos}

  say "Initializing win64 prefix at $WINEPREFIX …"
  # Pre-create the only two drive letters we keep — C: (drive_c) and Z: (root) — BEFORE wineboot,
  # then boot with mountmgr.sys disabled. mountmgr's DiskArbitration callback is what scans /Volumes
  # and, for every mounted removable volume, open()s its raw /dev/rdiskN device to read a SCSI
  # identity — and THAT device open() is what makes macOS throw the "wants to access a removable
  # volume" TCC prompt. The scan re-runs on every cold wineserver start, so the old post-boot prune
  # never held (it already prompted during the boot scan, and the next cold launch re-added the
  # drive). Disabling mountmgr.sys stops the scan at the source; C:/Z: still resolve because ntdll
  # maps them from these static dosdevices symlinks with no mount manager involved (verified: vol C:,
  # dir Z:\ both work). Real disks stay reachable on demand via Z: (Z:\Volumes\…). Both launch paths
  # disable mountmgr too — otherwise the scan would just run at first launch instead (see launch.sh
  # and emit_app()).
  mkdir -p "$WINEPREFIX/dosdevices" "$WINEPREFIX/drive_c"
  ln -sfn ../drive_c "$WINEPREFIX/dosdevices/c:"
  ln -sfn / "$WINEPREFIX/dosdevices/z:"
  # winemenubuilder=d: skip Start-menu/.lnk building, which would otherwise scan those same
  # profile folders during boot — the other path that reads through a Mac-home link.
  WINEARCH=win64 WINEDLLOVERRIDES="winemenubuilder.exe=d;mountmgr.sys=d" "$WINE" wineboot --init >/dev/null 2>&1 \
    || die "wineboot failed."

  # Belt-and-suspenders: if any Wine build still planted a symlink, swap it for a local dir.
  # Use an explicit if (not `[ -L ] && {…}`): a trailing false test would become the loop's —
  # and thus init_prefix's — exit status, and under the callers' `set -e` that kills the build.
  local d
  for d in Desktop Documents Downloads Music Pictures Videos; do
    if [ -L "$profile/$d" ]; then
      rm -f "$profile/$d"
      mkdir -p "$profile/$d"
    fi
  done

  # Drive-letter sandboxing is now handled at the source: mountmgr.sys is disabled for the init
  # boot above (and on every launch), so wineboot never runs the /Volumes scan that auto-mapped
  # D:/E:/… and their raw devices. C: and Z: were pre-created before wineboot. Nothing left to prune.
  return 0
}

install_dotnet() {
  local desktop="$CACHE/$(basename "$DOTNET_DESKTOP_URL")"
  local aspnet="$CACHE/$(basename "$DOTNET_ASPNET_URL")"
  mkdir -p "$CACHE"
  [ -f "$desktop" ] || { say "Downloading .NET 8 Desktop runtime…"; curl -fL --progress-bar -o "$desktop" "$DOTNET_DESKTOP_URL" || die ".NET Desktop download failed."; }
  [ -f "$aspnet"  ] || { say "Downloading ASP.NET Core 8 runtime…"; curl -fL --progress-bar -o "$aspnet"  "$DOTNET_ASPNET_URL"  || die "ASP.NET Core download failed."; }
  verify_sha256 "$desktop" "$DOTNET_DESKTOP_SHA256" "the .NET 8 Desktop runtime"
  verify_sha256 "$aspnet"  "$DOTNET_ASPNET_SHA256"  "the ASP.NET Core 8 runtime"
  # During the *install* only, disable mscoree+mshtml to skip the wine-mono prompt.
  # (At LAUNCH mscoree must be ON — disabling it breaks the managed loader. See README.)
  say "Installing .NET 8 Desktop runtime (silent)…"
  run_dotnet_installer "Desktop" "$desktop" || warn "Desktop runtime installer returned nonzero."
  say "Installing ASP.NET Core 8 runtime (silent)…"
  run_dotnet_installer "ASP.NET" "$aspnet" || warn "ASP.NET runtime installer returned nonzero."
  # Both installers exit nonzero under Wine even on success, so their exit code can't gate this —
  # assert the runtime actually LANDED. The .NET installer must create a window; a headless run with
  # no GUI session (Wine's winemac.drv can't reach the macOS Aqua session → nodrv_CreateWindow)
  # installs NOTHING yet sails past the WARNs above, leaving a .NET-less, non-launchable Designer
  # that still reports "provisioned". Fail loudly here instead of shipping a silently-broken prefix.
  local dotnet_dir="$WINEPREFIX/drive_c/Program Files/dotnet"
  [ -f "$dotnet_dir/dotnet.exe" ] && [ -d "$dotnet_dir/shared/Microsoft.WindowsDesktop.App" ] \
    || die ".NET 8 runtime did not install (missing dotnet.exe / Microsoft.WindowsDesktop.App under \"$dotnet_dir\"). The .NET installer needs a GUI session to create its window — a headless SSH-only run can't reach the macOS Aqua session. Provision from the desktop, or from a Terminal inside a logged-in GUI session."
}

# ----------------------------------------------------------------------------
# Extract the user's OWN installer (BYO — never redistributed).
# ----------------------------------------------------------------------------

# Refuse an installer that carries POSIX symlinks or path-traversal members BEFORE we extract it.
# p7zip restores symlinks on extraction by default (no switch disables it in 17.05), so a crafted
# archive could plant a symlink and then write THROUGH it to escape $EXTRACT; absolute (`/…`, `\…`,
# `C:\…`) or parent-relative (`../`, `..\`) member paths are the other escape. A genuine Q-SYS
# Designer installer (a Windows InstallAware self-extractor) contains none of these, so this never
# trips on a real one.
# A 7z `-slt` listing flags a symlink three ways depending on the container: a ZIP carries the unix
# mode in `Attributes = A_ lrwxr-xr-x`, while a tar / 7z-native member instead emits `Mode = lrwx…`
# (mode beginning with `l`) plus a non-empty `Symbolic Link = <target>` line and NO `Attributes`
# line — so the ZIP-only `Attributes` check alone misses tar/7z symlinks (verified PoC).
assert_safe_archive() {  # $1 = installer path
  local installer="$1" listing members
  # `7z l -slt` prints an archive-PROPERTIES block first (whose own `Path =` is the archive's
  # absolute filesystem path — not untrusted content), then a `----------` separator, then one
  # block per member. Scan only the member section so the archive's own path can't false-trip the
  # absolute-path check.
  listing="$(7z l -slt "$installer" 2>/dev/null)" || die "Couldn't read the installer (7z list failed)."
  members="$(printf '%s\n' "$listing" | sed -n '/^----------$/,$p')"
  [ -n "$members" ] || die "This doesn't look like a readable Q-SYS Designer installer (7z produced no file listing)."
  if printf '%s\n' "$members" | grep -Eq '^Attributes = .* l[rwxsStT-]{9}|^Mode = l[rwxsStT-]{9}|^Symbolic Link = .'; then
    die "This installer contains symbolic links and isn't a normal Q-SYS Designer installer — refusing to extract it."
  fi
  if printf '%s\n' "$members" | grep -Eq '^Path = ([/\\]|[A-Za-z]:|(.*[/\\])?\.\.([/\\]|$))'; then
    die "This installer contains absolute or parent-relative paths and isn't a normal Q-SYS Designer installer — refusing to extract it."
  fi
}

extract_installer() {  # $1 = path to user's Q-SYS Designer Installer*.exe
  local installer="$1"
  [ -f "$installer" ] || die "Installer not found: $installer"
  EXTRACT="$WRAP_HOME/extract"
  OFFLINE="$EXTRACT/OFFLINE"
  # Resume fast path: a prior run that fully extracted (sentinel present) is reused as-is, so a
  # failure in a *later* step doesn't re-pay the long pole. A failed extract leaves no sentinel
  # (cleanup_partial wipes the scratch), so a corrupt half-extract is never mistaken for done.
  if [ -f "$EXTRACT/.extract-complete" ] && [ -d "$OFFLINE" ]; then
    say "Reusing the previously-extracted installer."
    return 0
  fi
  assert_safe_archive "$installer"
  rm -rf "$EXTRACT"; mkdir -p "$EXTRACT"
  say "Extracting your installer with 7z (the installer never runs)…"
  local rc=0
  if [ "${QSYS_PROGRESS:-0}" = "1" ]; then
    # Background 7z so (a) the parent can poll extracted-bytes for a real % on the long pole and
    # (b) a cancel trap can kill EXTRACT_PID mid-extract. The OFFLINE payload is ~uncompressed
    # (extract size ≈ installer size), so extracted-KiB / installer-bytes is a faithful fraction.
    local total cur pct; total=$(stat -f%z "$installer" 2>/dev/null || echo 0)
    7z x -y -o"$EXTRACT" "$installer" >/dev/null 2>&1 &
    EXTRACT_PID=$!
    while kill -0 "$EXTRACT_PID" 2>/dev/null; do
      if [ "$total" -gt 0 ]; then
        cur=$(du -sk "$EXTRACT" 2>/dev/null | cut -f1 || true); cur=${cur:-0}
        pct=$(( cur * 1024 * 100 / total )); [ "$pct" -gt 99 ] && pct=99
        printf '@@QSYS:EXTRACT %s@@\n' "$pct"
      fi
      sleep 1
    done
    wait "$EXTRACT_PID" || rc=$?
    EXTRACT_PID=""
    printf '@@QSYS:EXTRACT 100@@\n'
  else
    7z x -y -o"$EXTRACT" "$installer" >/dev/null 2>&1 || rc=$?
  fi
  [ "$rc" -eq 0 ] || die "This doesn't look like a valid Q-SYS Designer installer (7z couldn't read it)."
  [ -d "$OFFLINE" ] || die "This doesn't look like a Q-SYS Designer installer — no OFFLINE payload was found inside it."
  : > "$EXTRACT/.extract-complete"
}

# Reclaim the installer-extract scratch (~1.6 GB) once assemble() has copied everything it
# needs out of $OFFLINE into the prefix. assemble is its last consumer (extract_app_icon reads
# the exe from the prefix, not here). Re-provisioning re-extracts from the installer — the long
# pole — so only call this after a SUCCESSFUL assemble. No-op if already gone.
cleanup_extract() {
  local e="${EXTRACT:-$WRAP_HOME/extract}"
  [ -d "$e" ] || return 0
  say "Reclaiming installer-extract scratch ($(du -sh "$e" 2>/dev/null | cut -f1))…"
  rm -rf "$e"
}

# ----------------------------------------------------------------------------
# Assemble the COMPLETE app into the prefix by mapping every OFFLINE payload file
# to its MSI-defined install target path. Fails hard on a broken mapping.
# ----------------------------------------------------------------------------
# InstallAware shatters the payload across hash-named OFFLINE/<hash>/<hash> dirs and ships
# a metadata-only MSI (no CAB stream — 7z has already unpacked the bytes into OFFLINE). The
# MSI Directory/Component/File tables encode, per file, BOTH the OFFLINE source and the
# install target (DefaultDir's [target]:[source] form), so we lay down the whole app — all
# 326 .luax component defs, 28 .qplug plugins, symbols and the full DLL set — instead of the
# old content-marker hand-pick that shipped ~40% and dropped the entire component layer (which
# NRE'd the LCQ-LN inventory drag and boxed the missing-symbol components). msiinfo reads the
# tables; qsys-assemble-msi does the path math (shell joins choke on the mangled identifiers).
# Python remains only as an explicit developer fallback for parity/debug runs:
# QSYS_USE_PYTHON_HELPERS=1.
assemble() {
  APP="$WINEPREFIX/drive_c/$APP_SUBDIR"
  mkdir -p "$APP"
  local msi; msi="$(find "$EXTRACT" -maxdepth 1 -iname '*.msi' 2>/dev/null | head -1)"
  [ -n "$msi" ] && [ -f "$msi" ] || die "Installer MSI not found under $EXTRACT — can't map the app layout."
  say "Mapping the complete app from the installer MSI…"
  # $EXTRACT is the source root: the MSI source chain begins with the literal OFFLINE segment.
  if [ "${QSYS_USE_PYTHON_HELPERS:-0}" = "1" ]; then
    command -v python3 >/dev/null 2>&1 || die "python3 missing but QSYS_USE_PYTHON_HELPERS=1 was set."
    python3 "$RECIPE_DIR/assemble-msi.py" "$msi" "$EXTRACT" "$APP" || die "MSI-mapped assembly failed (see the error above)."
  else
    local helper; helper="$(native_helper_path QSYS_ASSEMBLE_MSI qsys-assemble-msi)" \
      || die "native MSI assembler not found. Run scripts/bundle-deps.sh and ensure Resources/bin is first in PATH, or set QSYS_ASSEMBLE_MSI."
    "$helper" "$msi" "$EXTRACT" "$APP" || die "native MSI-mapped assembly failed (see the error above)."
  fi
}

# ----------------------------------------------------------------------------
# Prefix tweaks the working launch depends on.
# ----------------------------------------------------------------------------
apply_prefix_tweaks() {
  # WPF software rendering — else the main window paints black
  # (milcore → wined3d → GL: GL_INVALID_FRAMEBUFFER_OPERATION from glBlitFramebuffer).
  say "Setting WPF software-render reg key…"
  "$WINE" reg add 'HKCU\Software\Microsoft\Avalon.Graphics' /v DisableHWAcceleration /t REG_DWORD /d 1 /f >/dev/null 2>&1 \
    || warn "could not set Avalon.Graphics reg key."
  # Stop the auto crash-debugger from orphaning wineserver. Wine's default AeDebug runs
  # `winedbg --auto` on any unhandled exception; in practice that handler hangs indefinitely
  # (ends up PPID 1), keeping wineserver above zero clients so it never reaches its self-reap
  # timeout — stranding winedevice + the whole CefSharp subprocess tree across sessions
  # (observed: dozens of orphans + multiple hung winedbg after closing Designer). Auto=0 makes
  # a crash simply terminate the process (Wine still prints the exception to stderr for
  # diagnosis), so wineserver reaps the tree once the last real client exits. Set both the
  # 64-bit and 32-bit (Wow6432Node) keys — CefSharp helpers can be either bitness.
  say "Disabling the auto crash-debugger (AeDebug) so a crash can't orphan wineserver…"
  "$WINE" reg add 'HKLM\Software\Microsoft\Windows NT\CurrentVersion\AeDebug' /v Auto /t REG_SZ /d 0 /f >/dev/null 2>&1 \
    || warn "could not set AeDebug Auto=0 (64-bit)."
  "$WINE" reg add 'HKLM\Software\Wow6432Node\Microsoft\Windows NT\CurrentVersion\AeDebug' /v Auto /t REG_SZ /d 0 /f >/dev/null 2>&1 \
    || warn "could not set AeDebug Auto=0 (32-bit)."
  # Pre-create the prefs dir the bypassed installer would have made (silences first-run noise).
  local user; user="$(/usr/bin/id -un)"
  mkdir -p "$WINEPREFIX/drive_c/users/$user/AppData/Local/QSC/Q-Sys Designer" 2>/dev/null || true

  # "Segoe UI" shim — WPF under Wine drops U+002D (hyphen-minus) via its missing-family
  # fallback (upstream Wine bug 59925 — see bugs.winehq.org/show_bug.cgi?id=59925). The
  # prefix ships no font named "Segoe UI", so every hyphenated schematic label routes through
  # that broken path and renders its hyphens as boxes. Materializing the family heals it:
  # rename the bundled (unmodified, OFL) Selawik files — Microsoft's own Segoe-metric-
  # compatible face — locally into "Segoe UI" and REGISTER them (Wine's dwrite builds its
  # system collection from the Fonts registry key; an unregistered file in Fonts/ is invisible
  # to it, and SystemLink/FontSubstitutes are both ignored by the WPF path — all verified).
  # The rename stays on this machine: nothing trademark-named is redistributed, and removing
  # the OFL reserved name "Selawik" from the modified copy is what the OFL requires anyway.
  local fonts_src="$RECIPE_DIR/../assets/fonts/selawik"
  if [ -d "$fonts_src" ]; then
    say "Installing the Segoe UI shim (Selawik, renamed locally — heals bug 59925 hyphen tofu)…"
    local fdir="$WINEPREFIX/drive_c/windows/Fonts"
    mkdir -p "$fdir"
    local font_helper=""
    if [ "${QSYS_USE_PYTHON_HELPERS:-0}" != "1" ]; then
      font_helper="$(native_helper_path QSYS_RENAME_FONT_FAMILY qsys-rename-font-family)" \
        || die "native font renamer not found. Run scripts/bundle-deps.sh and ensure Resources/bin is first in PATH, or set QSYS_RENAME_FONT_FAMILY."
    fi
    while IFS=: read -r src regname out; do
      if [ "${QSYS_USE_PYTHON_HELPERS:-0}" = "1" ]; then
        command -v python3 >/dev/null 2>&1 || die "python3 missing but QSYS_USE_PYTHON_HELPERS=1 was set."
        python3 "$RECIPE_DIR/rename-font-family.py" \
          "$fonts_src/$src.ttf" "$fdir/$out.ttf" "Selawik" "Segoe UI" >/dev/null 2>&1 \
          || { warn "Segoe UI shim: rename failed for $src.ttf"; continue; }
      else
        "$font_helper" "$fonts_src/$src.ttf" "$fdir/$out.ttf" "Selawik" "Segoe UI" >/dev/null 2>&1 \
          || { warn "Segoe UI shim: native rename failed for $src.ttf"; continue; }
      fi
      "$WINE" reg add 'HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts' \
        /v "$regname" /t REG_SZ /d "$out.ttf" /f >/dev/null 2>&1 \
        || warn "Segoe UI shim: could not register '$regname'."
    done <<'SHIM'
selawk:Segoe UI (TrueType):segoeui-shim
selawkb:Segoe UI Bold (TrueType):segoeui-shimb
selawkl:Segoe UI Light (TrueType):segoeui-shiml
selawksb:Segoe UI Semibold (TrueType):segoeui-shimsb
selawksl:Segoe UI Semilight (TrueType):segoeui-shimsl
SHIM
  else
    warn "Segoe UI shim skipped — $fonts_src not found (hyphens will tofu, bug 59925)."
  fi
}

# Informational only. The bare-hostname /etc/hosts mapping is NOT required: Designer starts
# and renders fine without it — Wine logs a single non-fatal
# `winediag:getaddrinfo Failed to resolve your host name IP` line and carries on (the embedded
# loopback server uses 127.0.0.1, which always resolves). Proven 2026-06-22 via a getaddrinfo
# DYLD-interpose + a launch glance (plan Phase 0.1). So: note it, never warn, never ask for sudo.
check_hosts() {
  local hn; hn="$(hostname)"
  if grep -qiE "^[^#]*[[:space:]]$hn([[:space:]]|\$)" /etc/hosts; then
    say "/etc/hosts maps '$hn' ✓"
  else
    say "/etc/hosts has no '$hn' mapping — harmless (Wine logs one cosmetic getaddrinfo line; startup is unaffected)."
  fi
}

# ----------------------------------------------------------------------------
# Emit a SELF-CONTAINED .app bundle: Wine + the prefix are cloned INSIDE it
# (APFS clonefile → ~free on disk), so the .app is movable and has no dependency
# on $WRAP_HOME. The launcher computes every path relative to itself, so the
# Dock/Finder name comes from CFBundleName when launched via LaunchServices
# (double-click / `open`); the menu-bar name comes from patching the unix loader's
# EMBEDDED __info_plist CFBundleName (see patch_loader_bundle_name).
# ----------------------------------------------------------------------------

# Rename Wine's bold macOS menu-bar app name to $APP_NAME by rewriting the unix
# loader's EMBEDDED __info_plist CFBundleName. AppKit reads the bold app-menu name
# (and the Quit/Hide items) ONCE at init from the main bundle's CFBundleName; for
# Wine's loose loader that comes from its embedded plist (ships "Wine"). Menu-item
# titles, the process name, and an on-disk adjacent Info.plist do NOT reliably win
# (all tried). The packaged installer uses a pre-patched loader; source-only fallback
# delegates the byte surgery to patch-loader-plist.py, then re-signs the loader so the
# edit is sealed. That fallback needs python3 + otool (CLT) and skips with a warning if
# absent (menu cosmetically reads "wine"). Arg $1 = a Wine root.
patch_loader_bundle_name() {
  local wineroot="$1"
  local loader="$wineroot/lib/wine/x86_64-unix/wine"
  [ -f "$loader" ] || return 0
  # Tier-B fast path: a loader pre-patched at app-build time (end-user machines need no
  # python3/otool). The bundled tarball is pinned, so its loader bytes are deterministic →
  # the build-time patched copy is byte-correct for the freshly-extracted loader. Drop it
  # in + re-sign (codesign ships with macOS; otool/python3 do not).
  if [ -n "${QSYS_PREPATCHED_LOADER:-}" ]; then
    [ -f "$QSYS_PREPATCHED_LOADER" ] || die "prepatched wine loader not found: $QSYS_PREPATCHED_LOADER"
    cp -f "$QSYS_PREPATCHED_LOADER" "$loader" || die "prepatched loader copy failed → $loader"
    codesign --force -s - "$loader" >/dev/null 2>&1 || true
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1 || ! command -v otool >/dev/null 2>&1; then
    warn "python3/otool missing — skipping menu-bar rename (reads \"wine\"; cosmetic)."
    return 0
  fi
  if python3 "$RECIPE_DIR/patch-loader-plist.py" "$loader" "$APP_NAME" "com.byo.qsys-designer-wine" >/dev/null; then
    codesign --force -s - "$loader" >/dev/null 2>&1 || true
  else
    warn "menu-bar rename skipped (loader plist didn't fit) — reads \"wine\"; cosmetic."
  fi
}

# Compile the in-process app-menu shim (lib/appmenu.m) to $1 and ad-hoc sign it. The shim
# is injected via DYLD_INSERT_LIBRARIES and force-installs a complete macOS app menu
# (About / Preferences…→winecfg / Hide / Hide Others / Show All / Quit + a Window menu),
# re-asserting it whenever anything clobbers the main menu. Needed because winemac only
# builds that menu when the process starts as an Accessory app; once the loose loader
# carries a real CFBundleName/CFBundleIdentifier (which we set for the menu-bar NAME) it can
# start Regular, so winemac skips the build and the dropdown is empty. Needs clang (CLT or
# Xcode); warn-and-skip if absent (⌘Q still quits — cosmetic). Returns 0 on success.
compile_app_menu_shim() {
  local out="$1" src="$RECIPE_DIR/appmenu.m"
  # Tier-B fast path: a dylib pre-compiled (universal, incl. the x86_64 slice Wine needs
  # under Rosetta) at app-build time — end-user machines have no clang. If the env var is set
  # we ARE the shipped product and the menu shim is REQUIRED: a missing or un-copyable prebuilt
  # is a HARD error (die), never a silent skip to the absent-clang path that ships a bare menu
  # (the 2026-06-22 second-machine regression — a provision finished "ok" with no appmenu.dylib).
  if [ -n "${QSYS_PREBUILT_APPMENU:-}" ]; then
    [ -f "$QSYS_PREBUILT_APPMENU" ] || die "prebuilt app-menu shim not found: $QSYS_PREBUILT_APPMENU"
    mkdir -p "$(dirname "$out")"
    cp -f "$QSYS_PREBUILT_APPMENU" "$out" || die "prebuilt app-menu copy failed → $out"
    codesign --force -s - "$out" >/dev/null 2>&1 || true
    [ -f "$out" ] || die "app-menu shim missing after copy → $out"
    return 0
  fi
  [ -f "$src" ] || { warn "appmenu.m missing — skipping app-menu shim."; return 1; }
  command -v clang >/dev/null 2>&1 || { warn "clang missing (install CLT: xcode-select --install) — skipping app-menu shim; ⌘Q still works."; return 1; }
  mkdir -p "$(dirname "$out")"
  if clang -arch x86_64 -arch arm64 -dynamiclib -framework Cocoa -fobjc-arc \
       -mmacosx-version-min=11.0 -o "$out" "$src" 2>/dev/null; then
    codesign --force -s - "$out" >/dev/null 2>&1 || true
    return 0
  fi
  warn "app-menu shim failed to compile — skipping; ⌘Q still works."
  return 1
}

# Extract the real Windows app icon embedded in the user's Q-Sys Designer.exe and install it
# as the bundle's .icns (so the Dock/Finder show the real icon, not the generic app tile).
# Pipeline: wrestool (icon group → .ico) → icotool (largest icon → PNG master) → sips/iconutil
# (→ .iconset → .icns). Needs icoutils (brew install icoutils); sips+iconutil are macOS
# built-ins. Warn-and-skip if icoutils is absent — the CFBundleIconFile then points at a
# missing file and macOS falls back to the generic icon (harmless). Arg $1 = bundle path.
extract_app_icon() {
  local icns="$1"   # destination .icns path (the .app's Resources, or WRAP_HOME for in-app provisioning)
  local exe; exe="$(find "$WINEPREFIX/drive_c/$APP_SUBDIR" -iname 'Q-Sys Designer.exe' 2>/dev/null | head -1)"
  [ -n "$exe" ] || { warn "icon: Q-Sys Designer.exe not found — skipping app icon."; return 1; }
  if ! command -v wrestool >/dev/null 2>&1 || ! command -v icotool >/dev/null 2>&1; then
    warn "icon: icoutils missing (brew install icoutils) — skipping app icon (generic icon used)."
    return 1
  fi
  local tmp; tmp="$(mktemp -d)"
  # First (primary) icon-group resource name — version-stable, not hash-pinned.
  local gname; gname="$(wrestool -l "$exe" 2>/dev/null | sed -nE 's/.*--type=14 --name=([0-9]+).*/\1/p' | head -1)"
  [ -n "$gname" ] || { warn "icon: no icon group in exe — skipping."; rm -rf "$tmp"; return 1; }
  wrestool -x --type=14 --name="$gname" "$exe" -o "$tmp/app.ico" >/dev/null 2>&1 \
    || { warn "icon: icon-group extract failed — skipping."; rm -rf "$tmp"; return 1; }
  # Largest icon in the group (by width) → master PNG.
  local idx; idx="$(icotool -l "$tmp/app.ico" 2>/dev/null \
    | sed -nE 's/.*--index=([0-9]+) --width=([0-9]+).*/\2 \1/p' | sort -rn | head -1 | awk '{print $2}')"
  [ -n "$idx" ] || { warn "icon: empty icon group — skipping."; rm -rf "$tmp"; return 1; }
  icotool -x --index="$idx" "$tmp/app.ico" -o "$tmp/master.png" >/dev/null 2>&1 \
    || { warn "icon: master extract failed — skipping."; rm -rf "$tmp"; return 1; }
  local set="$tmp/icon.iconset"; mkdir -p "$set"
  # Windows icons are edge-to-edge; macOS icons sit inside the tile with a transparent margin.
  # Draw the artwork at ICON_SCALE, centered on a transparent canvas (sips can't do transparent
  # padding — clang+Cocoa can; clang is already required for the app-menu shim). Fall back to a
  # plain edge-to-edge resize if the pad helper can't build.
  local pad=""
  if [ -n "${QSYS_PREBUILT_ICONPAD:-}" ] && [ -f "$QSYS_PREBUILT_ICONPAD" ]; then
    pad="$QSYS_PREBUILT_ICONPAD"   # Tier B: pre-built at app-build time (no clang on the user's machine)
  elif command -v clang >/dev/null 2>&1 && clang -arch x86_64 -arch arm64 -framework Cocoa \
       -fobjc-arc -mmacosx-version-min=11.0 -o "$tmp/iconpad" "$RECIPE_DIR/icon-pad.m" 2>/dev/null; then
    pad="$tmp/iconpad"
  else
    warn "icon: pad helper unavailable — using edge-to-edge icon (no margin)."
  fi
  local spec px name
  for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
              128:icon_128x128 256:icon_128x128@2x 256:icon_256x256; do
    px="${spec%%:*}"; name="${spec##*:}"
    if [ -n "$pad" ] && "$pad" "$tmp/master.png" "$set/$name.png" "$px" "$ICON_SCALE" 2>/dev/null; then
      :
    else
      sips -z "$px" "$px" "$tmp/master.png" --out "$set/$name.png" >/dev/null 2>&1
    fi
  done
  mkdir -p "$(dirname "$icns")"
  if iconutil -c icns "$set" -o "$icns" >/dev/null 2>&1; then
    say "  app icon ← Q-Sys Designer.exe (${idx}: largest embedded icon)"
  else
    warn "icon: iconutil failed — skipping."; rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"
}

emit_app() {
  local exe; exe="$(find "$WINEPREFIX/drive_c/$APP_SUBDIR" -iname 'Q-Sys Designer.exe' 2>/dev/null | head -1)"
  [ -n "$exe" ] || die "Cannot emit .app — Q-Sys Designer.exe not in prefix."
  local relexe="${exe#$WINEPREFIX/}"   # e.g. drive_c/QSC/Q-Sys Designer/Q-Sys Designer.exe
  [ -x "$WINE" ] || die "Cannot emit .app — Wine not provisioned (run ensure_wine)."

  say "Emitting self-contained $APP_OUT …"
  rm -rf "$APP_OUT"; mkdir -p "$APP_OUT/Contents/MacOS" "$APP_OUT/Contents/Resources"
  say "  cloning Wine into the bundle (clonefile)…"
  cp -Rc "$WINEDIR" "$APP_OUT/Contents/Resources/wine" 2>/dev/null \
    || cp -R "$WINEDIR" "$APP_OUT/Contents/Resources/wine"
  say "  cloning the prefix into the bundle (clonefile)…"
  cp -Rc "$WINEPREFIX" "$APP_OUT/Contents/Resources/prefix" 2>/dev/null \
    || cp -R "$WINEPREFIX" "$APP_OUT/Contents/Resources/prefix"

  cat > "$APP_OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>com.byo.qsys-designer-wine</string>
  <key>CFBundleShortVersionString</key><string>0.1.5</string>
  <key>CFBundleVersion</key><string>0.1.5</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>QSYSDesigner</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST

  # Launcher — fully relative to the bundle, so the .app can be moved anywhere.
  # exec wine DIRECTLY (not via /usr/bin/env, a SIP platform binary that would purge any
  # DYLD_*): that's load-bearing now, because the launcher injects the app-menu shim via
  # DYLD_INSERT_LIBRARIES and it must survive into wine + its loose-loader re-exec.
  cat > "$APP_OUT/Contents/MacOS/launch" <<LAUNCH
#!/bin/bash
# Auto-generated by the Q-SYS Designer macOS BYO wrapper. Contains zero QSC code.
RES="\$(cd "\$(dirname "\$0")/../Resources" && pwd)"
export WINEPREFIX="\$RES/prefix"
export WINELOADER="\$RES/wine/bin/wine"
export WINEDEBUG="fixme-all,err-all"
export DOTNET_EnableWriteXorExecute=0
export LIBGL_ALWAYS_SOFTWARE=1
# mountmgr.sys=d: no DiskArbitration /Volumes scan -> no raw /dev/rdiskN open() -> no macOS
# removable-volume TCC prompt on cold launch. C:/Z: still resolve via static dosdevices symlinks.
export WINEDLLOVERRIDES="mshtml=d;mountmgr.sys=d"
export QSYS_MENU_NAME="$APP_NAME"
export QSYS_ICON="\$RES/QSYSDesigner.icns"
[ -f "\$RES/appmenu.dylib" ] && export DYLD_INSERT_LIBRARIES="\$RES/appmenu.dylib"
# Opt-in debug logging. Enable by env (terminal launch: QSYS_DEBUG=1 …/Contents/MacOS/launch)
# or by a marker file (double-click: \`touch "\$HOME/Library/Logs/qsys-designer-debug"\`). Cranks
# Wine diagnostics (errors + warnings + SEH exception traces; fixmes off) and tees ALL output
# to \$HOME/Library/Logs/Q-SYS-Designer.log (visible in Console.app). Normal launch: silent.
DBG_MARK="\$HOME/Library/Logs/qsys-designer-debug"
if [ -n "\${QSYS_DEBUG:-}" ] || [ -f "\$DBG_MARK" ]; then
  export WINEDEBUG="\${QSYS_WINEDEBUG:-err+all,warn+all,fixme-all,+seh}"
  mkdir -p "\$HOME/Library/Logs"
  exec "\$RES/wine/bin/wine" "\$WINEPREFIX/$relexe" "\$@" >"\$HOME/Library/Logs/Q-SYS-Designer.log" 2>&1
fi
exec "\$RES/wine/bin/wine" "\$WINEPREFIX/$relexe" "\$@"
LAUNCH
  chmod +x "$APP_OUT/Contents/MacOS/launch"

  # Build the macOS app menu the shim injects (About/Preferences→winecfg/Hide/Quit + Window).
  say "  compiling the app-menu shim…"
  compile_app_menu_shim "$APP_OUT/Contents/Resources/appmenu.dylib" || true

  # Install the real Dock/Finder icon from the user's Q-Sys Designer.exe.
  say "  extracting the app icon…"
  extract_app_icon "$APP_OUT/Contents/Resources/QSYSDesigner.icns" || true

  # Rename the bold menu bar BEFORE signing so --deep seals the patched loader.
  say "  renaming the menu-bar app name…"
  patch_loader_bundle_name "$APP_OUT/Contents/Resources/wine"

  say "  ad-hoc signing the bundle…"
  codesign --force --deep -s - "$APP_OUT" >/dev/null 2>&1 || warn "codesign returned nonzero (often fine for local use)."
}

print_postscript() {
  cat <<EOF

$(say "Done. Launch by double-clicking the .app, or:  open -a '$APP_OUT'")

  • Launch via double-click / 'open' (LaunchServices) — that's what makes the Dock
    + Finder show "$APP_NAME". (Running the inner launch script directly bypasses
    LaunchServices and the Dock falls back to "wine".)

  • Menu bar — the bold name reads "$APP_NAME" (we rewrite the unix loader's embedded
    __info_plist CFBundleName). The dropdown is populated by an injected in-process shim
    (Resources/appmenu.dylib, via DYLD_INSERT_LIBRARIES): About / Preferences… / Hide /
    Hide Others / Show All / Quit, plus a Window menu. Preferences… opens winecfg (Wine
    settings) — Designer's own File/Edit/etc. live inside its window, Windows-style.
    ⌘Q quits regardless of the menu.

  • Little Snitch / firewall — the loader Info.plist also gives the process a bundle
    name + id, so Little Snitch may now show "$APP_NAME" instead of "wine"; if it
    still says "wine", that's wine's binary identity and is cosmetic. Allow it once.
    Two prompts to expect:
      127.0.0.1  (loopback)      ALLOW, required — else every web pane (Monaco
                                 editor, help, splash) stays blank (CEF + the
                                 embedded qsys-eumlator server use loopback).
      224.0.0.251:5353 (mDNS)    optional — Q-SYS LAN device discovery. Allow to
                                 auto-find a Core on the LAN; deny is harmless
                                 (discovery just stays empty).

  • Rosetta shelf-life clock: this path is x86_64 Wine under Rosetta 2. Rosetta is
    fully available through macOS 26 + macOS 27; macOS 28 (~fall 2027) removes
    general x86_64 translation and this breaks. Rosetta-proof fallback after that:
    a UTM Windows-11-ARM VM (real Windows, no Rosetta).
EOF
}
