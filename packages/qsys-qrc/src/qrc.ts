import net from 'node:net';
import { EventEmitter } from 'node:events';

export interface QrcClientOptions {
  host: string;
  port?: number;
  /** Keepalive interval in ms. QRC closes idle sockets after 60s; default 30s. */
  keepAliveMs?: number;
  /** Per-request timeout in ms (default 10s). */
  requestTimeoutMs?: number;
  /**
   * Auto-reconnect on an unexpected socket drop (Core restart, leaving Emulate
   * mode, a network blip), replaying logon + change-group registrations so
   * polling resumes seamlessly. Default true. An explicit close() disables it.
   */
  reconnect?: boolean;
  /** Initial reconnect backoff in ms (default 500). */
  reconnectInitialMs?: number;
  /** Max reconnect backoff in ms (default 10_000). */
  reconnectMaxMs?: number;
  /** Consecutive background reconnect attempts before giving up until the next request (default 8). */
  reconnectMaxAttempts?: number;
  /**
   * Max bytes buffered while waiting for a frame's null terminator (default 4 MiB).
   * A peer that exceeds it (malformed, compromised, or not speaking QRC) gets its
   * socket destroyed instead of exhausting process memory.
   */
  maxBufferBytes?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Registrations we replay onto a fresh socket after a reconnect. */
interface ChangeGroupState {
  controls: Set<string>;
  components: Map<string, Set<string>>;
  /** AutoPoll rate (seconds) if the group is auto-polling; re-armed on reconnect. */
  autoPollRate?: number;
}

export class QrcError extends Error {
  code?: number;
  data?: unknown;
  constructor(err: unknown) {
    const o = (err && typeof err === 'object') ? err as Record<string, unknown> : null;
    super(o ? String(o.message ?? JSON.stringify(err)) : String(err));
    this.name = 'QrcError';
    if (o) {
      this.code = typeof o.code === 'number' ? o.code : undefined;
      this.data = o.data;
    }
  }
}

/**
 * The request was transmitted but the connection dropped before its response
 * arrived: the Core may or may not have applied it, and QRC has no dedup
 * mechanism to find out. Raised only for methods NOT classified idempotent
 * (those are retried transparently). Callers should re-read state to reconcile,
 * or re-issue explicitly once they've decided a duplicate is acceptable.
 */
export class QrcIndeterminateError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`QRC delivery indeterminate: the connection dropped after '${method}' was sent but before its response arrived — the Core may or may not have applied it`);
    this.name = 'QrcIndeterminateError';
    this.method = method;
  }
}

/**
 * Methods safe to retransmit when a response is lost to a connection drop:
 * reads, session/registration setup (re-asserting is a no-op), and removals
 * (already-gone is the desired state). Everything else — Control/Component/Mixer
 * sets, LoopPlayer, Snapshot, PA, raw send() of unknown methods — fails closed
 * with QrcIndeterminateError, because a duplicate could fire triggers, restart
 * playback, or re-run control logic on a live system.
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'NoOp',
  'StatusGet',
  'Logon',
  'Component.GetComponents',
  'Component.GetControls',
  'Component.Get',
  'Control.Get',
  'ChangeGroup.AddControl',
  'ChangeGroup.AddComponentControl',
  'ChangeGroup.Remove',
  'ChangeGroup.Poll',
  'ChangeGroup.Clear',
  'ChangeGroup.Destroy',
  'ChangeGroup.Invalidate',
  'ChangeGroup.AutoPoll',
]);

/**
 * Q-SYS Remote Control (QRC) client.
 * Speaks JSON-RPC 2.0 over a raw TCP socket (default port 1710), framed with
 * null terminators — the wire format QSC documents and that the Designer
 * Emulate-mode soft-core serves on localhost.
 *
 * Events: 'engineStatus' (params), 'notification' (full message), 'error', 'close',
 * plus reconnect lifecycle: 'reconnecting' (attempt #), 'reconnected',
 * 'reconnectError' ({attempt, error}), 'reconnectFailed'.
 */
