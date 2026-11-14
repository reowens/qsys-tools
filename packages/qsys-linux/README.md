# Q-SYS Designer on Linux

An initial working **Ubuntu 26.04 x86-64** recipe for the Windows **Q-SYS
Designer 10.5.1**, through **Wine Staging 11.20** and **Windows .NET 10.0.14**.
It installs per-user without sudo and supplies a `qsys-linux` command and a
**Q-SYS Designer** desktop launcher.

This is an independent BYO-installer wrapper. Supply your own Q-SYS ZIP/EXE
from the vendor; this repository contains no QSC software. The Mac installer
remains a separate frontend. Install through the `qsys-linux` npm package or from
this source checkout.

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

The equivalent npm entry point is:

```sh
npx qsys-linux install "/path/to/Q-SYS_Designer_Installer_10.5.1.zip"
npx qsys-linux launch
```

The npm launcher requires Node.js 22.13 or later and Python 3. Installing the
npm package only installs the recipe; `install` performs Designer provisioning.
The package includes the public MSI/font helpers and licensed fonts, so it
does not need this monorepo alongside it.

### Updating

To move to a new qsys-linux release, run `install` again with the same QSC ZIP:

```sh
npx qsys-linux@latest install "/path/to/Q-SYS_Designer_Installer_10.5.1.zip"
```

The menu entry and `~/.local/bin/qsys-linux` run the copy of qsys-linux that
`install` placed in the installation, so they keep the old version until you
do this. `npx qsys-linux@latest launch` uses the new version at once. Running
`install` again keeps your Windows files, settings and UI scale. Close every
open design first; `install` refuses while Designer is running.

You can also open **Q-SYS Designer** from your desktop's application menu.
The desktop launcher supports opening a design file; it does not change
existing `.qsys` file associations.

The recipe downloads checksum-pinned Wine and x64 .NET runtime ZIPs. Wine's pin was
verified against WineHQ's signed Ubuntu package index; the runtime SHA-512
pins come from Microsoft's .NET 10 release metadata. Small Ubuntu extraction
tools are downloaded through apt's authenticated package indexes and unpacked
under this installation. It does not install system packages or add apt sources.
The runtime ZIPs populate the staged Windows prefix directly, avoiding the
32-bit installer bootstrapper. The Windows x64 host must report all three
required frameworks before the installation can be committed.
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

## Several designs open at once

Designer opens each design in its own process, and New Design starts another, as QSC's help
describes. Only 1 design can emulate at a time, which is also QSC's behaviour.

- **Opening another design:** File > Open and a second `qsys-linux launch <design>` both work while
  a design is open.
- **Closing a design:** Wine stops only after the last design closes. Until then `qsys-linux launch`
  stays running and says it is waiting for the other designs. Ctrl+C on that wait ends `launch`,
  which does not stop Wine or the other designs.
- **Install, remove and scale:** `install`, `remove` and `scale` refuse while any Designer of this
  installation is running, including a design still open after Ctrl+C on the wait, and tell you to
  close every open design. A Designer that closed or crashed does not block them.

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
GUI and `.deb` distribution are future polish.

The menu entry uses Designer's own icon, which `install` copies out of your installed Designer;
the package ships no QSC artwork.

Hermetic checks use no Wine or proprietary payload:

```sh
pnpm --filter qsys-linux test
```

## Container smoke tests

The source checkout includes a vendor-free Ubuntu 26.04 `linux/amd64` test
image with a private Xvfb/Openbox desktop. It runs the packaged `qsys-linux`
CLI as UID 1000, independently of a locked host desktop. Docker commands are
development tools in this checkout; they are not part of the npm launcher.
Container `.deb` extraction uses current libarchive for compatibility with
amd64 emulation. The image contains no Wine or Designer payload.

Install the checkout's dependencies with `pnpm install --frozen-lockfile`, then
run these commands from the monorepo root:

```sh
# Hermetic harness tests; no Docker daemon or proprietary inputs required.
pnpm docker:test

# Include current uncommitted public source in a local development image.
pnpm docker:build --development --receipt ../artifacts/docker-image.json

# Check the image, helpers and authenticated display without a vendor installer.
docker run --rm --init --platform linux/amd64 --network none \
  qsys-designer-test:local check

# Supply only your own installer and an optional disposable design.
pnpm docker:smoke --installer "/path/to/installer.zip" \
  --design "/path/to/disposable design.qsys" \
  --artifacts "../artifacts/docker-basic" --profile basic

# Apple Silicon Docker Desktop: explicit experimental QEMU/Wine UI mode.
pnpm docker:smoke --execution hybrid-qemu --emulator "/private/path/qemu-x86_64" \
  --installer "/path/to/installer.zip" --design "/path/to/disposable design.qsys" \
  --docker-data-dir "/actual/Docker/disk-image/directory" \
  --artifacts "../artifacts/docker-pro-basic" --profile basic
```

The runner requires Node.js, host `python3`, an existing local image and Docker
engine. Python supplies descriptor-relative artifact setup and macOS filesystem
operations; nothing is installed implicitly. It streams only
the selected installer/design and, in hybrid mode, the pinned emulator into private Docker volumes, mounts inputs read
only for the test, exports results to the specified empty directory, and removes
its own containers and volumes. It does not start Docker, pull images or alter
daemon settings. The test container needs Internet access for the recipe's
verified runtime downloads. The UI and Emulate remain on the default Docker
bridge during this lifecycle, so they can reach the bridge gateway and peer
containers; this does not establish network isolation. It uses no host display,
host networking mode or privileged access. It drops Linux capabilities, blocks gaining privileges and limits the
process count. Per-run downloads and installed data are removed with its volumes;
the runner performs a fresh installation on each invocation. With
`--cache-volume <name>`, it creates or reuses a volume labeled for runtime downloads
and retains that volume. Each reused archive is checksum-verified. Work, home,
prefix, vendor inputs and artifacts still use fresh per-run volumes and are removed.
A named container lease excludes simultaneous cache users; a foreign volume or
existing lease is refused. Remove your selected cache volume explicitly when no
run is using it. The runner never prunes other Docker data.

