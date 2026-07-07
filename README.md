# qsys-tools

> Open-source tooling for **QSC Q-SYS** audio/video systems — control a Core from
> your shell, your code, or an AI agent, and run Q-SYS Designer natively on your Mac.

[![npm qsys-cli](https://img.shields.io/npm/v/qsys-cli.svg?label=qsys-cli)](https://www.npmjs.com/package/qsys-cli)
[![npm qsys-qrc](https://img.shields.io/npm/v/qsys-qrc.svg?label=qsys-qrc)](https://www.npmjs.com/package/qsys-qrc)
[![npm qsys-mcp](https://img.shields.io/npm/v/qsys-mcp.svg?label=qsys-mcp)](https://www.npmjs.com/package/qsys-mcp)
[![npm qsys-mac](https://img.shields.io/npm/v/qsys-mac.svg?label=qsys-mac)](https://www.npmjs.com/package/qsys-mac)
[![node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![license: MIT + GPL-3.0](https://img.shields.io/badge/license-MIT%20%2B%20GPL--3.0-blue.svg)](#licensing)

Every Q-SYS Core — and Q-SYS Designer in **Emulate mode** — serves QSC's published
**QRC** protocol (JSON-RPC 2.0 over TCP, port 1710). It's the same external-control
interface Crestron/AMX integrations use. These tools speak it natively: **zero QSC
code, no SDK, no hardware required for development.**

| Package | What it is |
|---|---|
| [`qsys-cli`](packages/qsys) | CLI (command: `qsys`) — status, component inventory, get/set controls with ramps, live watch, snapshots |
| [`qsys-qrc`](packages/qsys-qrc) | TypeScript QRC client — wire framing, change groups, keepalive, transparent auto-reconnect, typed protocol surface |
| [`qsys-mcp`](packages/qsys-mcp) | [MCP](https://modelcontextprotocol.io) server (`io.github.reowens/qsys-mcp` in the MCP Registry) — 18 tools that let an AI agent inspect and drive a live Q-SYS system |
| [`qsys-mac`](packages/qsys-mac) | npm bootstrapper (command: `qsys-mac`) — downloads/verifies the signed Q-SYS Mac Installer DMG and delegates to its helper |
| [`qsys-mac-installer`](packages/qsys-mac-installer) | **Q-SYS Designer for macOS** — signed/notarized BYO-installer wrapper app + DMG source |

## Quick start — shell

```sh
export QSYS_HOST=192.168.1.10     # your Core, or 127.0.0.1 for Designer Emulate

npx qsys-cli status               # engine/design status
npx qsys-cli ls                   # list components
npx qsys-cli get MainGain         # read a named control
npx qsys-cli set MainGain -6 --ramp 2
npx qsys-cli watch MainGain       # stream changes until Ctrl-C
npx qsys-cli snapshot load Bank 1 --ramp 1
```

```
$ qsys status
Design     RobertOwens-L1 (code Hd4b6C9TXKzL)
Platform   Emulator (emulator)
State      Active

$ qsys set-component Main_Mixer input.1.gain -6 --ramp 2
NAME          VALUE  STRING   POSITION
input.1.gain  -6     -6.00dB  0.585
```

Install the command globally with `npm i -g qsys-cli` (the binary is plain `qsys`).
Every command takes `--json` for scripting; `watch` emits JSON lines.

## Quick start — AI agent (MCP)

```sh
claude mcp add qsys -- npx -y qsys-mcp
```

or in any MCP client config:

```json
{
  "mcpServers": {
    "qsys": { "command": "npx", "args": ["-y", "qsys-mcp"] }
  }
}
```

Then ask the agent to connect to your Core (or the Designer emulator) and it can read
meters, flip mutes, ramp gains, watch controls for changes, and recall snapshots —
with auto-reconnect across Core restarts. Details in
[`packages/qsys-mcp`](packages/qsys-mcp).

Registry-aware MCP clients can discover it as `io.github.reowens/qsys-mcp`.

## Quick start — your own code

```sh
npm install qsys-qrc
```

```ts
import { QrcClient } from 'qsys-qrc';

const qrc = new QrcClient({ host: '192.168.1.10' });
await qrc.connect();

const status = await qrc.statusGet();          // typed helpers…
await qrc.setControl('MainGain', -6, 2);       // value -6, 2 s ramp
const [gain] = await qrc.getControl(['MainGain']);

await qrc.send('Component.GetComponents');     // …or raw QRC methods

qrc.close();
```

Change groups (poll-based watch), component access, snapshots, and logon are all
covered by typed helpers — see [`packages/qsys-qrc`](packages/qsys-qrc).

## Q-SYS Designer on your Mac

For most users, use the signed DMG installer app, run it once, then trash the installer app when you
are done. The installed `Q-SYS Designer.app` and its Application Support data remain.

Direct DMG path:

```sh
open https://github.com/reowens/qsys-tools/releases/tag/qsys-mac-installer-v0.1.3
```

Or use the npm bootstrapper:

```sh
npx qsys-mac install "/path/to/Q-SYS Designer Installer 10.4.0.exe"
```

It downloads and verifies the signed Q-SYS Mac Installer DMG, mounts it, and runs
the bundled helper. The npm package does not contain Q-SYS Designer or the app
payload. You provide **your own** free Designer installer download (BYO — nothing
of QSC's is redistributed).

Current macOS prerequisite: Rosetta 2. The signed DMG bundles Wine, .NET, `7z`,
icon tooling, `msiinfo`, and native helper binaries; normal setup does not need
Homebrew or host Python.

Prefer a GUI installer app? Homebrew can install it:

```sh
brew tap reowens/qsys
brew trust reowens/qsys
brew install --cask qsys-mac-installer
open -a "Q-SYS Mac Installer"
```

`brew trust` is required by current Homebrew for third-party cask taps.

The signed installer source lives in
[`packages/qsys-mac-installer`](packages/qsys-mac-installer). It provisions Wine +
.NET into Application Support and gives you a real Dock/Finder/menu-bar citizen.
The current signed DMG is
[`qsys-mac-installer 0.1.3`](https://github.com/reowens/qsys-tools/releases/tag/qsys-mac-installer-v0.1.3).

Bonus: Designer's **Emulate mode** serves QRC on `127.0.0.1:1710`, so all of the
tools above work hardware-free against it — that's how this repo's tooling is
validated.

## No hardware?

Point any of the tools at Q-SYS Designer running in Emulate mode (`--host
127.0.0.1`). Two protocol facts worth knowing: QRC has no method to *enumerate*
named controls or snapshot banks (you need their names from the design), and
`Component.GetComponents` returns only components with script access enabled.

## Development

```sh
git clone https://github.com/reowens/qsys-tools.git
cd qsys-tools
npm install
npm run typecheck
npm test
```

The e2e suites run against a private, design-driven Q-SYS Core emulator; without it
the e2e tests skip automatically (unit/arg-parsing tests still run). Maintainers
with access to the emulator checkout can link it locally, then run:

```sh
npm test                # full suites
npm run typecheck:full  # includes the emulator-backed test files
```

`qsys-mac-installer` builds separately with Xcode — see
[`packages/qsys-mac-installer`](packages/qsys-mac-installer) (`scripts/package.sh` for the
sign/notarize pipeline).

Maintainer release steps are documented in [`RELEASE.md`](RELEASE.md).

When working from this source checkout, use the workspace script instead of
`npx qsys-mac` so npm does not confuse the local workspace package with the
published package:

```sh
npm run qsys-mac -- status
npm run qsys-mac -- install "/path/to/Q-SYS Designer Installer 10.4.0.exe"
```

## Licensing

- npm packages (`qsys-cli`, `qsys-qrc`, `qsys-mcp`): **MIT**
- `qsys-mac` npm bootstrapper and `qsys-mac-installer` wrapper: **GPL-3.0-or-later**

Each package carries its own LICENSE file.

## Disclaimer

This is an independent open-source project, **not affiliated with, endorsed by, or
sponsored by QSC, LLC**. "Q-SYS" and "Q-SYS Designer" are trademarks of QSC, LLC,
used nominatively. These tools speak the publicly documented QRC protocol and
contain no QSC code.
