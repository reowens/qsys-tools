import { QrcClient, type QrcControl, type LoopPlayerFile } from 'qsys-qrc';
import {
  CONTROL_HEADER,
  coerceValue,
  controlRow,
  renderKv,
  renderTable,
  type ControlRow,
} from './format.js';

export class UsageError extends Error {}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Aborting stops a `watch` stream (bin wires SIGINT/SIGTERM here). */
  signal?: AbortSignal;
}

export const USAGE = `usage: qsys <command> [args...] [flags]

commands:
  status                                            engine/design status
  ls [--type <substr>] [--filter <substr>]          list components
  get <name...>                                     read named control(s)
  set <name> <value> [--ramp <s>]                   set a named control
  get-component <comp> [ctrl...]                    read component controls (all if none given)
  set-component <comp> <ctrl> <value> [--ramp <s>]  set a component control
  watch [--component <comp>] <ctrl...> [--interval <s>]   stream changes until Ctrl-C
  snapshot load <bank> <slot> [--ramp <s>]          recall a snapshot
  snapshot save <bank> <slot>                       save a snapshot
  mixer crosspoint <comp> <in> <out> <op> <value> [--ramp <s>]  op: gain|delay|mute|solo
  mixer input <comp> <in> <op> <value> [--ramp <s>]             op: gain|mute|solo
  mixer output <comp> <out> <op> <value> [--ramp <s>]           op: gain|mute
  mixer cue <comp> <cues> <op> <value> [--ramp <s>]             op: gain|mute
  mixer cue-input <comp> <cues> <in> <op> <value>               op: enable|afl
  loop-player start <comp> <file> <output> [--loop] [--seek <s>] [--start-time <t>] [--log] [--ref-id <id>]
  loop-player stop <comp> <outputs> [--log]                     outputs: int list "1,2"
  loop-player cancel <comp> <outputs> [--log]                   cancel a queued future-start job

connection:
  --host <ip>        Core/emulator address (or QSYS_HOST)
  --port <n>         QRC port, default 1710 (or QSYS_PORT)
  --user/--password  logon if the Core requires it (or QSYS_USER/QSYS_PASSWORD)
  --timeout <s>      per-request timeout, default 10

output:
  --json             machine-readable output (watch emits JSON lines)

values: true/false → boolean, numeric → number, anything else → string.
Negative values work as-is: qsys set MainGain -6
mixer selectors use QRC String Syntax (* all, "1 2 3" list, 1-6 range, !3 negate); quote
selectors and * so the shell doesn't split/glob them. Gain/delay take a number (+ optional
--ramp); mute/solo/enable/afl take true/false. Read mixer state back with get-component.`;

/** Flags taking a value; everything else that starts with `--` must be boolean. */
const STRING_FLAGS = new Set([
  'host', 'port', 'user', 'password', 'timeout',
  'type', 'filter', 'ramp', 'component', 'interval',
  'seek', 'start-time', 'ref-id',
]);
const BOOL_FLAGS = new Set(['json', 'help', 'loop', 'log']);

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/**
 * Hand-rolled instead of node:util parseArgs so bare negative numbers stay
 * positional — `qsys set MainGain -6` must not read `-6` as an option.
 */
export function parseCliArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (BOOL_FLAGS.has(name)) {
        if (eq !== -1) throw new UsageError(`--${name} takes no value`);
        flags[name] = true;
      } else if (STRING_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (value === undefined) throw new UsageError(`--${name} requires a value`);
        flags[name] = value;
      } else {
        throw new UsageError(`unknown option --${name}`);
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function numFlag(raw: string | boolean | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`invalid --${name}: ${String(raw)}`);
  return n;
}

function need(positionals: string[], count: number, shape: string): void {
  if (positionals.length < count) throw new UsageError(`expected: ${shape}`);
}

