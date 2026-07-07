# Q-SYS Designer on macOS — BYO-installer wrapper

Run QSC's **Q-SYS Designer** (Windows-only) on Apple Silicon macOS, using a **free**
Wine build. This repo is a **recipe** — it contains **zero QSC bytes**. You bring your
own free Designer installer (a "BYO" download from qsys.com); the wrapper extracts it,
provisions a Wine prefix, and emits a `Q-SYS Designer.app`.

> **Unofficial — not affiliated with, endorsed, or sponsored by QSC, LLC.** "Q-SYS" and
> "Q-SYS Designer" are trademarks of QSC, LLC, used here only nominatively to name the
> software you supply. This is an independent, community-built wrapper.

> **Status: working signed/notarized wrapper.** Designer 10.4.0 launches and renders a fully
> usable design surface — WPF shell, the CefSharp/CEF subprocesses, *and* the Monaco
> script editor — under free `wine-staging 11.10` on an M4 Pro / macOS 26. No paid
> CrossOver, no VM. Source is public at
> [`reowens/qsys-tools`](https://github.com/reowens/qsys-tools) (`packages/qsys-mac-installer`),
> licensed **GPL-3.0-or-later** (see [Legal & release](#legal--release)).

---

## Why this exists

Q-SYS Designer is a **.NET 8 (x64) WPF** app with an embedded **CefSharp/CEF** Chromium
pane. There is no native macOS build and no clean way to port one without QSC's source.
The realistic path is a compatibility layer. This wrapper is the automation around that
layer — the same model Wine/CrossOver/Whisky operate under: *a tool isn't a derivative
work of software it doesn't contain.* Because Designer is a free download, the wrapper
never redistributes it.

## Requirements

- **Apple Silicon Mac** (arm64) with **Rosetta 2**
  (`softwareupdate --install-rosetta --agree-to-license`).
- **Your own** `Q-SYS Designer Installer X.exe`, downloaded free from qsys.com.

The signed `qsys-mac-installer.dmg` bundles Wine, .NET, `7z`, icon tooling, `msiinfo`, and the
native assembly/font helpers, so first run does not download those dependencies and does not need
Homebrew p7zip/icoutils/msitools or host `python3`. Source-only development that skips the bundled
`Resources/bin` tools still needs **p7zip** (`brew install p7zip`) and **msitools**
(`brew install msitools`), and may use **icoutils** (`brew install icoutils`) for the app icon.

## Usage

Recommended for most users: download the signed DMG, open it, drag/copy `Q-SYS Mac Installer.app`,
run it once, then trash the installer app when you are done. The installed `Q-SYS Designer.app` and
its Application Support data remain.

Direct signed-DMG path: download
[`qsys-mac-installer.dmg`](https://github.com/reowens/qsys-tools/releases/tag/qsys-mac-installer-v0.1.4),
open `Q-SYS Mac Installer.app`, and drop your Q-SYS Designer installer into the window.

npm/bootstrapper path:

```sh
npx qsys-mac install "/path/to/Q-SYS Designer Installer 10.4.0.exe"
open -a "/Applications/Q-SYS Designer.app"
```

Homebrew path:

```sh
brew tap reowens/qsys
brew trust reowens/qsys
brew install --cask qsys-mac-installer
open -a "Q-SYS Mac Installer"
```

`brew trust` is required by current Homebrew for third-party cask taps.

Source recipe path:

```sh
./build.sh --installer "/path/to/Q-SYS Designer Installer 10.4.0.exe"
open -a "$HOME/Applications/Q-SYS Designer.app"
```

`build.sh --help` lists all flags (custom prefix, output path, reusing an existing Wine
`.app`, `--skip-dotnet` to rebuild against an already-provisioned prefix). To launch a
prebuilt prefix without the `.app` (dev/debug), use `./launch.sh`.

### After first launch — two things that bite

1. **Little Snitch / any loopback firewall:** the `Q-SYS Designer` process triggers two
   distinct prompts —
   - **`127.0.0.1` (loopback) — ALLOW, required.** CEF and the embedded emulator
     HTTP server (which serves the Monaco editor + help panes) talk over loopback — block
     it and **every web pane stays blank.** This looks exactly like a render failure but isn't.
   - **`224.0.0.251:5353` (mDNS / Bonjour multicast) — optional.** This is Q-SYS LAN
     device discovery: Designer multicasts to find Cores and peripherals on your network.
     **Allow** it if you want Designer to auto-discover a real Core on the LAN; **deny** it
     and nothing breaks — discovery just stays empty (fine if you have no Core).
2. **`/etc/hosts`:** `build.sh` warns if your hostname isn't mapped. Wine's
   `getaddrinfo` can't resolve the bare Mac hostname; add (needs sudo):
   ```
   127.0.0.1 <your-hostname>
   ::1 <your-hostname>
   ```

### Known visual limitations

- **Drop shadows do not render correctly.** Designer's functional UI works, but WPF drop shadows
  are a known cosmetic miss under the current Wine/Rosetta path
  ([tracked here](https://github.com/reowens/qsys-tools/issues/1)).

### Opening your files — the `Z:` drive

The prefix is **not** wired to your Mac home. By default Wine symlinks the Windows profile's
Desktop/Documents/Downloads/Music/Pictures/Videos straight to `~/Desktop`, `~/Downloads`, … —
which means booting the prefix (and Designer itself) reaches into macOS's TCC-protected folders
and you get unprompted *"Q-SYS Designer wants to access your Downloads"* dialogs. For a tool you
run for real work, silently grabbing your home folders is a red flag, so the wrapper deliberately
**doesn't**: those profile folders stay empty and prefix-local.

Reach your real files through Wine's `Z:` drive, which maps `Z:\` to `/`. In Designer's
**File ▸ Open** dialog, browse to:

```
Z:\Users\<your-mac-username>\Downloads\your-design.qsys
```

macOS still gates the *first* access to a protected folder — but only if/when **you** browse into
one, attributed to `Q-SYS Designer.app`, once. Allow it and that folder is remembered; nothing is
requested before you ask for it. (You can review/revoke under **System Settings ▸ Privacy &
Security ▸ Files and Folders**.)

**Prefer the folders show up directly?** There's an opt-in for that: **`Q-SYS Designer` menu ▸ Link
to User Directories** swaps the empty profile folders for symlinks to your real `~/Desktop`,
`~/Documents`, `~/Downloads`, `~/Music`, `~/Pictures` and `~/Movies`, so they appear right in the
Open/Save dialogs — the same access, just *commanded by you* from the menu instead of taken silently
at install. **Unlink User Directories** reverses it (only ever replacing *empty* folders, so nothing
you saved locally is lost). macOS still prompts on first real use, attributed to `Q-SYS Designer.app`.

## Native installer app

Alongside the CLI, a native macOS **installer app** (`app/`) lets non-terminal users get the
same result by **dropping their installer onto a window**. You download
`qsys-mac-installer.dmg` and run `Q-SYS Mac Installer.app`; it shows a setup UI that runs the recipe (via
`provision.sh`) into `~/Library/Application Support/Q-SYS Designer/`, streams progress, then
**places `Q-SYS Designer.app` into `/Applications`** — wearing the real Q-SYS icon extracted
from your own installer — which you then launch like any app. See
[Distribution](#distribution--signed--notarized-dmg).

It's a **launcher + setup front-end, not a re-implementation** — the running Designer is
still Wine + the same in-process shims (menu/name/icon). A native wrapper *can't* own Wine's
menu bar: `winemac.drv` creates the Cocoa windows + menu **inside the wine process**, so the
shims stay the only place to fix them. The Swift app natively owns the setup experience, the
`.app`'s Dock/Finder identity, and the Developer-ID-notarized download surface.

Build it with `xcodegen generate && xcodebuild` in `app/` (see `app/project.yml`). Status:
launcher + setup UI working; Wine, .NET, `7z`, icon tooling, `msiinfo`, and native helper binaries
are **bundled** so first run does not need those downloads/tools or host Python. Setup
shows determinate per-step progress, a live extract %, a Cancel button, and surfaces real
errors with partial-state cleanup + resume.
**Signing/notarization is scripted** (`scripts/package.sh`) for release builds — see
[Distribution](#distribution--signed--notarized-dmg) below.

### Native helper path

`scripts/bundle-deps.sh` builds native Swift ports of the former runtime Python helpers:
`Resources/bin/qsys-assemble-msi` for MSI layout assembly and
`Resources/bin/qsys-rename-font-family` for the local Segoe UI font shim. The recipe uses these
native helpers by default; set `QSYS_ASSEMBLE_MSI=/path/to/qsys-assemble-msi` or
`QSYS_RENAME_FONT_FAMILY=/path/to/qsys-rename-font-family` to override them. Python is now an
explicit developer fallback only: set `QSYS_USE_PYTHON_HELPERS=1` when comparing/debugging the old
helper scripts. Validate parity with:

```sh
scripts/compare-assemble-msi.sh "/path/to/Q-SYS Designer Installer 10.4.0.exe"
scripts/compare-rename-font-family.sh
```

## Distribution — signed & notarized `.dmg`

`scripts/package.sh` produces a Gatekeeper-clean **`qsys-mac-installer.dmg`** holding two bundles:

- **Q-SYS Mac Installer.app** — what you download + run. Deep-signed with a **Developer ID
  Application** identity + hardened runtime, notarized, stapled. It shows the setup UI,
  provisions Wine+Designer into `~/Library/Application Support`, then **places
  `Q-SYS Designer.app` into `/Applications`** and is done — so the dmg has no drag-to-Applications
  step; the installer puts the app there itself.
- **Q-SYS Designer.app** (the launcher) — shipped *inside* the installer, Developer-ID signed so
  the installer notarizes the nested code. At install time the installer copies it to
  `/Applications`, **bakes the real Q-SYS icon** (extracted from your own installer — zero QSC
  bytes shipped) into `Contents/Resources`, and ad-hoc re-signs it. The emitted app is ad-hoc
  but **created locally → not quarantined → Gatekeeper opens it** (the original `build.sh`
  model). Per-user icon and notarization are mutually exclusive here: a custom Finder icon sets a
  `com.apple.FinderInfo` xattr that fails `codesign --strict` on macOS 26, so we bake the icon
  into the bundle and re-sign instead.

Signing is **inner → outer, never `--deep`** over the nested launcher (that would clobber its
signature); the build asserts the nested launcher stays valid after the outer sign. The dmg
carries `THIRD-PARTY-NOTICES.md` (bundled-dep licenses + the icoutils GPLv3 source offer) and is
itself signed + notarized + stapled.

Wine is *not* inside either app bundle — it ships as a tarball in `Resources/cache` and is extracted
+ ad-hoc-signed into `~/Library/Application Support/Q-SYS Designer/` at **provision** time,
outside notarization. So the notarized surface is just the Swift code + the `Resources/bin`
toolchain (`7z`, icoutils, `appmenu.dylib`, the pre-patched Wine loader).

The app's entitlements (`app/QSYSDesigner.entitlements`) grant the JIT / W^X / no-library-
validation that Wine's x86_64-under-Rosetta JIT and the DYLD-injected menu shim need under
hardened runtime.

```sh
# one-time: create a Developer ID Application cert (team 7GSPYYN5X8) and store notary creds
xcrun notarytool store-credentials qsys-notary   # API key OR apple-id + app-specific password

# dry run (ad-hoc, no Apple round-trip) — proves the sweep + dmg build
scripts/package.sh

# real, shippable, notarized dmg
DEV_ID="Developer ID Application: Robert Owens (7GSPYYN5X8)" \
  NOTARY_PROFILE=qsys-notary  scripts/package.sh
```

Gated only on the **Developer ID Application** certificate being in the keychain — the
platform's existing Developer ID *Installer* cert (used for Wi-Fi config profiles) is a
different type and can't sign apps; create the Application cert under the same membership.

### Headless CLI (`qsys-mac`)

The GUI runs `provision.sh` + the emit step; `qsys-mac` (shipped in the installer's
`Contents/Resources`) exposes the same thing for SSH / scripted use — no window needed:

```sh
RES="/Volumes/Q-SYS Mac Installer/Q-SYS Mac Installer.app/Contents/Resources"
QSYS_RES="$RES" "$RES/qsys-mac" install "/path/to/Q-SYS Designer Installer 10.4.0.exe"
"$RES/qsys-mac" status     # provisioned? where's the app? running?
"$RES/qsys-mac" doctor     # read-only support diagnostics
"$RES/qsys-mac" remove     # uninstall app + data dir; stops Wine first so nothing orphans
```

It produces a byte-identical result to the GUI emit (same data dir, same ad-hoc-signed app
with the baked QSC icon). `qsys-mac` self-locates its sibling Resources, or point it anywhere with
`QSYS_RES`. `doctor` never mutates state; it reports Rosetta, resource, signature, provisioned,
installed-app, running, and log-path diagnostics for support. This is also the most portable base
for a future Linux port — the `install`/`remove`/`status`/`doctor` surface stays; only the recipe
internals behind it would change.

## How it works

`build.sh` runs the recipe in `lib/recipe.sh`:

1. **Wine** — reuse an existing free build or download the pinned `wine-staging 11.10`
   (gcenx `macOS_Wine_builds`); ad-hoc codesign + de-quarantine.
2. **Prefix** — `WINEARCH=win64 wineboot --init`.
3. **.NET 8** — silent-install the **WindowsDesktop** *and* **ASP.NET Core** runtimes
   (8.0.28). Both are required — Designer's `runtimeconfig` needs NETCore + WindowsDesktop
   + AspNetCore.
4. **Extract** your installer with `7z` (the InstallAware GUI bootstrapper deadlocks
   under Wine, so we bypass it and assemble from the MSI layout ourselves).
5. **Assemble the complete app from the MSI layout.** InstallAware shatters the payload across
   opaque `OFFLINE/<hash>/<hash>` dirs whose names change every Designer build, and ships a
   metadata-only MSI alongside them. That MSI's `Directory`/`Component`/`File` tables encode, for
   every file, both its OFFLINE source and its install target (in `DefaultDir`'s `[target]:[source]`
   form), so the wrapper (`lib/assemble-msi.py`, via `msiinfo`) reconstructs the **whole** install
   tree — every component definition, plugin, symbol and DLL — instead of hand-picking a few dirs.
   The MSI is authoritative and self-consistent within each build, so this survives version bumps.
6. **Prefix tweaks** — WPF software-render reg key; pre-create the prefs dir.
7. **Emit a self-contained `Q-SYS Designer.app`** — Wine and the prefix are cloned
   *inside* the bundle (APFS clonefile → ~free on disk), and the launcher computes its
   paths relative to itself, so the `.app` is movable and has no dependency on the build
   dir.

### Naming — what shows as "Q-SYS Designer" and what shows as "wine"

- **Dock + Finder name: `Q-SYS Designer` ✅** — comes from the bundle's `CFBundleName`,
  **as long as you launch via LaunchServices** (double-click or `open -a`). Running the
  inner `Contents/MacOS/launch` script directly bypasses LaunchServices and the Dock
  falls back to "wine".
- **Menu-bar app name: `Q-SYS Designer` ✅** — the bold app menu (and the "Quit/Hide
  …" items) is AppKit's `applicationName`, which it reads **once at init from the main
  bundle's `CFBundleName`** — not from menu-item titles, and not from the process name
  (so neither a `setTitle:` patch nor a `processName` swizzle changes it). Wine re-execs
  into a *loose* loader at `lib/wine/x86_64-unix/wine` whose **embedded `__info_plist`**
  (a `__TEXT,__info_plist` Mach-O section) ships `CFBundleName=Wine`. An on-disk adjacent
  `Info.plist` was tried and proved unreliable, so the wrapper rewrites that embedded
  plist in place (`lib/patch-loader-plist.py`, then re-signs). Works on **stock Wine** —
  no winemac patch, no injected dylib, no custom build.
- **Little Snitch: likely `Q-SYS Designer`, possibly `wine`** — the patched embedded
  plist also sets `CFBundleIdentifier`, which Little Snitch may adopt. If it still shows
  `wine` (its own binary identity), that's cosmetic — just allow the process once
  (loopback rule below).
- **Dock/app icon: `Q-SYS Designer` ✅** — extracted from `Q-Sys Designer.exe` at build
  time (`wrestool` → `icotool` → padded to a macOS-style margin → `iconutil` →
  `QSYSDesigner.icns`), set via `CFBundleIconFile` and re-forced at runtime by the shim.
  Needs `icoutils` (`brew install icoutils`); falls back to a generic icon if absent.
- **macOS app menu: populated ✅** — an in-process shim (`Resources/appmenu.dylib`,
  injected via `DYLD_INSERT_LIBRARIES`) installs **About / Preferences…(→ winecfg) / Hide /
  Hide Others / Show All / Quit** + a Window menu. Designer's own File/Edit/etc. live
  inside its window (Windows-style); `winecfg` is reachable via Preferences….

### The recipe, decoded

Every launch token is load-bearing — these were each a debugging session:

| Token | Why |
|---|---|
| `WINEDLLOVERRIDES="mshtml=d"` | **mscoree ON.** Disabling it (e.g. `mscoree,mshtml=`) breaks the IL-only managed-assembly loader → fake CLR crash `0x80131506` before any UI. Only Gecko (`mshtml`) is disabled. The `mscoree,mshtml=` form is used **during .NET install only**, to skip the wine-mono prompt. |
| `DOTNET_EnableWriteXorExecute=0` | Rosetta 2 W^X compatibility for the .NET 8 JIT. |
| `LIBGL_ALWAYS_SOFTWARE=1` + `Avalon.Graphics\DisableHWAcceleration=1` | WPF software render. Without it the main window is black (`GL_INVALID_FRAMEBUFFER_OPERATION` from `glBlitFramebuffer`). |
| **no CEF command-line flags** | CefSharp adds `--no-sandbox` + ANGLE/SwiftShader to its own subprocesses programmatically. Passing them ourselves was redundant **and** broke startup: Designer's design-loader reads `argv[0]` as a design path, so a leading `--no-sandbox` got async-opened as a bogus "design" → an NRE dialog. Pass nothing. |
| `wine-staging 11.x`, **not** GPTK `wine-7.7` | GPTK's old Wine clears the CLR but then stack-overflows during init (main-thread stack too small). |

## Rosetta shelf-life clock ⏳

This path is **x86_64 Wine under Rosetta 2**. Per Apple's WWDC 2025 statement, Rosetta 2
is **fully available through macOS 26 (current) and macOS 27**; from **macOS 28
(~fall 2027)** it is reduced to a legacy-game subset and **general x86_64 translation —
which this recipe needs — is removed.** So this free-Wine path has runway of roughly
**18 months (through macOS 27)**, then breaks.

**Rosetta-proof fallback for macOS 28+:** a **UTM virtual machine running Windows 11 ARM**
(real Windows, no Rosetta) — slower to set up, but durable. A future ARM-native Wine build
is the other candidate but is unproven for this app.

## Legal & release

> **Trademark & affiliation.** This project is **not affiliated with, endorsed, or sponsored
> by QSC, LLC.** "Q-SYS" and "Q-SYS Designer" are trademarks of QSC, LLC; they appear here
> only nominatively to identify the software you supply. The wrapper ships no QSC code.

A full feasibility + EULA analysis backs this release. Summary:

- The Q-SYS EULA (Rev NR) has **no Windows-only / no-emulation / no-virtualization clause**
  — QSC's own installer anticipates "ARM64 OS running Emulation."
- This wrapper ships **no QSC code** → not a derivative work, not a redistribution.
- The one real caution is the EULA's **inducement** clause (x), which bears on *public
  distribution* — so this uses only nominative trademark references, ships no QSC bytes, and
  documents the BYO model clearly.
- **None of this is legal advice.**

### Bundled third-party components

The app bundles free, redistributable deps for Wine/.NET, `7z`, icon extraction, MSI table
inspection, and native assembly/font helpers so first-run setup does not download those payloads or
require host `python3`.
Full table + license texts in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), which is
shipped inside the `.dmg`. In brief: **Wine** (LGPL-2.1), **.NET 8 runtimes** (Microsoft .NET
Library License for the redistributable binaries; source MIT), **p7zip** (LGPL/GPL), **libpng**
(zlib-style), and **icoutils**
(`wrestool`/`icotool`, **GPL-3.0**), and **msiinfo/msitools** (GPL/LGPL with GLib/libgsf/gettext/PCRE2
runtime libraries). GPL components are why the distribution carries a **written source offer**
(in the notices file). Each dep is invoked as a separate process at
provision time (mere aggregation), so it does not force the wrapper's license — the wrapper is
**GPL-3.0-or-later** by choice, for one consistent license across the distribution.

### License & contact

This wrapper is licensed **GPL-3.0-or-later** — see [`LICENSE`](LICENSE). Copyright © 2026
Robert Owens. Source is public at <https://github.com/reowens/qsys-tools> (`packages/qsys-mac-installer`).

For the GPLv3/LGPL **written source requests** (icoutils, Wine, p7zip), or any question, email
**robowens@me.com** or open an issue at
<https://github.com/reowens/qsys-tools/issues>.

## Layout

```
build.sh         the processor: provision + assemble + emit .app
provision.sh     provision the recipe into a data dir (no .app emit; used by the native app)
launch.sh        run a built prefix directly (dev/debug)
lib/recipe.sh    the recipe — wine, .NET, content-discovery, assembly, .app emit
app/             native macOS Swift app (setup UI + launcher) — xcodegen project
scripts/         bundle-deps.sh (Tier-B offline deps) · package.sh (sign + notarize + dmg)
THIRD-PARTY-NOTICES.md   bundled-dep licenses + icoutils GPLv3 source offer (ships in the dmg)
```

## When a download 404s

Free-Wine distribution is volatile (gcenx's CrossOver-patched `winecx` cask was deleted
mid-2025). If `WINE_URL` or the `DOTNET_*` URLs 404, download equivalents manually and
point the wrapper at them:

```sh
WINE_APP="/path/to/Wine Staging.app" ./build.sh --installer ...   # reuse a local Wine
# or set WINE_URL / DOTNET_DESKTOP_URL / DOTNET_ASPNET_URL to fresh links
```

.NET 8 runtimes: <https://dotnet.microsoft.com/download/dotnet/8.0> (need **x64**,
WindowsDesktop **and** ASP.NET Core).

The silent .NET installers run under Wine and can occasionally stall before returning. The recipe
now bounds each runtime installer with `DOTNET_INSTALL_TIMEOUT_SECONDS` (default `900`) and stops
Wine for that prefix on timeout so setup fails cleanly instead of hanging forever. Increase it only
for unusually slow machines or while debugging a Wine/.NET install issue.
