# Changelog

All notable changes to qsys-qrc are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-07-10

### Fixed

- **`LoopPlayer.Start` wire shape**: `Loop`, `Seek`, `Log`, and `RefID` are now
  emitted at the top level of the request params, per the official QRC spec — a
  `Files[]` entry carries only `Name` and `Output`. Previously the four options
  were nested inside each file entry, where a real Core ignores them (playback
  didn't loop, seek/log/refId were dropped). **Breaking**: the options moved from
  `LoopPlayerFile` to `LoopPlayerStartParams` and now apply to the whole job.

### Changed

- **Reconnect retry is now delivery-safe**: when a connection drops after a
  request was sent but before its response arrived, only methods classified
  idempotent (reads, change-group registration, `Logon`, `NoOp`) are retried
  transparently. A non-idempotent request (`Control.Set`, `Component.Set`,
  `Mixer.*`, `LoopPlayer.*`, `Snapshot.*`, unknown raw methods) rejects with the
  new `QrcIndeterminateError` — QRC has no request dedup, so a blind retransmit
  could double a trigger or playback start. A request that provably never
  reached the socket is still retried regardless of method.
- `isConnected()` now reports full session readiness (post logon/change-group
  replay), not merely a TCP-connected socket; requests issued mid-reconnect wait
  for the replay to finish instead of racing it.

### Added

- `QrcIndeterminateError` (exported): distinct error for sent-but-unacknowledged
  mutations, carrying the QRC `method`.
- `maxBufferBytes` option (default 4 MiB): input with no frame terminator beyond
  the cap closes the socket instead of growing the receive buffer without bound.
- Defensive frame validation: valid-JSON-but-non-object frames (`null`, numbers,
  arrays) emit `'error'` instead of crashing dispatch.
- `close()` now cancels an in-progress dial, so shutdown can never leave a live
  connection behind.
- Package-owned transport test suite (`pnpm --filter qsys-qrc test`) with
  failure injection: lost responses, mid-reconnect requests, malformed and
  oversized frames, close-during-dial, and timeout-vs-drop classification.

## [0.4.0] - 2026-07-09

### Added

- Loop Player control: 3 wrappers over the QRC `LoopPlayer.*` methods —
  `loopPlayerStart({ name, startTime?, files })`, `loopPlayerStop(name, outputs, log?)`,
  and `loopPlayerCancel(name, outputs, log?)`, plus the `LoopPlayerFile` /
  `LoopPlayerStartParams` types. `files[]` maps to QRC casing (`Name`/`Output`/`Loop`/
  `Seek`/`Log`/`RefID`) with unset options omitted; `Stop`/`Cancel` send `Outputs` as a
  **table of integers** (`[1, 2]`), NOT Mixer String Syntax; `StartTime` is passed raw
  (`-1` now, `-2` queue-after-current, `≥0` absolute time-of-day). Method names and
  params verified against the Q-SYS v10.4 offline help. Loop Player state reads back
  through `Component.Get` (no `LoopPlayer.Get*` on the wire).

## [0.3.0] - 2026-07-09

### Added

- Mixer control: 13 `mixerSet*` wrappers over the QRC `Mixer.Set*` methods —
  `mixerSetCrossPoint{Gain,Delay,Mute,Solo}`, `mixerSetInput{Gain,Mute,Solo}`,
  `mixerSetOutput{Gain,Mute}`, `mixerSetCue{Gain,Mute}`, and
  `mixerSetInputCue{Enable,Afl}`. Selectors are pass-through QRC **String Syntax**
  (`*`, lists, `1-6` ranges, `!` negation); optional `Ramp` on the five gain/delay
  wrappers only. Method names and params verified against the Q-SYS v10.4 offline
  help. Live-validated against a real engine (Designer Emulate).

## [0.2.1] - 2026-07-08

### Changed

- No functional changes. First release published from CI via **trusted publishing
  (OIDC, tokenless)** with **build provenance** — validates the tag-driven
  `.github/workflows/publish.yml` pipeline. (Earlier versions were published
  manually and do not carry provenance, despite prior changelog wording.)

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