export async function runCli(
  argv: string[],
  io: CliIo = { out: console.log, err: console.error },
): Promise<number> {
  let flags: Record<string, string | boolean>;
  let positionals: string[];
  try {
    ({ flags, positionals } = parseCliArgs(argv));
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`qsys: ${err.message}`);
      io.err(USAGE);
      return 2;
    }
    throw err;
  }

  if (flags.help) {
    io.out(USAGE);
    return 0;
  }
  const cmd = positionals[0];
  const rest = positionals.slice(1);
  if (!cmd) {
    io.err(USAGE);
    return 2;
  }

  const host = (flags.host as string | undefined) ?? process.env.QSYS_HOST;
  if (!host) {
    io.err('qsys: --host (or QSYS_HOST) is required');
    return 2;
  }

  let client: QrcClient;
  try {
    const port = numFlag(flags.port ?? process.env.QSYS_PORT, 'port') ?? 1710;
    const timeoutS = numFlag(flags.timeout, 'timeout') ?? 10;
    client = new QrcClient({
      host,
      port,
      requestTimeoutMs: timeoutS * 1000,
      // One-shot commands should fail fast; only a watch stream rides out drops.
      reconnect: cmd === 'watch',
    });
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`qsys: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const json = flags.json === true;
  try {
    await client.connect();
    const user = (flags.user as string | undefined) ?? process.env.QSYS_USER;
    const password = (flags.password as string | undefined) ?? process.env.QSYS_PASSWORD;
    if (user !== undefined && password !== undefined) await client.logon(user, password);

    switch (cmd) {
      case 'status': {
        const s = await client.statusGet();
        if (json) {
          io.out(JSON.stringify(s, null, 2));
        } else {
          io.out(renderKv([
            ['Design', `${s.DesignName} (code ${s.DesignCode})`],
            ['Platform', s.Platform + (s.IsEmulator ? ' (emulator)' : '')],
            ['State', s.State],
            ['Status', `${s.Status.Code} ${s.Status.String}`],
            ['Redundant', String(s.IsRedundant)],
          ]));
        }
        return 0;
      }

      case 'ls': {
        let comps = await client.getComponents();
        const type = (flags.type as string | undefined)?.toLowerCase();
        const filter = (flags.filter as string | undefined)?.toLowerCase();
        if (type) comps = comps.filter((c) => c.Type.toLowerCase().includes(type));
        if (filter) comps = comps.filter((c) => c.Name.toLowerCase().includes(filter));
        if (json) io.out(JSON.stringify(comps, null, 2));
        else io.out(renderTable(['NAME', 'TYPE'], comps.map((c) => [c.Name, c.Type])));
        return 0;
      }

      case 'get': {
        need(rest, 1, 'qsys get <name...>');
        const controls = await client.getControl(rest);
        printControls(io, controls, json);
        return 0;
      }

      case 'set': {
        need(rest, 2, 'qsys set <name> <value> [--ramp <s>]');
        const [name, raw] = rest;
        await client.setControl(name, coerceValue(raw), numFlag(flags.ramp, 'ramp'));
        printControls(io, await client.getControl([name]), json); // echo the readback
        return 0;
      }

      case 'get-component': {
        need(rest, 1, 'qsys get-component <comp> [ctrl...]');
        const [comp, ...ctrls] = rest;
        const r = ctrls.length > 0
          ? await client.getComponent(comp, ctrls)
          : await client.getComponentControls(comp);
        printControls(io, r.Controls, json);
        return 0;
      }

      case 'set-component': {
        need(rest, 3, 'qsys set-component <comp> <ctrl> <value> [--ramp <s>]');
        const [comp, ctrl, raw] = rest;
        await client.setComponent(comp, [
          { Name: ctrl, Value: coerceValue(raw), Ramp: numFlag(flags.ramp, 'ramp') },
        ]);
        printControls(io, (await client.getComponent(comp, [ctrl])).Controls, json);
        return 0;
      }

      case 'snapshot': {
        need(rest, 3, 'qsys snapshot <load|save> <bank> <slot>');
        const [sub, bank, slotRaw] = rest;
        const slot = Number(slotRaw);
        if (!Number.isInteger(slot)) throw new UsageError(`invalid snapshot slot: ${slotRaw}`);
        if (sub === 'load') await client.snapshotLoad(bank, slot, numFlag(flags.ramp, 'ramp'));
        else if (sub === 'save') await client.snapshotSave(bank, slot);
        else throw new UsageError(`unknown snapshot subcommand: ${sub}`);
        io.out(`snapshot ${sub}: ${bank} #${slot}`);
        return 0;
      }

      case 'mixer':
        return await mixerCommand(client, rest, flags, json, io);

      case 'loop-player':
        return await loopPlayerCommand(client, rest, flags, json, io);

      case 'watch':
        return await watch(client, rest, flags, json, io);

      default:
        throw new UsageError(`unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`qsys: ${err.message}`);
      io.err(USAGE);
      return 2;
    }
    io.err(`qsys: ${(err as Error).message}`);
    return 1;
  } finally {
    client.close();
  }
}

function printControls(io: CliIo, controls: QrcControl[], json: boolean): void {
  if (json) io.out(JSON.stringify(controls, null, 2));
  else io.out(renderTable(CONTROL_HEADER, controls.map(controlRow)));
}

/** Ops whose value is a number (dB gain / seconds delay) and that accept an optional ramp. */
const MIXER_NUMERIC_OPS = new Set(['gain', 'delay']);

/** Coerce + enforce the op↔value-type pairing (gain/delay → number, else boolean). Mirrors the
 *  MCP server's guardMixerValue; kept local so qsys-cli stays decoupled from qsys-mcp. */
function mixerValue(op: string, raw: string): number | boolean {
  const v = coerceValue(raw);
  if (MIXER_NUMERIC_OPS.has(op)) {
    if (typeof v !== 'number') throw new UsageError(`mixer ${op} needs a numeric value (dB/seconds), got "${raw}"`);
    return v;
  }
  if (typeof v !== 'boolean') throw new UsageError(`mixer ${op} needs a boolean value (true/false), got "${raw}"`);
  return v;
}

function mixerOp(op: string, allowed: string[]): string {
  if (!allowed.includes(op)) throw new UsageError(`mixer: invalid op "${op}" (expected ${allowed.join('|')})`);
  return op;
}

function emitMixer(io: CliIo, json: boolean, target: string, comp: string, fields: Record<string, unknown>): number {
  if (json) {
    io.out(JSON.stringify({ ok: true, target, name: comp, ...fields }, null, 2));
    return 0;
  }
  const sel: string[] = [];
  if (fields.inputs != null) sel.push(`in=${fields.inputs}`);
  if (fields.outputs != null) sel.push(`out=${fields.outputs}`);
  if (fields.cues != null) sel.push(`cue=${fields.cues}`);
  const ramp = fields.ramp != null ? ` ramp=${fields.ramp}s` : '';
  io.out(`mixer ${target} "${comp}" ${sel.join(' ')} ${fields.op}=${String(fields.value)}${ramp}`.replace(/\s+/g, ' '));
  return 0;
}

/**
 * `qsys mixer <target> …` — mirrors the 5 grouped MCP mixer tools. Write-only (no Mixer.Get on
 * the wire); prints a confirmation line and points at get-component for readback. Selectors are
 * QRC String Syntax strings passed through verbatim (quote spaces/`*` in the shell).
 */
async function mixerCommand(
  client: QrcClient,
  rest: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
  io: CliIo,
): Promise<number> {
  const target = rest[0];
  const a = rest.slice(1);
  const ramp = numFlag(flags.ramp, 'ramp');
  switch (target) {
    case 'crosspoint': {
      need(a, 5, 'qsys mixer crosspoint <comp> <inputs> <outputs> <gain|delay|mute|solo> <value> [--ramp <s>]');
      const [comp, inputs, outputs, opRaw, raw] = a;
      const op = mixerOp(opRaw, ['gain', 'delay', 'mute', 'solo']);
      const value = mixerValue(op, raw);
      if (op === 'gain') await client.mixerSetCrossPointGain(comp, inputs, outputs, value as number, ramp);
      else if (op === 'delay') await client.mixerSetCrossPointDelay(comp, inputs, outputs, value as number, ramp);
      else if (op === 'mute') await client.mixerSetCrossPointMute(comp, inputs, outputs, value as boolean);
      else await client.mixerSetCrossPointSolo(comp, inputs, outputs, value as boolean);
      return emitMixer(io, json, 'crosspoint', comp, { inputs, outputs, op, value, ramp });
    }
    case 'input': {
      need(a, 4, 'qsys mixer input <comp> <inputs> <gain|mute|solo> <value> [--ramp <s>]');
      const [comp, inputs, opRaw, raw] = a;
      const op = mixerOp(opRaw, ['gain', 'mute', 'solo']);
      const value = mixerValue(op, raw);
      if (op === 'gain') await client.mixerSetInputGain(comp, inputs, value as number, ramp);
      else if (op === 'mute') await client.mixerSetInputMute(comp, inputs, value as boolean);
      else await client.mixerSetInputSolo(comp, inputs, value as boolean);
      return emitMixer(io, json, 'input', comp, { inputs, op, value, ramp });
    }
    case 'output': {
      need(a, 4, 'qsys mixer output <comp> <outputs> <gain|mute> <value> [--ramp <s>]');
      const [comp, outputs, opRaw, raw] = a;
      const op = mixerOp(opRaw, ['gain', 'mute']);
      const value = mixerValue(op, raw);
      if (op === 'gain') await client.mixerSetOutputGain(comp, outputs, value as number, ramp);
      else await client.mixerSetOutputMute(comp, outputs, value as boolean);
      return emitMixer(io, json, 'output', comp, { outputs, op, value, ramp });
    }
    case 'cue': {
      need(a, 4, 'qsys mixer cue <comp> <cues> <gain|mute> <value> [--ramp <s>]');
      const [comp, cues, opRaw, raw] = a;
      const op = mixerOp(opRaw, ['gain', 'mute']);
      const value = mixerValue(op, raw);
      if (op === 'gain') await client.mixerSetCueGain(comp, cues, value as number, ramp);
      else await client.mixerSetCueMute(comp, cues, value as boolean);
      return emitMixer(io, json, 'cue', comp, { cues, op, value, ramp });
    }
    case 'cue-input': {
      need(a, 5, 'qsys mixer cue-input <comp> <cues> <inputs> <enable|afl> <value>');
      const [comp, cues, inputs, opRaw, raw] = a;
      const op = mixerOp(opRaw, ['enable', 'afl']);
      const value = mixerValue(op, raw);
      if (op === 'enable') await client.mixerSetInputCueEnable(comp, cues, inputs, value as boolean);
      else await client.mixerSetInputCueAfl(comp, cues, inputs, value as boolean);
      return emitMixer(io, json, 'cue-input', comp, { cues, inputs, op, value });
    }
    default:
      throw new UsageError(`unknown mixer target: ${target ?? '(none)'} (expected crosspoint|input|output|cue|cue-input)`);
  }
}

/** Parse an integer output list ("1,2" or "1 2") for loop-player stop/cancel. */
function parseOutputList(raw: string): number[] {
  const parts = raw.split(/[ ,]+/).filter(Boolean);
  if (parts.length === 0) throw new UsageError('expected at least one output number');
  return parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n)) throw new UsageError(`invalid output: ${p}`);
    return n;
  });
}

/**
 * `qsys loop-player <start|stop|cancel> …` — mirrors the 2 grouped MCP loop-player tools.
 * Write-only (no LoopPlayer.Get on the wire); prints a confirmation line and points at
 * get-component for readback. The CLI plays a single file per `start`; the MCP tool accepts
 * a full files[] array. `stop`/`cancel` take an integer output list ("1,2"), NOT String Syntax.
 */
async function loopPlayerCommand(
  client: QrcClient,
  rest: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
  io: CliIo,
): Promise<number> {
  const target = rest[0];
  const a = rest.slice(1);
  switch (target) {
    case 'start': {
      need(a, 3, 'qsys loop-player start <comp> <file> <output> [--loop] [--seek <s>] [--start-time <t>] [--log] [--ref-id <id>]');
      const [comp, file, outputRaw] = a;
      const output = Number(outputRaw);
      if (!Number.isInteger(output)) throw new UsageError(`invalid output: ${outputRaw}`);
      const startTime = numFlag(flags['start-time'], 'start-time');
      const seek = numFlag(flags.seek, 'seek');
      const refId = flags['ref-id'] as string | undefined;
      const fileEntry: LoopPlayerFile = { name: file, output };
      if (flags.loop === true) fileEntry.loop = true;
      if (seek != null) fileEntry.seek = seek;
      if (flags.log === true) fileEntry.log = true;
      if (refId != null) fileEntry.refId = refId;
      await client.loopPlayerStart({ name: comp, files: [fileEntry], startTime });
      if (json) {
        io.out(JSON.stringify({ ok: true, target: 'start', name: comp, files: [fileEntry], ...(startTime != null ? { startTime } : {}) }, null, 2));
        return 0;
      }
      const opts: string[] = [];
      if (flags.loop === true) opts.push('loop');
      if (seek != null) opts.push(`seek=${seek}s`);
      if (startTime != null) opts.push(`start=${startTime}`);
      io.out(`loop-player start "${comp}" out=${output} file="${file}"${opts.length ? ' ' + opts.join(' ') : ''}`);
      return 0;
    }
    case 'stop':
    case 'cancel': {
      need(a, 2, `qsys loop-player ${target} <comp> <outputs> [--log]`);
      const [comp, outputsRaw] = a;
      const outputs = parseOutputList(outputsRaw);
      const log = flags.log === true ? true : undefined;
      if (target === 'stop') await client.loopPlayerStop(comp, outputs, log);
      else await client.loopPlayerCancel(comp, outputs, log);
      if (json) {
        io.out(JSON.stringify({ ok: true, target, name: comp, outputs, ...(log ? { log } : {}) }, null, 2));
        return 0;
      }
      io.out(`loop-player ${target} "${comp}" outputs=${outputs.join(',')}${log ? ' log' : ''}`);
      return 0;
    }
    default:
      throw new UsageError(`unknown loop-player target: ${target ?? '(none)'} (expected start|stop|cancel)`);
  }
}

/**
 * Change-group stream: register the controls, print current values, then let
 * the Core push changes via ChangeGroup.AutoPoll until the abort signal fires.
 */
async function watch(
  client: QrcClient,
  names: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
  io: CliIo,
): Promise<number> {
  need(names, 1, 'qsys watch [--component <comp>] <ctrl...>');
  const component = flags.component as string | undefined;
  const interval = numFlag(flags.interval, 'interval') ?? 0.5;
  const id = `qsys-cli-${process.pid}`;

  if (component) await client.changeGroupAddComponentControl(id, component, names);
  else await client.changeGroupAddControl(id, names);

  const emit = (c: ControlRow) => {
    if (json) io.out(JSON.stringify(c));
    else io.out(`${new Date().toISOString().slice(11, 23)}  ${controlRow(c).join('  ').trimEnd()}`);
  };

  // First poll returns current values — the baseline before the stream starts.
  for (const c of (await client.changeGroupPoll(id)).Changes) emit(c);
  // Wrapper (not a raw send) so the AutoPoll is re-armed if the socket reconnects.
  await client.changeGroupAutoPoll(id, interval);

  const onNotification = (msg: { method?: string; params?: { Id?: string; Changes?: ControlRow[] } }) => {
    if (msg.method !== 'ChangeGroup.Poll' || msg.params?.Id !== id) return;
    for (const c of msg.params.Changes ?? []) emit(c);
  };
  client.on('notification', onNotification);

  await new Promise<void>((resolve) => {
    if (io.signal) {
      // Only the abort signal ends the stream — a socket drop just reconnects.
      if (io.signal.aborted) return resolve();
      io.signal.addEventListener('abort', () => resolve(), { once: true });
    } else {
      // No signal (programmatic use): stream until the caller closes the client.
      client.once('close', () => resolve());
    }
  });

  client.off('notification', onNotification);
  if (client.isConnected()) await client.changeGroupDestroy(id).catch(() => {});
  return 0;
}