export class QrcClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly keepAliveMs: number;
  private readonly requestTimeoutMs: number;
  private readonly reconnectEnabled: boolean;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectMaxAttempts: number;
  private readonly maxBufferBytes: number;
  private socket: net.Socket | null = null;
  /** Socket mid-dial (TCP connect not yet completed) so close() can cancel it. */
  private dialing: net.Socket | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private keepAliveTimer: NodeJS.Timeout | null = null;
  /** Transport is up (frames can be written). True during session replay. */
  private socketConnected = false;
  /** Transport is up AND logon/change-group replay finished — safe for callers. */
  private sessionReady = false;
  private explicitlyClosed = false;
  private reconnectPromise: Promise<void> | null = null;
  private logonCreds: { user: string; password: string } | null = null;
  private readonly changeGroups = new Map<string, ChangeGroupState>();

  constructor(opts: QrcClientOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? 1710;
    this.keepAliveMs = opts.keepAliveMs ?? 30_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.reconnectEnabled = opts.reconnect ?? true;
    this.reconnectInitialMs = opts.reconnectInitialMs ?? 500;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 10_000;
    this.reconnectMaxAttempts = opts.reconnectMaxAttempts ?? 8;
    this.maxBufferBytes = opts.maxBufferBytes ?? 4 * 1024 * 1024;
  }

  /** True once the session is fully established (post-replay) — not merely TCP-connected. */
  isConnected(): boolean {
    return this.sessionReady;
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    await this.openSocket();
    // A fresh connect has no session state to replay (close() clears creds/groups).
    this.sessionReady = true;
  }

  /** Open a fresh socket and wire its handlers. Rejects if the TCP connect fails
   *  or close() is called mid-dial — an explicit shutdown never resurrects a link. */
  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.dialing = sock;
      sock.setEncoding('utf8');
      const settleDial = () => {
        if (this.dialing === sock) this.dialing = null;
      };
      const onConnectError = (e: Error) => {
        settleDial();
        reject(e);
      };
      // close() destroys the dialing socket; without this the promise would hang.
      const onDialClose = () => {
        settleDial();
        reject(new Error('QRC client closed'));
      };
      sock.once('error', onConnectError);
      sock.once('close', onDialClose);
      sock.once('connect', () => {
        sock.removeListener('error', onConnectError);
        sock.removeListener('close', onDialClose);
        settleDial();
        if (this.explicitlyClosed) {
          sock.destroy();
          reject(new Error('QRC client closed'));
          return;
        }
        this.socket = sock;
        this.socketConnected = true;
        this.buf = '';
        sock.on('data', (chunk: Buffer | string) => this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
        sock.on('error', (e: Error) => this.emitError(e));
        sock.on('close', () => this.onClose());
        this.startKeepAlive();
        resolve();
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.maxBufferBytes) {
      // No terminator within the cap: the peer is not framing QRC. Drop the data
      // and the socket rather than growing the buffer without bound.
      this.buf = '';
      this.emitError(new Error(`QRC receive buffer exceeded ${this.maxBufferBytes} bytes without a frame terminator — closing socket`));
      this.socket?.destroy();
      return;
    }
    let idx: number;
    while ((idx = this.buf.indexOf('\0')) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!raw.trim()) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        this.emitError(new Error(`QRC parse error: ${raw.slice(0, 200)}`));
        continue;
      }
      // Valid JSON is not necessarily a valid envelope: `null`, numbers, strings,
      // and arrays would crash dispatch()'s property access — reject them here.
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        this.emitError(new Error(`QRC invalid frame (expected a JSON-RPC object): ${raw.slice(0, 200)}`));
        continue;
      }
      this.dispatch(msg as Record<string, unknown>);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id === 'number' && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new QrcError(msg.error));
      else p.resolve(msg.result);
      return;
    }
    // Unsolicited notification (EngineStatus on connect, change-group autopolls, etc.)
    if (typeof msg.method === 'string') {
      if (msg.method === 'EngineStatus') this.emit('engineStatus', msg.params);
      this.emit('notification', msg);
    }
  }

  /**
   * Send a JSON-RPC request and await the correlated response. If the socket is
   * down (or drops mid-request) and auto-reconnect is enabled, this waits for a
   * reconnect and retries once — but ONLY when the retry is provably safe:
   * either the request never reached the socket, or the method is classified
   * idempotent. A non-idempotent request whose response is lost rejects with
   * QrcIndeterminateError instead of silently executing twice (QRC has no
   * request dedup, so a blind retransmit can double a mutation).
   */
  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.sessionReady) await this.ensureReconnected();
    try {
      return await this.sendOnce(method, params);
    } catch (err) {
      const kind = this.classifyDrop(err);
      if (kind === 'response-lost' && !IDEMPOTENT_METHODS.has(method)) {
        throw new QrcIndeterminateError(method);
      }
      if (kind !== null && this.reconnectEnabled && !this.explicitlyClosed) {
        await this.ensureReconnected();
        if (this.sessionReady) return await this.sendOnce(method, params);
      }
      throw err;
    }
  }

  /**
   * How a request failed relative to the wire: 'never-sent' (rejected before the
   * frame was written — retrying anything is safe), 'response-lost' (written,
   * then the connection dropped — the Core may have applied it), or null (not a
   * connection failure; e.g. a timeout with the socket still up).
   */
  private classifyDrop(err: unknown): 'never-sent' | 'response-lost' | null {
    const m = (err as Error)?.message ?? '';
    if (m.includes('QRC not connected')) return 'never-sent';
    if (m.includes('QRC connection closed')) return 'response-lost';
    return null;
  }

  /** One request attempt on the current socket — no reconnect handling. Gated on
   *  the transport (not session-ready) because replayState() itself uses it. */
  private sendOnce(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket || !this.socketConnected) {
      return Promise.reject(new Error('QRC not connected — call connect() first'));
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? null, id }) + '\0';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QRC request timed out: ${method} (id ${id})`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(frame);
    });
  }

  /** Fire-and-forget notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (!this.socket || !this.socketConnected) return;
    this.socket.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? null }) + '\0');
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => this.notify('NoOp', {}), this.keepAliveMs);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private onClose(): void {
    this.socketConnected = false;
    this.sessionReady = false;
    this.stopKeepAlive();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('QRC connection closed'));
    }
    this.pending.clear();
    this.emit('close');
    // Kick a background reconnect on an unexpected drop. The !reconnectPromise
    // guard means a drop during an in-flight reconnect attempt won't start a
    // second loop (and our own teardownSocket() won't either).
    if (this.reconnectEnabled && !this.explicitlyClosed && !this.reconnectPromise) {
      void this.ensureReconnected();
    }
  }

  /** Resolve once the session is ready, driving (or joining) a reconnect attempt as needed. */
  private ensureReconnected(): Promise<void> {
    if (this.sessionReady) return Promise.resolve();
    if (this.explicitlyClosed || !this.reconnectEnabled) return Promise.resolve();
    if (!this.reconnectPromise) {
      this.reconnectPromise = this.runReconnect().finally(() => {
        this.reconnectPromise = null;
      });
    }
    return this.reconnectPromise;
  }

  /**
   * Re-dial with exponential backoff, then replay logon + change-group
   * registrations so polling resumes. Never rejects: callers read isConnected()
   * (or a subsequent sendOnce) for the outcome. Gives up after maxAttempts, but
   * the next request re-triggers a fresh attempt.
   */
  private async runReconnect(): Promise<void> {
    let delay = this.reconnectInitialMs;
    for (let attempt = 1; attempt <= this.reconnectMaxAttempts; attempt++) {
      if (this.explicitlyClosed) return;
      this.emit('reconnecting', attempt);
      try {
        await this.openSocket();
        await this.replayState();
        // close() may have raced the dial or the replay — never resurrect after
        // an explicit shutdown.
        if (this.explicitlyClosed) {
          this.teardownSocket();
          return;
        }
        this.sessionReady = true;
        this.emit('reconnected');
        return;
      } catch (err) {
        this.teardownSocket();
        this.emit('reconnectError', { attempt, error: err as Error });
        if (attempt >= this.reconnectMaxAttempts) break;
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.reconnectMaxMs);
      }
    }
    this.emit('reconnectFailed');
  }

  /** Re-establish session state on a fresh socket. Throws if any step fails. */
  private async replayState(): Promise<void> {
    if (this.logonCreds) {
      await this.sendOnce('Logon', { User: this.logonCreds.user, Password: this.logonCreds.password });
    }
    for (const [id, g] of this.changeGroups) {
      if (g.controls.size > 0) {
        await this.sendOnce('ChangeGroup.AddControl', { Id: id, Controls: [...g.controls] });
      }
      for (const [component, controls] of g.components) {
        if (controls.size > 0) {
          await this.sendOnce('ChangeGroup.AddComponentControl', {
            Id: id,
            Component: { Name: component, Controls: [...controls].map((n) => ({ Name: n })) },
          });
        }
      }
      // Re-arm AutoPoll last, once the group's controls exist on the fresh socket,
      // so a `watch` stream keeps receiving pushes across a reconnect.
      if (g.autoPollRate != null) {
        await this.sendOnce('ChangeGroup.AutoPoll', { Id: id, Rate: g.autoPollRate });
      }
    }
  }

  /** Tear down the current socket without triggering reconnect (used between attempts). */
  private teardownSocket(): void {
    this.stopKeepAlive();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.socketConnected = false;
    this.sessionReady = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  close(): void {
    this.explicitlyClosed = true;
    this.stopKeepAlive();
    if (this.dialing) {
      // Cancel an in-progress dial so shutdown can't leave a live connection behind.
      this.dialing.destroy();
      this.dialing = null;
    }
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.socketConnected = false;
    this.sessionReady = false;
    this.changeGroups.clear();
    this.logonCreds = null;
  }

  /** Emit 'error' if anyone is listening; otherwise log to stderr instead of throwing. */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else console.error('[qrc]', err.message);
  }

  // ---- QRC method wrappers ----

  async logon(user: string, password: string): Promise<unknown> {
    const result = await this.send('Logon', { User: user, Password: password });
    this.logonCreds = { user, password }; // remembered so reconnect can re-auth
    return result;
  }

  statusGet(): Promise<EngineStatus> {
    return this.send('StatusGet', 0) as Promise<EngineStatus>;
  }

  getComponents(): Promise<QrcComponent[]> {
    return this.send('Component.GetComponents', null) as Promise<QrcComponent[]>;
  }

  getComponentControls(name: string): Promise<{ Name: string; Controls: QrcControl[] }> {
    return this.send('Component.GetControls', { Name: name }) as Promise<{ Name: string; Controls: QrcControl[] }>;
  }

  getComponent(name: string, controls: string[]): Promise<{ Name: string; Controls: QrcControl[] }> {
    return this.send('Component.Get', {
      Name: name,
      Controls: controls.map((n) => ({ Name: n })),
    }) as Promise<{ Name: string; Controls: QrcControl[] }>;
  }

  setComponent(name: string, controls: Array<{ Name: string; Value: ControlValue; Ramp?: number }>): Promise<unknown> {
    return this.send('Component.Set', { Name: name, Controls: controls });
  }

  getControl(names: string[]): Promise<QrcControl[]> {
    return this.send('Control.Get', names) as Promise<QrcControl[]>;
  }

  setControl(name: string, value: ControlValue, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: name, Value: value };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Control.Set', params);
  }

  async changeGroupAddControl(id: string, controls: string[]): Promise<unknown> {
    const result = await this.send('ChangeGroup.AddControl', { Id: id, Controls: controls });
    const g = this.groupState(id);
    for (const c of controls) g.controls.add(c);
    return result;
  }

  async changeGroupAddComponentControl(id: string, component: string, controls: string[]): Promise<unknown> {
    const result = await this.send('ChangeGroup.AddComponentControl', {
      Id: id,
      Component: { Name: component, Controls: controls.map((n) => ({ Name: n })) },
    });
    const set = this.groupState(id).components.get(component) ?? new Set<string>();
    for (const c of controls) set.add(c);
    this.groupState(id).components.set(component, set);
    return result;
  }

  changeGroupPoll(id: string): Promise<{ Id: string; Changes: QrcControl[] }> {
    return this.send('ChangeGroup.Poll', { Id: id }) as Promise<{ Id: string; Changes: QrcControl[] }>;
  }

  /**
   * Have the Core auto-poll the group and push `ChangeGroup.Poll` notifications
   * at `rate` seconds. Remembered so an auto-reconnect re-arms it — otherwise a
   * dropped socket silently ends the stream.
   */
  async changeGroupAutoPoll(id: string, rate: number): Promise<unknown> {
    const result = await this.send('ChangeGroup.AutoPoll', { Id: id, Rate: rate });
    this.groupState(id).autoPollRate = rate;
    return result;
  }

  async changeGroupRemove(id: string, controls: string[]): Promise<unknown> {
    const result = await this.send('ChangeGroup.Remove', { Id: id, Controls: controls });
    const g = this.changeGroups.get(id);
    if (g) for (const c of controls) g.controls.delete(c); // drop from replay state too
    return result;
  }

  async changeGroupClear(id: string): Promise<unknown> {
    const result = await this.send('ChangeGroup.Clear', { Id: id });
    const g = this.changeGroups.get(id);
    if (g) {
      g.controls.clear();
      g.components.clear();
    }
    return result;
  }

  changeGroupInvalidate(id: string): Promise<unknown> {
    return this.send('ChangeGroup.Invalidate', { Id: id });
  }

  async changeGroupDestroy(id: string): Promise<unknown> {
    const result = await this.send('ChangeGroup.Destroy', { Id: id });
    this.changeGroups.delete(id); // stop replaying a group the caller tore down
    return result;
  }

  /**
   * Recall a saved snapshot. Note: QRC's `Bank` param is the snapshot *number*
   * within a named bank — `bank` here is the bank name, `number` the slot.
   */
  snapshotLoad(bank: string, number: number, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: bank, Bank: number };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Snapshot.Load', params);
  }

  snapshotSave(bank: string, number: number): Promise<unknown> {
    return this.send('Snapshot.Save', { Name: bank, Bank: number });
  }

  // ---- Mixer.Set* (write-only; no Mixer.Get* exists — read state back via Component.Get) ----
  // Selectors are QRC String Syntax strings: '*', '1 2 3'/'1,2,3', '1-6', '!3', combinable
  // ('1-8 !3', '* !3-5'). `Ramp` (seconds) applies to gain/delay only. Note: `Cues` is
  // documented only as a "string specification of mixer cues" — unlike Inputs/Outputs it is
  // not cross-referenced to String Syntax, so treat cue range/negation as unverified.

  mixerSetCrossPointGain(name: string, inputs: string, outputs: string, value: number, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: name, Inputs: inputs, Outputs: outputs, Value: value };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Mixer.SetCrossPointGain', params);
  }

  mixerSetCrossPointDelay(name: string, inputs: string, outputs: string, value: number, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: name, Inputs: inputs, Outputs: outputs, Value: value };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Mixer.SetCrossPointDelay', params);
  }

  mixerSetCrossPointMute(name: string, inputs: string, outputs: string, value: boolean): Promise<unknown> {
    return this.send('Mixer.SetCrossPointMute', { Name: name, Inputs: inputs, Outputs: outputs, Value: value });
  }

  mixerSetCrossPointSolo(name: string, inputs: string, outputs: string, value: boolean): Promise<unknown> {
    return this.send('Mixer.SetCrossPointSolo', { Name: name, Inputs: inputs, Outputs: outputs, Value: value });
  }

  mixerSetInputGain(name: string, inputs: string, value: number, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: name, Inputs: inputs, Value: value };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Mixer.SetInputGain', params);
  }

  mixerSetInputMute(name: string, inputs: string, value: boolean): Promise<unknown> {
    return this.send('Mixer.SetInputMute', { Name: name, Inputs: inputs, Value: value });
  }

  mixerSetInputSolo(name: string, inputs: string, value: boolean): Promise<unknown> {
    return this.send('Mixer.SetInputSolo', { Name: name, Inputs: inputs, Value: value });
  }

  mixerSetOutputGain(name: string, outputs: string, value: number, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: name, Outputs: outputs, Value: value };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Mixer.SetOutputGain', params);
  }

  mixerSetOutputMute(name: string, outputs: string, value: boolean): Promise<unknown> {
    return this.send('Mixer.SetOutputMute', { Name: name, Outputs: outputs, Value: value });
  }

  mixerSetCueGain(name: string, cues: string, value: number, ramp?: number): Promise<unknown> {
    const params: Record<string, unknown> = { Name: name, Cues: cues, Value: value };
    if (ramp != null) params.Ramp = ramp;
    return this.send('Mixer.SetCueGain', params);
  }

  mixerSetCueMute(name: string, cues: string, value: boolean): Promise<unknown> {
    return this.send('Mixer.SetCueMute', { Name: name, Cues: cues, Value: value });
  }

  mixerSetInputCueEnable(name: string, cues: string, inputs: string, value: boolean): Promise<unknown> {
    return this.send('Mixer.SetInputCueEnable', { Name: name, Cues: cues, Inputs: inputs, Value: value });
  }

  mixerSetInputCueAfl(name: string, cues: string, inputs: string, value: boolean): Promise<unknown> {
    return this.send('Mixer.SetInputCueAfl', { Name: name, Cues: cues, Inputs: inputs, Value: value });
  }

  // ---- LoopPlayer.{Start,Stop,Cancel} (write-only; no LoopPlayer.Get* exists — read state
  // back via Component.Get on the Loop Player's per-output controls). Unlike the Mixer, Stop/
  // Cancel take `Outputs` as a **table of integers** ([1,2]), NOT QRC String Syntax. `StartTime`
  // is passed raw: -1 now, -2 queue-after-current, ≥0 absolute time-of-day (see LoopPlayerStart).

  /**
   * Schedule file playback on a Loop Player (LoopPlayer.Start). `files` is the full array —
   * one Name/Output object per output. `loop`/`seek`/`log`/`refId` and `startTime` are
   * TOP-LEVEL request params applying to the whole job (per the QRC spec — a Files entry
   * carries only Name/Output); unset options are omitted from the wire, letting the Core apply
   * its documented defaults (loop=false, seek=0, startTime=0). `refId` requests an async
   * failure notification — the notification itself isn't surfaced yet (no push channel), but
   * the Core still logs it.
   */
  loopPlayerStart(params: LoopPlayerStartParams): Promise<unknown> {
    const p: Record<string, unknown> = {
      Name: params.name,
      Files: params.files.map((f) => ({ Name: f.name, Output: f.output })),
    };
    if (params.startTime != null) p.StartTime = params.startTime;
    if (params.loop != null) p.Loop = params.loop;
    if (params.seek != null) p.Seek = params.seek;
    if (params.log != null) p.Log = params.log;
    if (params.refId != null) p.RefID = params.refId;
    return this.send('LoopPlayer.Start', p);
  }

  /** Stop playback on the given output tracks (LoopPlayer.Stop). `outputs` is an integer table. */
  loopPlayerStop(name: string, outputs: number[], log?: boolean): Promise<unknown> {
    const p: Record<string, unknown> = { Name: name, Outputs: outputs };
    if (log != null) p.Log = log;
    return this.send('LoopPlayer.Stop', p);
  }

  /** Cancel a pending/queued (future-start) job on the given outputs without disrupting current
   *  playback (LoopPlayer.Cancel). `outputs` is an integer table. */
  loopPlayerCancel(name: string, outputs: number[], log?: boolean): Promise<unknown> {
    const p: Record<string, unknown> = { Name: name, Outputs: outputs };
    if (log != null) p.Log = log;
    return this.send('LoopPlayer.Cancel', p);
  }

  private groupState(id: string): ChangeGroupState {
    let g = this.changeGroups.get(id);
    if (!g) {
      g = { controls: new Set(), components: new Map() };
      this.changeGroups.set(id, g);
    }
    return g;
  }
}

export type ControlValue = number | string | boolean;

/** One file→output assignment in a LoopPlayer.Start. Lowercase here; mapped to QRC casing
 *  (Name/Output) on the wire. Per the QRC spec a Files entry carries ONLY these two fields —
 *  loop/seek/log/refId are top-level params on LoopPlayerStartParams. */
export interface LoopPlayerFile {
  /** Path + filename of the file to play, as it exists on the Core. */
  name: string;
  /** Output track number to play on. */
  output: number;
}

export interface LoopPlayerStartParams {
  /** Loop Player component name (its "Code Name" property). */
  name: string;
  /** -1 = now, -2 = queue after current, ≥0 = absolute time-of-day (s). Omitted → Core default (0). */
  startTime?: number;
  /** One or more file→output assignments. */
  files: LoopPlayerFile[];
  /** Loop playback continuously (default false). Applies to the whole job. */
  loop?: boolean;
  /** Offset into the file to start playback, in seconds (default 0). */
  seek?: number;
  /** Log the start message + errors to the Core event log (default false). */
  log?: boolean;
  /** If set, the Core sends an async failure notification (+ event-log entry) for this job. */
  refId?: string;
}

export interface EngineStatus {
  Platform: string;
  State: string;
  DesignName: string;
  DesignCode: string;
  IsRedundant: boolean;
  IsEmulator: boolean;
  Status: { Code: number; String: string };
}

export interface QrcComponent {
  ID?: string;
  Name: string;
  Type: string;
  Properties?: Array<{ Name: string; Value: string; PrettyName?: string }>;
}

export interface QrcControl {
  Name: string;
  Value: ControlValue;
  String?: string;
  Position?: number;
}
