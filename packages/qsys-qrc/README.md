# qsys-qrc

TypeScript client for QSC's **Q-SYS Remote Control (QRC)** protocol — the
null-terminated JSON-RPC-over-TCP interface every Q-SYS Core (and Q-SYS
Designer in Emulate mode) serves on port 1710.

Handles the wire framing, request/response correlation, change groups,
keepalive, and transparent auto-reconnect, and ships shared types for
controls, components, and engine status. It is the core that the
[`qsys`](https://www.npmjs.com/package/qsys) CLI and the
[`q-sys-mcp`](https://www.npmjs.com/package/q-sys-mcp) server build on.

## Install

```sh
npm install qsys-qrc
```

## Usage

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

Typed helpers cover the whole protocol surface: status, components,
named controls, change groups (poll-based watch), and snapshots.

The client keeps the socket alive (`NoOp` keepalive) and reconnects
transparently if the Core drops the connection. In-flight **reads** are
retried on the new socket; an in-flight **mutation** whose response was
lost rejects with `QrcIndeterminateError` instead of being retransmitted —
QRC has no request dedup, so a blind retry could double a trigger or
playback start. Re-read state (or re-issue explicitly) to reconcile.

## Disclaimer

This is an independent open-source project, **not affiliated with, endorsed
by, or supported by QSC, LLC**. "Q-SYS" is a trademark of QSC. The client
speaks the publicly documented QRC protocol and contains no QSC code.

## License

MIT
