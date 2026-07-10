# Changelog

All notable changes to qsys-mcp are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-07-10

### Changed

- **Live-Core writes are now fail-closed** (breaking for live-Core workflows):
  every write tool checks the target BEFORE touching the wire and is refused
  when the Core is not an emulator — or when the engine status is unknown —
  unless the session was opened with `qsys_connect { allow_live_writes: true }`.
  Permitted live writes still return the ⚠ warning. `qsys_save_snapshot` is now
  gated and warned like every other write (it previously bypassed the warning).
  Connecting to a live Core without the flag reports a note that writes are
  disabled.
- All 25 tools now declare MCP `readOnlyHint`/`destructiveHint` annotations so
  clients can gate destructive calls without parsing descriptions.
- The `test/live-write.ts` smoke script refuses to mutate a non-emulator target
  unless `QSYS_LIVE_WRITE_OK=1` is set.
- Via qsys-qrc (now ^0.5.0): a write whose response is lost to a connection
  drop fails with `QrcIndeterminateError` instead of being silently
  retransmitted (a blind retry could double a trigger or playback start on a
  live system).

### Fixed

- **`qsys_loop_player_start` schema**: `loop`, `seek`, `log`, and `refId` moved
  from the per-file entries to top-level tool params, matching the official QRC
  `LoopPlayer.Start` shape (a `files[]` entry carries only `name` + `output`).
  Previously the options were emitted inside each file entry, where a real Core
  ignores them.
- Connection state (`client`, engine status) is now scoped to the server
  instance instead of module-global, a failed `qsys_connect` closes its
  half-open candidate socket in every failure path (no leaked sockets on logon
  or status failure), and interleaved connect calls can no longer clobber a
  newer healthy connection (generation-tokened).
- MCP transport closure (stdio EOF) now closes the QRC socket, so an orphaned
  server process no longer holds an authenticated Core connection open.

## [0.5.0] - 2026-07-09

### Added

- Loop Player control: 2 grouped tools (23 → **25**) — `qsys_loop_player_start`
  (nested `files[]` with per-file `output`/`loop`/`seek`/`log`/`refId`, plus optional
  `startTime`) and `qsys_loop_player_stop_cancel` (`op: stop | cancel`, `outputs` as an
  integer list). Both mutate and emit the live-Core warning. Outputs are integer lists
  (NOT String Syntax); `startTime` is forwarded raw. Loop Player state reads back through
  `qsys_get_component` (no `LoopPlayer.Get*` on the wire). `refId` is accepted, but its
  async failure notification is not surfaced yet (pending the push channel).

### Changed

- Requires `qsys-qrc` ^0.4.0 (for the `loopPlayer*` wrappers).

## [0.4.0] - 2026-07-09

### Added

- Mixer control: 5 grouped tools (18 → **23**) — `qsys_mixer_set_crosspoint`,
  `qsys_mixer_set_input`, `qsys_mixer_set_output`, `qsys_mixer_set_cue`, and
  `qsys_mixer_set_cue_input`. An `op` enum selects the concrete `Mixer.Set*` method;
  `value` is `number | boolean` with a per-tool runtime guard (gain/delay require a
  number; mute/solo/enable/afl a boolean); `Ramp` is forwarded only for gain/delay.
  Selectors are pass-through QRC String Syntax; all five emit the live-Core warning.
  Mixer state reads back through `qsys_get_component` (no `Mixer.Get*` on the wire).

### Changed

- Requires `qsys-qrc` ^0.3.0 (for the `mixerSet*` wrappers).

## [0.3.3] - 2026-07-08

### Changed

- Bump `qsys-qrc` to ^0.2.0. No MCP behavior change — the server intentionally
  does not use AutoPoll — but this keeps the whole family on a single QRC core
  (which now re-arms AutoPoll on reconnect) and lets the shared reconnect test
  cover the fix.

## [0.3.2] - 2026-07-06

### Fixed

- Add the npm `mcpName` field required for MCP Registry validation.

## [0.3.1] - 2026-07-06

### Fixed

- `serverInfo.version` now reflects the package version (was hardcoded `0.1.0`
  since the first release).

## [0.3.0] - 2026-07-03

### Changed

- **Renamed on npm: `q-sys-mcp` → `qsys-mcp`** — the package name now matches
  the installed command. The old name was unpublished from the registry;
  update MCP configs from `npx -y q-sys-mcp` to `npx -y qsys-mcp`.
  (Versions ≤0.2.0 shipped as `q-sys-mcp`; npm's punctuation-similarity rule
  originally forced the hyphenated name and blocks owning both.)
- Now published from the [`qsys-tools`](https://github.com/reowens/qsys-tools)
  monorepo; the standalone `reowens/qsys-mcp` repo is retired. Depends on the
  published `qsys-qrc` (^0.1.0) instead of the workspace-internal copy.

## [0.2.0] - 2026-06-30

### Added

- Transparent auto-reconnect. On an unexpected socket drop (Core restart,
  leaving Emulate mode, a network blip) the client re-dials with exponential
  backoff and replays its logon + change-group registrations, so polling resumes
  without re-calling `qsys_connect`. In-flight and subsequent requests wait for
  the reconnect and retry once — drops are transparent to callers. On by
  default; opt out per connection with `reconnect: false` on `qsys_connect`.
- Snapshot tools: `qsys_load_snapshot` (`Snapshot.Load`, optional ramp) and
  `qsys_save_snapshot` (`Snapshot.Save`) for recalling and capturing control
  scenes by bank name + snapshot number.
- Change-group lifecycle is now complete: `qsys_change_group_remove`
  (`ChangeGroup.Remove`), `qsys_change_group_clear` (`ChangeGroup.Clear`), and
  `qsys_change_group_invalidate` (`ChangeGroup.Invalidate`, force a full resend
  on the next poll — handy after a reconnect). 13 tools → 18.

### Changed

- Richer package description + expanded npm keywords, and added GitHub repo
  description + topics, for search and discoverability.

## [0.1.1] - 2026-06-22

### Changed

- No functional changes. First release cut through the GitHub Actions
  trusted-publishing pipeline (OIDC, no token) — published with build
  provenance. `0.1.0` was a manual bootstrap publish.

## [0.1.0] - 2026-06-22

### Added

- Initial release: an MCP server that controls Q-SYS over the QRC protocol
  (JSON-RPC 2.0 over TCP 1710), pointed at a real Core or at Q-SYS Designer in
  Emulate mode.
- 13 tools — connect, status, component/control discovery, get/set for both
  Named Controls and component controls (with ramps), change groups
  (create / poll / add-component / destroy), and disconnect.
- Response shaping (`filter`, `names_only`, `type`) to keep large designs from
  flooding an agent's context.
- Live-Core write warning and a 30 s NoOp keepalive.
- Cross-platform CI (Linux / macOS / Windows × Node 18 & 20) with a
  hardware-free test suite (mock QRC + in-memory MCP transport).

[Unreleased]: https://github.com/reowens/qsys-tools/tree/main/packages/qsys-mcp
[0.3.3]: https://www.npmjs.com/package/qsys-mcp/v/0.3.3
[0.3.2]: https://www.npmjs.com/package/qsys-mcp/v/0.3.2
[0.3.1]: https://www.npmjs.com/package/qsys-mcp/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/qsys-mcp/v/0.3.0
[0.2.0]: https://github.com/reowens/qsys-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/reowens/qsys-mcp/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/q-sys-mcp/v/0.1.0
