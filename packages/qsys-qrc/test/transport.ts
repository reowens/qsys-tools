import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { QrcClient, QrcIndeterminateError } from '../src/index.js';

/**
 * Package-owned transport tests for the QRC client — failure injection at the
 * raw-socket layer, which the downstream MCP/CLI suites (driven through the
 * well-behaved mock Core) never exercise. Covers:
 *  1. Framing + response correlation + notification dispatch.
 *  2. Lost-response READ is retried transparently across a reconnect.
 *  3. Lost-response MUTATION rejects with QrcIndeterminateError and is NOT
 *     retransmitted (QRC has no dedup — a blind retry can double a mutation).
 *  4. A mutation issued while disconnected reconnects and executes exactly once.
 *  5. Malformed frames (null / number / array / bad JSON) emit 'error' without
 *     crashing dispatch; the session keeps working.
 *  6. Unterminated input beyond maxBufferBytes destroys the socket instead of
 *     growing the receive buffer without bound.
 *  7. close() during an in-progress dial cancels it — shutdown never leaves a
 *     live connection behind.
 *  8. Requests issued during reconnect wait for session replay: Logon reaches
 *     the fresh socket before any caller request.
 *  9. A timeout (socket still up) is not retried and does not reconnect.
 */

const HOST = '127.0.0.1';

interface Frame {
  jsonrpc: string;
  method?: string;
  id?: number;
  params?: unknown;
  [k: string]: unknown;
}

type Handler = (msg: Frame, sock: net.Socket, conn: number) => void;

/** Minimal fake Core: null-terminated JSON-RPC frames, per-scenario handler. */
class FakeCore {
  readonly received: Array<{ conn: number; method: string }> = [];
  readonly sockets = new Set<net.Socket>();
  private readonly server: net.Server;
  private conns = 0;
  port = 0;

