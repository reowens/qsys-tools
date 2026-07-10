# qsys-mcp

> Let an AI agent inspect and control a **Q-SYS** audio/video system over QSC's published **QRC** protocol — against a real Core or Q-SYS Designer's built-in emulator.

[![npm](https://img.shields.io/npm/v/qsys-mcp.svg)](https://www.npmjs.com/package/qsys-mcp)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

MCP Registry name: **`io.github.reowens/qsys-mcp`**

`qsys-mcp` is an [MCP](https://modelcontextprotocol.io) server. It speaks QSC's **QRC** external-control protocol (JSON-RPC 2.0 over TCP) — the same interface third-party control systems like Crestron and AMX use — and exposes it to an LLM agent as a set of tools. Point it at a physical Q-SYS Core *or* at Q-SYS Designer running in **Emulate mode** and the agent can read meters, flip mutes, ramp gains, and watch controls for changes.

It's a pure wire-protocol client: **zero QSC code**, no SDK, no hardware required for development. That makes it a clean, sanctioned layer QSC ships on no platform — AI-native control — and it runs anywhere Node does.

## Highlights

- **25 tools** covering connect, status, discovery, read, write (with ramps), snapshots, Mixer control, Loop Player playback, the full change-group lifecycle (add/poll/remove/clear/invalidate/destroy), and disconnect.
- **No hardware needed** — develop entirely against Designer's Emulate-mode soft-core on `localhost`.
- **Cross-platform** — `node:net` only; CI proves it on Linux + macOS × Node 22 & 24.
- **Context-friendly** — list/get tools take `filter` / `names_only` / `type` so large designs don't flood the agent's context.
- **Safe by default** — write tools are **refused** on a live Core (or when the engine status is unknown) unless the session was opened with `qsys_connect { allow_live_writes: true }`; permitted live writes still carry a ⚠ warning, every tool declares MCP read-only/destructive annotations, and a 30 s `NoOp` keepalive holds the socket open through QRC's 60 s idle close.
- **Self-healing** — on a dropped socket (Core restart, leaving Emulate, a network blip) the client auto-reconnects and replays your change-group registrations, so polling resumes without re-calling `qsys_connect`. Opt out with `reconnect: false`.

## Quick start

Run it straight from npm (no install):

```bash
npx -y qsys-mcp       # MCP server on stdio
```

Registry-aware clients can also discover it in the MCP Registry as
`io.github.reowens/qsys-mcp`.

> Formerly published as `q-sys-mcp` (now unpublished) — as of 0.3.0 the package
> name matches the command: **`qsys-mcp`**. Update any existing MCP configs.

Or from source:

```bash
git clone https://github.com/reowens/qsys-tools.git
cd qsys-tools
corepack enable
pnpm install
pnpm -r build                        # compiles every package to dist/
node packages/qsys-mcp/dist/index.js
```

### Connect it to your agent

Add it to your MCP client config (Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "q-sys": {
      "command": "npx",
      "args": ["-y", "qsys-mcp"]
    }
  }
}
```

From a local checkout instead, use `"command": "node"` with `"args": ["/absolute/path/to/qsys-tools/packages/qsys-mcp/dist/index.js"]`.

Always call `qsys_connect` first (host `127.0.0.1`, port `1710` for a local emulator) before any other tool.

## What it can do

Once connected, just ask in natural language — the agent picks the tools.

> **You:** *"Connect to my Q-SYS emulator and bring the main gain down to −20 dB over 2 seconds."*

The agent runs:

1. `qsys_connect` → `{ host: "127.0.0.1", port: 1710 }`
2. `qsys_list_components` → `{ type: "gain" }` — finds the `Levels` gain block
3. `qsys_set_component` → `{ name: "Levels", controls: [{ name: "gain", value: -20, ramp: 2 }] }`

Or, if you've exposed that fader as a **Named Control** in Designer:

```
qsys_set_control → { name: "MainGain", value: -20, ramp: 2 }
```

To watch a control live (meters, button states), create a change group and poll it:

```
qsys_create_change_group → { id: "meters", controls: ["MainGain"] }
qsys_poll_change_group    → { id: "meters" }   // returns only what changed since the last poll
```

## Tools

| Tool | QRC method | Purpose |
|------|------------|---------|
| `qsys_connect` | (socket) + `Logon`/`StatusGet` | Connect to a Core/emulator |
| `qsys_status` | `StatusGet` | Engine status (platform, design, run state) |
| `qsys_list_components` | `Component.GetComponents` | List named components |
| `qsys_get_component_controls` | `Component.GetControls` | A component's controls + values |
| `qsys_get_control` | `Control.Get` | Get Named Control values |
| `qsys_get_component` | `Component.Get` | Get specific component control values |
| `qsys_set_control` | `Control.Set` | Set a Named Control (with optional ramp) |
| `qsys_set_component` | `Component.Set` | Set component controls (with optional ramps) |
| `qsys_load_snapshot` | `Snapshot.Load` | Recall a saved snapshot (with optional ramp) |
| `qsys_save_snapshot` | `Snapshot.Save` | Capture current settings into a snapshot |
| `qsys_mixer_set_crosspoint` | `Mixer.SetCrossPoint{Gain,Delay,Mute,Solo}` | Set input×output crosspoints |
| `qsys_mixer_set_input` | `Mixer.SetInput{Gain,Mute,Solo}` | Set mixer inputs |
| `qsys_mixer_set_output` | `Mixer.SetOutput{Gain,Mute}` | Set mixer outputs |
| `qsys_mixer_set_cue` | `Mixer.SetCue{Gain,Mute}` | Set mixer cues |
| `qsys_mixer_set_cue_input` | `Mixer.SetInputCue{Enable,Afl}` | Route/monitor inputs to cues |
| `qsys_loop_player_start` | `LoopPlayer.Start` | Play/queue files on a Loop Player's outputs |
| `qsys_loop_player_stop_cancel` | `LoopPlayer.Stop` / `LoopPlayer.Cancel` | Stop playback / cancel a queued job |
| `qsys_create_change_group` | `ChangeGroup.AddControl` | Watch Named Controls for changes |
| `qsys_change_group_add_component` | `ChangeGroup.AddComponentControl` | Watch a component's controls |
| `qsys_poll_change_group` | `ChangeGroup.Poll` | Get changes since last poll |
| `qsys_change_group_remove` | `ChangeGroup.Remove` | Stop watching specific Named Controls |
| `qsys_change_group_clear` | `ChangeGroup.Clear` | Remove all controls, keep the group |
| `qsys_change_group_invalidate` | `ChangeGroup.Invalidate` | Force the next poll to resend everything |
| `qsys_destroy_change_group` | `ChangeGroup.Destroy` | Free a change group's server-side state |
| `qsys_disconnect` | (socket) | Close the connection |

`qsys_list_components` and `qsys_get_component_controls` accept optional `filter` (case-insensitive name substring), `names_only`, and — for components — `type`, to trim large designs before they reach the agent's context.

### Named Controls vs. components

Q-SYS exposes controls two ways, and the tools mirror that split:

- **Named Controls** (`qsys_get_control` / `qsys_set_control`) reach a control only if it's been *explicitly exposed* — dragged into the **Named Controls** pane in Designer with a unique name. Flat namespace, addressed by that one name.
- **Component controls** (`qsys_get_component_controls` / `qsys_get_component` / `qsys_set_component`, plus the Mixer and Loop Player tools) reach any control on a component that has a **Code Name** *and* a QRC-reachable **Script Access** setting — no per-control naming needed.

If `qsys_get_control` can't find a name, it almost always means the control hasn't been added to the Named Controls pane.

### Script Access — the QRC visibility gate ⚠

QRC can only see or move a component whose **Script Access** allows external control. This is a per-component property set in Designer, and its values are ([Q-SYS Help](https://help.qsys.com/DeveloperHelp/#Getting_Started/Script_vs._Plugin_Determination.htm)):

| Script Access | Reachable by these tools (QRC)? |
|---|---|
| **None** *(default)* | ❌ Invisible to QRC — and to scripts/plugins too |
| **Script** | ❌ On-Core scripts/plugins only, **not** QRC |
| **External** | ✅ QRC only |
| **All** | ✅ QRC + scripts + plugins |

Because **`None` is the default**, a component is *invisible to these tools until someone sets it to `External` or `All`* in Designer and gives it a Code Name. So if `qsys_list_components` omits a component you can see in the schematic, or a `qsys_set_component` / Mixer / Loop Player write silently no-ops on a real Core, the first thing to check is that component's **Code Name + Script Access**. (Designer's *Script Programmer Mode* shows the setting on each component without disconnecting.) Note the development mock/emulator behind this repo's tests does **not** model Script Access — every component is reachable there — so a design that drives fine in tests can still be gated on a real target. Always confirm Script Access on the actual Core before blaming the tools.

## Requirements

- **Node.js ≥ 18.**
- **A control target on port 1710:**
  - a real **Q-SYS Core** with a design loaded and in **Run** mode, or
  - **Q-SYS Designer in Emulate mode** — open a design and press **F6** (*Save to Design & Run*; **not** F5, which deploys to a physical Core). Connect to `127.0.0.1:1710`.

QRC is fully functional in Emulate mode, so you can build and test without any hardware.

> Writes mutate the running/emulated system. On an emulator, nothing persists unless you save the design in Designer.

## Develop & verify

```bash
pnpm test                               # offline: QRC integration + MCP-over-mock (no hardware)
pnpm run smoke -- 127.0.0.1 1710        # read-only smoke against a live emulator/Core
pnpm run smoke:mcp -- 127.0.0.1 1710    # full MCP-over-stdio smoke against a live target
pnpm run smoke:write -- 127.0.0.1 1710  # live WRITE round-trip: set a gain, verify, restore
pnpm run smoke:named -- MainGain        # live Named-Control read/set + change-group poll
pnpm run smoke:keepalive                # idle >60s, prove the socket survives QRC's idle close
```

`pnpm test` needs no hardware; every `smoke:*` script needs a live target (a real Core, or Designer in Emulate mode, on port 1710).

**CI** runs `pnpm install --frozen-lockfile && pnpm -r build && pnpm run typecheck && pnpm test` on Linux + macOS × Node 22 & 24 ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The whole suite is hardware-free — the in-repo `qsys-mock-core` QRC server plus an in-memory MCP transport — so the full matrix runs without a Core.

## Roadmap / out of scope

- **WebSocket transport** via `@q-sys/qrwc` — a convenience adapter for real Cores. Raw QRC is the primary transport today; the lib is still beta.
- **Real-Core validation** — every test so far runs against Designer's emulator; a physical Core run is the honest trigger to graduate to `1.0.0`.
- **Design authoring** (reading/writing `.qsys` files) — out of scope: `.qsys` is a compressed .NET `BinaryFormatter` graph type-coupled to QSC's assemblies.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes, or the [monorepo GitHub releases](https://github.com/reowens/qsys-tools/releases) page.

## License

MIT — see [LICENSE](LICENSE). Q-SYS and QRC are trademarks/protocols of QSC, LLC; this project is an independent client and is not affiliated with or endorsed by QSC.
