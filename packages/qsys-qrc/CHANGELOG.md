# Changelog

All notable changes to qsys-qrc are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-08

### Added

- `changeGroupAutoPoll(id, rate)` — ask the Core to push `ChangeGroup.Poll`
  notifications at a fixed rate (seconds). The rate is remembered in the group's
  state so an auto-reconnect can re-arm it.

### Fixed

- Auto-reconnect now re-arms `ChangeGroup.AutoPoll` on the fresh socket.
  Previously `replayState()` restored only the logon and change-group control
  registrations, so a streaming consumer that relied on AutoPoll (e.g. the
  `qsys watch` CLI) went silent after a Core restart / Emulate-mode toggle even
  though the socket had transparently reconnected.

## [0.1.1] - 2026-07-06

### Changed

- No functional changes. Patch release cut through the trusted-publishing
  pipeline alongside the rest of the qsys-tools family.

## [0.1.0] - 2026-07-05

### Added

- Initial release: the Q-SYS Remote Control (QRC) client — JSON-RPC 2.0 over TCP
  (default port 1710) with null-terminated wire framing, typed method wrappers
  (status, components, controls, change groups, snapshots, logon), a 30 s NoOp
  keepalive, and transparent auto-reconnect that replays logon + change-group
  registrations. The shared core the `qsys` CLI and `qsys-mcp` server both build on.

[Unreleased]: https://github.com/reowens/qsys-tools/tree/main/packages/qsys-qrc
[0.2.0]: https://www.npmjs.com/package/qsys-qrc/v/0.2.0
[0.1.1]: https://www.npmjs.com/package/qsys-qrc/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/qsys-qrc/v/0.1.0