  constructor(private readonly handler: Handler) {
    this.server = net.createServer((sock) => {
      const conn = ++this.conns;
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      sock.on('error', () => {});
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\0')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!raw.trim()) continue;
          const msg = JSON.parse(raw) as Frame;
          if (typeof msg.method === 'string') this.received.push({ conn, method: msg.method });
          this.handler(msg, sock, conn);
        }
      });
    });
  }

  connections(): number {
    return this.conns;
  }

  /** The client's connect resolves before the server's 'connection' callback runs —
   *  wait for the accepted socket before pushing server-initiated data. */
  async waitForSockets(n = 1): Promise<void> {
    for (let i = 0; i < 400 && this.sockets.size < n; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.sockets.size < n) throw new Error(`server never saw ${n} live socket(s)`);
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, HOST, () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function reply(sock: net.Socket, id: number | undefined, result: unknown): void {
  if (typeof id !== 'number') return;
  sock.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\0');
}

/** Default handler: acknowledge everything with a benign result. */
function ackAll(msg: Frame, sock: net.Socket): void {
  reply(sock, msg.id, msg.method === 'StatusGet' ? { Platform: 'Test', IsEmulator: true } : true);
}

function once(emitter: EventEmitter, event: string, timeoutMs = 2_000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), timeoutMs);
    t.unref?.();
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FAST = { reconnectInitialMs: 10, reconnectMaxMs: 50 };

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ok  ${label}`);
}

async function main(): Promise<void> {
  // 1. Framing, correlation, notification dispatch (frames split across writes).
  {
    const core = new FakeCore((msg, sock) => {
      if (msg.method === 'StatusGet') {
        const frame = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { Platform: 'Test' } }) + '\0';
        // Split the response mid-frame to prove reassembly.
        sock.write(frame.slice(0, 5));
        setTimeout(() => sock.write(frame.slice(5)), 5);
      }
    });
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, ...FAST });
    await client.connect();
    const statusEvent = once(client, 'engineStatus');
    await core.waitForSockets();
    core.sockets.forEach((s) =>
      s.write(JSON.stringify({ jsonrpc: '2.0', method: 'EngineStatus', params: { State: 'Active' } }) + '\0'),
    );
    const [statusParams] = await statusEvent;
    assert.deepEqual(statusParams, { State: 'Active' });
    const result = (await client.statusGet()) as { Platform: string };
    assert.equal(result.Platform, 'Test');
    client.close();
    await core.close();
    ok('framing survives split writes; notifications and responses dispatch');
  }

  // 2. Lost-response read retries transparently on the next connection.
  {
    const core = new FakeCore((msg, sock, conn) => {
      if (conn === 1 && msg.method === 'StatusGet') return sock.destroy(); // eat it
      ackAll(msg, sock);
    });
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, ...FAST });
    client.on('error', () => {});
    await client.connect();
    const result = (await client.statusGet()) as { Platform: string };
    assert.equal(result.Platform, 'Test');
    assert.equal(core.received.filter((r) => r.method === 'StatusGet').length, 2, 'read was retried once');
    client.close();
    await core.close();
    ok('lost-response read is retried transparently across the reconnect');
  }

  // 3. Lost-response mutation → QrcIndeterminateError, no retransmit.
  {
    const core = new FakeCore((msg, sock, conn) => {
      if (conn === 1 && msg.method === 'Control.Set') return sock.destroy(); // applied? unknowable
      ackAll(msg, sock);
    });
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, ...FAST });
    client.on('error', () => {});
    await client.connect();
    await assert.rejects(
      () => client.send('Control.Set', { Name: 'gain', Value: -10 }),
      (err: Error) => err instanceof QrcIndeterminateError && err.name === 'QrcIndeterminateError' && /Control\.Set/.test(err.message),
    );
    await sleep(100); // give a would-be retransmit time to appear
    assert.equal(core.received.filter((r) => r.method === 'Control.Set').length, 1, 'mutation was NOT retransmitted');
    client.close();
    await core.close();
    ok('lost-response mutation rejects with QrcIndeterminateError and is not retransmitted');
  }

  // 4. Mutation issued while disconnected: reconnect first, execute exactly once.
  {
    let dropOnce = true;
    const core = new FakeCore((msg, sock, conn) => {
      void conn;
      ackAll(msg, sock);
    });
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, ...FAST });
    client.on('error', () => {});
    await client.connect();
    if (dropOnce) {
      dropOnce = false;
      const closed = once(client, 'close');
      await core.waitForSockets();
    core.sockets.forEach((s) => s.destroy());
      await closed;
    }
    const result = await client.send('Control.Set', { Name: 'gain', Value: -10 });
    assert.equal(result, true);
    assert.equal(core.received.filter((r) => r.method === 'Control.Set').length, 1, 'mutation sent exactly once');
    client.close();
    await core.close();
    ok('mutation issued while disconnected reconnects and executes exactly once');
  }

  // 5. Malformed frames: no crash, 'error' per frame, session keeps working.
  {
    const core = new FakeCore(ackAll);
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, ...FAST });
    const errors: Error[] = [];
    client.on('error', (e: Error) => errors.push(e));
    await client.connect();
    await core.waitForSockets();
    core.sockets.forEach((s) => s.write('null\0' + '42\0' + '[1,2]\0' + '"hi"\0' + '{not json\0'));
    await sleep(50);
    assert.equal(errors.length, 5, `every malformed frame surfaced as an error event (got ${errors.length})`);
    assert.ok(errors.some((e) => /invalid frame/.test(e.message)), 'non-object frames are called out');
    assert.ok(errors.some((e) => /parse error/.test(e.message)), 'bad JSON is called out');
    const result = (await client.statusGet()) as { Platform: string };
    assert.equal(result.Platform, 'Test');
    assert.ok(client.isConnected(), 'client stayed connected through the garbage');
    client.close();
    await core.close();
    ok('malformed frames (null/number/array/bad JSON) emit errors without crashing');
  }

  // 6. Unterminated input past maxBufferBytes destroys the socket.
  {
    const core = new FakeCore(ackAll);
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, reconnect: false, maxBufferBytes: 1024 });
    const errEvent = once(client, 'error');
    const closeEvent = once(client, 'close');
    await client.connect();
    await core.waitForSockets();
    core.sockets.forEach((s) => s.write('x'.repeat(4096)));
    const [err] = (await errEvent) as [Error];
    assert.match(err.message, /receive buffer exceeded/);
    await closeEvent;
    assert.equal(client.isConnected(), false);
    client.close();
    await core.close();
    ok('unterminated input past maxBufferBytes closes the socket instead of buffering forever');
  }

  // 7. close() during dial cancels the in-progress connection.
  {
    const core = new FakeCore(ackAll);
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, ...FAST });
    const dial = client.connect();
    client.close(); // races the dial — must win
    await assert.rejects(dial, /QRC client closed/);
    assert.equal(client.isConnected(), false);
    await sleep(50);
    assert.equal(core.sockets.size, 0, 'no live server-side socket survives the cancelled dial');
    await core.close();
    ok('close() during dial cancels it; shutdown leaves no live connection');
  }

  // 8. A request issued mid-reconnect waits for replay: Logon lands first.
  {
    const core = new FakeCore((msg, sock, conn) => {
      void conn;
      ackAll(msg, sock);
    });
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, ...FAST });
    client.on('error', () => {});
    await client.connect();
    await client.logon('user', 'pw');
    const reconnecting = once(client, 'reconnecting');
    await core.waitForSockets();
    core.sockets.forEach((s) => s.destroy());
    await reconnecting;
    // Fire immediately while the dial/replay is in flight.
    const status = (await client.statusGet()) as { Platform: string };
    assert.equal(status.Platform, 'Test');
    const conn2 = core.received.filter((r) => r.conn === 2).map((r) => r.method);
    assert.ok(conn2.indexOf('Logon') !== -1, 'Logon was replayed on the fresh socket');
    assert.ok(
      conn2.indexOf('Logon') < conn2.indexOf('StatusGet'),
      `caller request must trail the Logon replay (got order: ${conn2.join(', ')})`,
    );
    client.close();
    await core.close();
    ok('requests issued mid-reconnect wait for session replay (Logon first)');
  }

  // 9. A timeout with the socket still up is not retried and does not reconnect.
  {
    const core = new FakeCore((msg, sock) => {
      if (msg.method !== 'StatusGet') ackAll(msg, sock); // swallow StatusGet silently
    });
    await core.listen();
    const client = new QrcClient({ host: HOST, port: core.port, ...FAST, requestTimeoutMs: 100 });
    await client.connect();
    await assert.rejects(() => client.statusGet(), /timed out/);
    await sleep(50);
    assert.equal(core.received.filter((r) => r.method === 'StatusGet').length, 1, 'timeout did not retransmit');
    assert.equal(core.connections(), 1, 'timeout did not trigger a reconnect');
    assert.ok(client.isConnected(), 'session stays up after a timeout');
    client.close();
    await core.close();
    ok('a timeout (socket still up) is not retried and does not reconnect');
  }

  console.log(`${passed} qsys-qrc transport assertions passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
