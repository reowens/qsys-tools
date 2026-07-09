# Changelog

All notable changes to qsys-cli are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-09

### Added

- `qsys loop-player {start,stop,cancel}` — drive a Loop Player from the CLI. `start`
  plays a single `<file> <output>` with `--loop`, `--seek`, `--start-time`, `--log`, and
  `--ref-id`; `stop`/`cancel` take an integer output list (`"1,2"`) with `--log`. Each
  dispatches to the matching `qsys-qrc` `loopPlayer*` wrapper, with a confirmation echo
  and `--json`. Loop Player state is inspected via `qsys get-component <player>` (there is
  no `LoopPlayer.Get*`).

### Changed

- Requires `qsys-qrc` ^0.4.0 (for the `loopPlayer*` wrappers).

## [0.2.0] - 2026-07-09

### Added

- `qsys mixer {crosspoint,input,output,cue,cue-input}` — mirror the five grouped
  mixer operations from the CLI. Each dispatches an `op` to the matching
  `qsys-qrc` `mixerSet*` wrapper, with a local value-type guard (gain/delay require
  a number; the rest a boolean), a confirmation echo, and `--json`. Selectors are
  quoted String Syntax (`"1-3"`, `"* !2"`); mixer state is inspected via
  `qsys get-component <mixer>` (there is no `Mixer.Get*`).

### Changed

- Requires `qsys-qrc` ^0.3.0 (for the `mixerSet*` wrappers).

## [0.1.2] - 2026-07-08

### Fixed

- `qsys watch` now keeps streaming across an auto-reconnect. It arms the change
  group's AutoPoll through the new `qsys-qrc` `changeGroupAutoPoll` wrapper
  instead of a raw `send`, so the poll is re-armed after a dropped socket — a
  Core restart / Emulate-mode toggle no longer silently ends the stream.

### Changed

- Requires `qsys-qrc` ^0.2.0 (for the AutoPoll reconnect fix above).

## [0.1.1] - 2026-07-06

### Changed

- No functional changes. Patch release cut through the trusted-publishing
  pipeline alongside the rest of the qsys-tools family.

## [0.1.0] - 2026-07-05

### Added

- Initial release: the `qsys` CLI — engine/design status, component and control
  inventory, get/set for Named Controls and component controls (with ramps),
  live `watch` streaming via change groups, and snapshot load/save. Human-readable
  tables by default; `--json` on every command (`watch` emits JSON lines).

[Unreleased]: https://github.com/reowens/qsys-tools/tree/main/packages/qsys
[0.1.2]: https://www.npmjs.com/package/qsys-cli/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/qsys-cli/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/qsys-cli/v/0.1.0
