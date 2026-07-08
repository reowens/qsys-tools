import { QrcClient, type QrcControl } from 'qsys-qrc';
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

connection:
  --host <ip>        Core/emulator address (or QSYS_HOST)
  --port <n>         QRC port, default 1710 (or QSYS_PORT)
  --user/--password  logon if the Core requires it (or QSYS_USER/QSYS_PASSWORD)
  --timeout <s>      per-request timeout, default 10

output:
  --json             machine-readable output (watch emits JSON lines)

values: true/false → boolean, numeric → number, anything else → string.
Negative values work as-is: qsys set MainGain -6`;

/** Flags taking a value; everything else that starts with `--` must be boolean. */
const STRING_FLAGS = new Set([
  'host', 'port', 'user', 'password', 'timeout',
  'type', 'filter', 'ramp', 'component', 'interval',
]);
const BOOL_FLAGS = new Set(['json', 'help']);

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
