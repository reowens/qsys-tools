# qsys-mock-core

A minimal, **design-driven Q-SYS Core mock**. Point it at an in-memory design (a
set of named controls + components) and it serves the QRC control plane over a TCP
socket exactly like a real Core / Q-SYS Designer *Emulate* session — no hardware:

- `StatusGet` / `EngineStatus` (incl. `IsEmulator`)
- `Control.Get` / `Control.Set`, `Component.GetComponents` / `GetControls` / `Get` / `Set`
- the full change-group lifecycle: `AddControl`, `AddComponentControl`, `Poll`,
  `AutoPoll` (server-pushed notifications), `Remove`, `Clear`, `Invalidate`, `Destroy`
- `Snapshot.Load` / `Snapshot.Save`
- control identity: type, range (clamped on set), and rendered `{Value, String, Position}`
  (e.g. a gain reads back as `-6.0dB`)

It also exposes a small **fault-injection bench** — `dropConnections()`,
`swallowNext(method)`, `resetState()`, `logonCount()` — so tests can simulate a Core
restart, a hung request, or a dropped socket. That's what lets the qsys-tools
suites exercise `qsys-qrc`'s transparent auto-reconnect (including the
AutoPoll-replay regression) with zero hardware.

```ts
import { parseDesign, startMockCore } from 'qsys-mock-core';

const mock = await startMockCore(parseDesign({
  design: { name: 'Demo', code: 'demo', platform: 'MockEmulator' },
  namedControls: [{ name: 'MainGain', type: 'gain', min: -100, max: 20, units: 'dB', value: -10 }],
  components: [{ name: 'Gain1', type: 'gain', controls: [{ name: 'gain', type: 'gain', units: 'dB' }] }],
}), { port: 0 });

// connect a QrcClient to mock.port, then drive it…
await mock.close();
```

## Scope

This is deliberately a **mock**, not the full article. It implements the QRC
control plane against a design you supply, and it ships **no designs of its own**.
It intentionally leaves out the depth of a full emulator — ramp interpolation on a
tick loop, animated meters, validated-against-Designer rendering nuances, and a
library of real Q-SYS training designs. That fidelity lives in a separate, fuller
emulator used for deeper conformance testing. This package covers what the public
[`qsys-tools`](https://github.com/reowens/qsys-tools) e2e suites need in CI.

MIT-licensed.
