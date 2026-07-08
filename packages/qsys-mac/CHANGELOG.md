# Changelog

All notable changes to the qsys-mac npm bootstrapper are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] - 2026-07-08

### Changed

- **Relicensed from GPL-3.0-or-later to MIT.** The wrapper/bootstrapper source is
  now MIT, matching the rest of the qsys-tools family. (The signed installer DMG
  remains a multi-license *binary* distribution because of the third-party
  components it bundles — see the installer's THIRD-PARTY-NOTICES.md.)
- `DEFAULT_RELEASE` now points at the `qsys-mac-installer 0.1.5` signed DMG.

## [0.1.4] - 2026-07-07

### Added

- `qsys-mac doctor` — read-only support diagnostics, delegated to the bundled
  installer helper.

## [0.1.3] - 2026-07-07

### Changed

- Defaults to the installer's native helper binaries, so normal setup no longer
  needs host Python.

## [0.1.2] - 2026-07-06

### Changed

- The bundled installer now ships `msiinfo`, so first-run setup no longer requires
  Homebrew `msitools`. Improved dev and prerequisite UX.

## [0.1.1] - 2026-07-06

### Added

- Initial release. Split out from `qsys-mac-installer` as the standalone npm
  bootstrapper: it downloads and SHA-256-verifies the signed Q-SYS Mac Installer
  DMG, mounts it, runs the bundled helper, and detaches. It contains no Q-SYS
  Designer or app payload — you supply your own free Designer installer download.

[Unreleased]: https://github.com/reowens/qsys-tools/tree/main/packages/qsys-mac
[0.1.5]: https://www.npmjs.com/package/qsys-mac/v/0.1.5
[0.1.4]: https://www.npmjs.com/package/qsys-mac/v/0.1.4
[0.1.3]: https://www.npmjs.com/package/qsys-mac/v/0.1.3
[0.1.2]: https://www.npmjs.com/package/qsys-mac/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/qsys-mac/v/0.1.1
