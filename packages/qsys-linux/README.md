# Q-SYS Designer on Linux

An initial working **Ubuntu 26.04 x86-64** recipe for the Windows **Q-SYS
Designer 10.5.1**, through **Wine Staging 11.20** and **Windows .NET 10.0.14**.
It installs per-user without sudo and supplies a `qsys-linux` command and a
**Q-SYS Designer** desktop launcher.

This is an independent BYO-installer wrapper. Supply your own Q-SYS ZIP/EXE
from the vendor; this repository contains no QSC software. The Mac installer
remains a separate frontend. The `qsys-linux` npm package is prepared for its
first publication; the source command below works now.

## Install

Requirements: Ubuntu 26.04 amd64, Python 3, `apt-get`, `dpkg-deb`, `ldd`,
`xdpyinfo` (`x11-utils`), Internet access, an accessible X11/XWayland desktop,
and **12 GiB free** during installation. The installed prefix and toolchain
occupy approximately 6 GiB. Run as your regular desktop user.

From this monorepo:

```sh
packages/qsys-linux/qsys-linux install "/path/to/Q-SYS_Designer_Installer_10.5.1.zip"
# Or supply the extracted Q-SYS Designer Installer 10.5.1.exe.

~/.local/bin/qsys-linux doctor
~/.local/bin/qsys-linux launch
~/.local/bin/qsys-linux launch "/path/to/a design.qsys"
```

After the first npm publication, the equivalent entry point will be:

```sh
npx qsys-linux install "/path/to/Q-SYS_Designer_Installer_10.5.1.zip"
npx qsys-linux launch
```

The npm launcher requires Node.js 22.13 or later and Python 3. Installing the
npm package only installs the recipe; `install` performs Designer provisioning.
The package includes the public MSI/font helpers and licensed fonts, so it
does not need this monorepo alongside it.

You can also open **Q-SYS Designer** from your desktop's application menu.
The desktop launcher supports opening a design file; it does not change
existing `.qsys` file associations.

The recipe downloads checksum-pinned Wine and .NET installers. Wine's pin was
verified against WineHQ's signed Ubuntu package index; the runtime SHA-512
pins come from Microsoft's .NET 10 release metadata. Small Ubuntu extraction
tools are downloaded through apt's authenticated package indexes and unpacked
under this installation. It does not install system packages or add apt sources.
Some less complete Ubuntu installations may need additional Wine host libraries;
setup reports missing linked libraries and keeps its installation log.

The ZIP is opened selectively to obtain the Designer installer. Its InstallAware
bootstrapper is not run: 7zip extracts the payload and the existing
[MSI assembler](../qsys-mac-installer/lib/assemble-msi.py) reconstructs the full
layout from MSI metadata. The existing Python font helper and OFL Selawik fonts
are also reused. No custom Wine build, Wine Mono, or Rosetta is required.

## Installed files and commands

Data defaults to `$XDG_DATA_HOME/qsys-designer`, or
`~/.local/share/qsys-designer`. It contains the private Wine prefix, extracted
toolchain, the recipe's public support files, a version/checksum manifest, and
`install.log` / `designer.log`. Download/extraction scratch is temporary and is
removed after installation. An explicit `--downloads /path/to/scratch` option
can reuse checksum-verified Wine/.NET downloads while developing the recipe.

```sh
qsys-linux status           # recorded installation versions and checksums
qsys-linux doctor           # display, Wine, runtimes, and real loopback check
qsys-linux scale 200        # 200% UI scaling for a high-DPI screen; close Designer first
qsys-linux launch [design]  # logs output and reaps this prefix's Wine processes on exit
qsys-linux remove           # removes desktop/convenience launchers; keeps installed data
qsys-linux remove --purge   # also deletes installed data, user files, and retained prefixes
```

Mutating operations share a lock, so close Designer before reinstalling or
removing it. Reinstallation copies the existing prefix into a staging prefix,
preserves Windows settings and user files, and replaces the recorded application
payload. After validation, it installs that prefix and retains the full previous
one as `prefix.previous-<timestamp>-<id>` for recovery. Failed installation or
launcher handoff restores the previous prefix. Retained prefixes consume disk
space; remove a particular backup yourself once you no longer need it.
UI scale is preserved on reinstall, or set it during setup with `--scale 200`.
Desktop launches use support files copied into the data directory, so they
survive expiry of an `npx` cache. A global npm bin symlink is preserved.

For isolated tests, use:

```sh
packages/qsys-linux/qsys-linux --data-dir "/path/to/test install" install "/path/to/installer.zip" --no-integrate
packages/qsys-linux/qsys-linux --data-dir "/path/to/test install" launch
```

`QSYS_WINEDEBUG` overrides the normally quiet Wine debug channels when diagnosing
a problem. The tested rendering path is X11, with WPF/software GL and a local
Segoe UI font shim. No CEF flags are passed: Designer treats a leading argument
as a design filename. Launch converts the optional Linux filename via Wine's
`winepath` and forwards it as the single design argument.

## Validation and limits

On Ubuntu 26.04 x86-64, Designer 10.5.1 rendered on the native XWayland desktop.
Automated interaction runs in an authenticated Xvfb/Openbox display: a real
design loads, Monaco accepts and saves Lua edits, the script runs, UCI layout
renders, and Designer Emulate answers the native QRC client. Control writes,
readback, and change-group updates have been verified against Designer itself.
Fresh installation has also been exercised with spaces in its data path.
On the native GNOME Wayland/XWayland desktop, the user confirmed the installed
application works after setting Wine UI scale to 200%. The `scale` command saves
that setting for future launches.

Real Core deployment, USB provisioning, other distributions, ARM Linux, and
native Wayland mode have not been validated. Broader clipboard, drag/drop, and
multi-monitor checks remain useful. The installer
GUI, `.deb` distribution, and extracted application icon are future polish.

Hermetic checks use no Wine or proprietary payload:

```sh
pnpm --filter qsys-linux test
```

The Linux recipe is MIT licensed under the monorepo's [LICENSE](../../LICENSE).
