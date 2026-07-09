/**
 * The qsys-mock-core socket server. Wraps a MockCore in the null-terminated
 * JSON-RPC framing a real Core / Designer Emulate session speaks: sends
 * EngineStatus on connect, dispatches each request to core.handleRequest, runs an
 * AutoPoll loop that pushes ChangeGroup.Poll notifications on a socket-scoped
 * cadence, and exposes a fault-injection bench (drop / swallow / reset) so tests can
 * simulate Core restarts, hangs, and dropped connections.
 */
import net from 'node:net';
import { MockCore, type CoreOptions } from './core.js';
import type { Design } from './design.js';

export interface MockCoreOptions extends CoreOptions {
  /** TCP port; 0 picks a free port (default 1710). */
  port?: number;
  /** Bind address (default 127.0.0.1). */
  host?: string;
  /** AutoPoll tick interval in ms (default 50). */
  tickMs?: number;
}

export interface MockCoreHandle {
  port: number;
  close: () => Promise<void>;
  /** Destroy all live sockets (simulates a Core dropping the connection). */
  dropConnections: () => void;
  /** Silently ignore the next request for this method (simulates a hung Core → client timeout). */
  swallowNext: (method: string) => void;
  /** Clear change groups (simulates a Core restart losing them). */
  resetState: () => void;
  logonCount: () => number;
  lastSnapshotLoad: () => unknown;
  lastSnapshotSave: () => unknown;
  /** The last Mixer.Set* call the core acked ({ method, params }), or null. */
  lastMixerCall: () => { method: string; params: unknown } | null;
  /** The last LoopPlayer.* call the core acked ({ method, params }), or null. */
  lastLoopPlayerCall: () => { method: string; params: unknown } | null;
  /** The underlying engine (introspection for tests). */
  core: MockCore;
}

interface AutoPoll {
  rateMs: number;
  accMs: number;
  socket: net.Socket;
}

export function startMockCore(design: Design, opts: MockCoreOptions = {}): Promise<MockCoreHandle> {
  const port = opts.port ?? 1710;
  const host = opts.host ?? '127.0.0.1';
  const tickMs = opts.tickMs ?? 50;
  const core = new MockCore(design, opts);

  const sockets = new Set<net.Socket>();
  const swallow = new Set<string>();
  const autopolls = new Map<string, AutoPoll>(); // change-group id → autopoll config

  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sockets.add(sock);
    sock.on('close', () => {
      sockets.delete(sock);
      // Drop autopolls owned by a socket that went away.
      for (const [id, ap] of autopolls) if (ap.socket === sock) autopolls.delete(id);
    });
    sock.on('error', () => { /* client-side reset — the 'close' handler cleans up */ });

    let buf = '';
    const send = (obj: unknown) => sock.write(JSON.stringify(obj) + '\0');

    // EngineStatus on connect (matches a real Core / Designer Emulate session).
    send({ jsonrpc: '2.0', method: 'EngineStatus', params: core.engineStatus() });

    sock.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\0')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!raw.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        dispatch(msg, sock, send);
      }
    });
  });

  function dispatch(msg: any, sock: net.Socket, send: (o: unknown) => void): void {
    const reply = (result: unknown) => {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', result, id: msg.id });
    };

    // Transport-level fault injection: drop this request with no reply (client times out).
    if (swallow.has(msg.method)) {
      swallow.delete(msg.method);
      return;
    }

    // AutoPoll is a socket-scoped concern (the Core pushes to the socket that set it up),
    // so the server owns it rather than the pure-logic core. Rate is in seconds.
    if (msg.method === 'ChangeGroup.AutoPoll') {
      const id = msg.params?.Id;
      const rate = Number(msg.params?.Rate);
      autopolls.set(id, {
        rateMs: Number.isFinite(rate) && rate > 0 ? rate * 1000 : tickMs,
        accMs: 0,
        socket: sock,
      });
      return reply(null);
    }
    if (msg.method === 'ChangeGroup.Destroy') autopolls.delete(msg.params?.Id);

    core.handleRequest(msg, reply, (code, message) => {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', error: { code, message }, id: msg.id });
    });
  }

  const timer = setInterval(() => {
    for (const [id, ap] of autopolls) {
      ap.accMs += tickMs;
      if (ap.accMs < ap.rateMs) continue;
      ap.accMs = 0;
      const res = core.pollGroup(id);
      if (res && res.Changes.length && !ap.socket.destroyed) {
        ap.socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'ChangeGroup.Poll', params: res }) + '\0');
      }
    }
  }, tickMs);
  timer.unref?.();

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => {
          clearInterval(timer);
          for (const s of sockets) s.destroy();
          sockets.clear();
          server.close(() => r());
        }),
        dropConnections: () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          autopolls.clear();
        },
        swallowNext: (method: string) => swallow.add(method),
        resetState: () => core.resetChangeGroups(),
        logonCount: () => core.logonCount(),
        lastSnapshotLoad: () => core.lastSnapshotLoad(),
        lastSnapshotSave: () => core.lastSnapshotSave(),
        lastMixerCall: () => core.lastMixerCall(),
        lastLoopPlayerCall: () => core.lastLoopPlayerCall(),
        core,
      });
    });
  });
}
