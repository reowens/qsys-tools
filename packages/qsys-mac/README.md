# qsys-mac

`qsys-mac` is an npm bootstrapper for the signed, notarized Q-SYS Mac
Installer DMG. The npm package does **not** contain Q-SYS Designer, Wine, .NET,
or the macOS app payload; it downloads the GitHub Release DMG, verifies its
SHA-256 checksum, mounts it, and delegates to the bundled `qsys-mac` helper.

The current bootstrapper pins
[`qsys-mac-installer 0.1.4`](https://github.com/reowens/qsys-tools/releases/tag/qsys-mac-installer-v0.1.4)
with SHA-256 `c0c41dd235cf49bd9bdae5454d7ff123cfd93cdf936c30cf1b66593dda3d12f0`.

You still provide your own Q-SYS Designer Windows installer from QSC.

```sh
npx qsys-mac install "/path/to/Q-SYS Designer Installer 10.4.0.exe"
```

Other commands delegate to the same helper in the DMG:

```sh
npx qsys-mac status
npx qsys-mac doctor
npx qsys-mac remove
```

`doctor` prints read-only support diagnostics: Rosetta state, installed app/data state, bundled
helper presence, signatures where practical, running status, and log paths. It does not repair,
provision, remove, or upload anything.

## Requirements

- macOS on Apple Silicon.
- Node.js 18.17 or newer.
- Rosetta 2: `softwareupdate --install-rosetta --agree-to-license`.
- Your own `Q-SYS Designer Installer X.exe`, downloaded from qsys.com.

The signed installer DMG bundles Wine, .NET, `7z`, icon tooling, `msiinfo`, and
native helper binaries. Normal setup does not need Homebrew or host Python.

## Homebrew Alternative

Homebrew can install the GUI installer app:

```sh
brew tap reowens/qsys
brew trust reowens/qsys
brew install --cask qsys-mac-installer
open -a "Q-SYS Mac Installer"
```

`brew trust` is required by current Homebrew for third-party cask taps.

## Cache

The DMG is cached at:

```text
~/Library/Caches/qsys-mac/qsys-mac-installer-0.1.4.dmg
```

If the cached file is missing or does not match the pinned SHA-256 checksum,
`qsys-mac` downloads it again before mounting.

## Local DMG

For release testing, point the bootstrapper at a locally built DMG:

```sh
npx qsys-mac --dmg packages/qsys-mac-installer/dist/qsys-mac-installer.dmg status
```

Local DMG overrides are not checksum-verified.

## Source Checkout

Inside the `qsys-tools` monorepo, use the workspace script instead of `npx
qsys-mac`; otherwise npm may resolve the local workspace package before the
published package:

```sh
npm run qsys-mac -- status
npm run qsys-mac -- doctor
npm run qsys-mac -- --dmg packages/qsys-mac-installer/dist/qsys-mac-installer.dmg status
```
