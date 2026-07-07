# qsys-mac

`qsys-mac` is an npm bootstrapper for the signed, notarized Q-SYS Mac
Installer DMG. The npm package does **not** contain Q-SYS Designer, Wine, .NET,
or the macOS app payload; it downloads the GitHub Release DMG, verifies its
SHA-256 checksum, mounts it, and delegates to the bundled `qsys-mac` helper.

The current bootstrapper pins
[`qsys-mac-installer 0.1.1`](https://github.com/reowens/qsys-tools/releases/tag/qsys-mac-installer-v0.1.1)
with SHA-256 `0137f6f5ebf74a951030f20a1b115f27a9d8ccc8075de5813878bf7c242242f9`.

You still provide your own Q-SYS Designer Windows installer from QSC.

```sh
npx qsys-mac install "/path/to/Q-SYS Designer Installer 10.4.0.exe"
```

Other commands delegate to the same helper in the DMG:

```sh
npx qsys-mac status
npx qsys-mac remove
```

## Requirements

- macOS on Apple Silicon.
- Node.js 18.17 or newer.
- Rosetta 2: `softwareupdate --install-rosetta --agree-to-license`.
- msitools: `brew install msitools`.
- Xcode Command Line Tools: `xcode-select --install`.
- Your own `Q-SYS Designer Installer X.exe`, downloaded from qsys.com.

The signed installer DMG bundles Wine, .NET, `7z`, and icon tooling. `msitools`
and Python from the Command Line Tools are still required because the wrapper
reads the installer MSI layout and runs local assembly scripts.

## Cache

The DMG is cached at:

```text
~/Library/Caches/qsys-mac/qsys-mac-installer-0.1.1.dmg
```

If the cached file is missing or does not match the pinned SHA-256 checksum,
`qsys-mac` downloads it again before mounting.

## Local DMG

For release testing, point the bootstrapper at a locally built DMG:

```sh
npx qsys-mac --dmg packages/qsys-mac-installer/dist/qsys-mac-installer.dmg status
```

Local DMG overrides are not checksum-verified.