Defaults are `--memory 8g --cpus 4 --shm-size 1g`; adjust them to the admitted
capacity of the machine. Passing runs can still hit this memory limit or use
swap; inspect `resources` in the result, including `memory.stat` for anonymous
memory versus file cache. Admission checks report insufficient engine resources
or free space before staging private inputs. On macOS the runner also finds
the bundled `/Applications/Docker.app/Contents/Resources/bin/docker` CLI.
`--docker` and `--context` select an existing CLI/context. Local Mac runs also
require `--docker-data-dir` pointing to the actual Docker disk-image directory
shown in Docker Desktop settings; VM free space does not establish host capacity.
The host filesystem must meet the install budget and `--host-free-floor` (40g
by default). A context targeting
another machine establishes execution on that machine; local Mac Docker
Desktop requires its own Wine/.NET/CEF qualification.

The default `native` mode requires an amd64 engine. An ARM64 engine requires
explicit `--execution hybrid-qemu` and the qualified ARM64 QEMU binary described
in [qemu-pin.json](docker/qemu-pin.json). Its checksum is checked both before
staging and inside the image. The pin records the existing source image/path and
upstream license/source references. This command neither downloads nor registers
QEMU. The binary remains a separate runtime input and is not distributed in the
test image or npm package.

Hybrid mode provisions through the Docker engine's existing amd64 translator
(Rosetta in the Apple Silicon qualification), then runs Designer/Wine through QEMU with
explicit experimental .NET JIT settings and an image-built process-memory
compatibility helper. Installation still needs that existing translator. See
[execution qualification](docker/QUALIFICATION.md) for measured coverage and limits.

`result.json` summarizes application and runner outcomes, and `runner.json` records
the engine, image ID, execution policy, input hashes, budgets, artifact export and cleanup failures.
`container/phases.json` records provisioning and application outcomes separately;
`container/provisioning.json` binds the completed install to the run, installer
and fresh prefix and records cache state before/after installation. A passing
UI result cannot bypass failed or mismatched phase receipts. Raw application
results, logs and screenshots are exported under `container/`; exported symlinks
and special files are refused. Invalid application JSON remains there for diagnosis.
Without `--artifacts`, output defaults to a private system temporary directory.
Explicit artifact paths must not contain symlink ancestors; the error names the
offending component. Use a canonical path or a relative path from the physical
working directory. The configured temporary root and known macOS system aliases
are resolved once before checking their descendants.
The private host-only `journal/` directory contains immutable numbered snapshots
of allocation intent and resource state, written before daemon allocation. It
helps identify owned resources after a driver crash. An incomplete journal is
recovery evidence, not an acceptance pass; require the successful CLI exit and
validated result/phase receipts. SIGKILL or host failure cannot guarantee automatic
cleanup. Inspect the recorded context, run labels and cache users before operator
recovery, and release a stale cache lease only after its owned users are removed.
Snapshots are synchronized for process-crash diagnosis, without a power-loss
durability guarantee. A terminal journal failure after the authoritative receipts
commit is a stderr warning and does not contradict their status or CLI exit.
Docker exports artifacts as a tar stream, without a host destination pathname.
The isolated Python extractor creates files through directory descriptors on
Linux and macOS, so changing an output ancestor cannot redirect extraction.
Only regular files and directories are allowed; links, special files, traversal,
duplicates, case/Unicode-normalization path collisions (including parent
directories) and malformed/truncated archives are rejected. Limits are 256 MiB per
file, 1 GiB total file data, 4,096 tar headers (including metadata), 64 KiB per
PAX metadata header and 32 path components. Export also has a 60-second deadline.
A rejected export may leave regular partial files in `container/` for diagnosis;
they do not establish a passing result. Keep the private artifact directory intact
until inspection/recovery is complete.
Logs and
screenshots may contain your private design. Keep the entire output directory
private. An unavailable or unimplemented required check must remain visible:
`--profile full` fails for incomplete coverage. A basic pass covers only the
checks recorded in its result. Container tests do not establish host clipboard,
HiDPI, USB, real Core deployment or native Mac app behavior.

To build a frozen committed revision, omit `--development` and optionally pass
`--revision <full-commit-sha>`. The image receipt records source/context hashes,
base digest and image identity. Explicit private publication uses:

```sh
pnpm docker:build --push --revision <full-commit-sha> \
  --registry <registry-host/optional-prefix> --image qsys-designer-test \
  --receipt ../artifacts/docker-publication.json
```

Publication requires existing Docker credentials and an operator-approved
registry repository/retention policy. It refuses an existing immutable revision
tag and uses a single `linux/amd64` manifest. Development images cannot be
published through this command. A successful push immediately records its digest
with `verification: "pending"`; inspection and pull checks must finish before
the receipt becomes `verification: "verified"`. A failed verification preserves
the published digest for recovery. Only explicitly staged public files and packed
packages enter the build context; vendor payloads, designs and test artifacts
must stay outside it. Pull the receipt's digest explicitly on another host,
then select it with `--image <repository>@sha256:<digest>` when running smoke.

The Linux recipe is MIT licensed under the monorepo's [LICENSE](../../LICENSE).
