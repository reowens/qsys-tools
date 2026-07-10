import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { QrcClient, type EngineStatus, type QrcComponent, type QrcControl } from 'qsys-qrc';

const { version: PKG_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string };

function ok(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

const controlValue = z.union([z.number(), z.string(), z.boolean()]);

// Mixer value can be a dB/seconds number (gain/delay) or a boolean (mute/solo/enable/afl).
// zod can't bind the value *type* to the `op` field, so tools accept the union and enforce
// the op↔type pairing at runtime via guardMixerValue.
const mixerValue = z.union([z.number(), z.boolean()]);
const mixerSelectorHint =
  'QRC String Syntax: "*" (all), "1 2 3"/"1,2,3" (list), "1-6" (range), "!3" (negate), combinable ("1-8 !3")';

/** Ops whose value is a number (dB gain / seconds delay) and that accept an optional ramp. */
const MIXER_NUMERIC_OPS = new Set(['gain', 'delay']);

/** Enforce the op↔value-type binding zod can't express. Throws → caught by the handler's fail(). */
function guardMixerValue(op: string, value: number | boolean): void {
  if (MIXER_NUMERIC_OPS.has(op)) {
    if (typeof value !== 'number') throw new Error(`Mixer op "${op}" requires a numeric value (dB/seconds), got ${typeof value}`);
  } else if (typeof value !== 'boolean') {
    throw new Error(`Mixer op "${op}" requires a boolean value, got ${typeof value}`);
  }
}

/** Client-side trim — QRC has no server-side filter/pagination, so we shape the full response. */
function shapeComponents(
  comps: QrcComponent[],
  opts: { filter?: string; type?: string; names_only?: boolean },
): unknown {
  let out = comps;
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    out = out.filter((c) => c.Name.toLowerCase().includes(f));
  }
  if (opts.type) {
    const t = opts.type.toLowerCase();
    out = out.filter((c) => (c.Type ?? '').toLowerCase().includes(t));
  }
  return opts.names_only ? out.map((c) => ({ Name: c.Name, Type: c.Type })) : out;
}

function shapeControls(
  res: { Name: string; Controls: QrcControl[] },
  opts: { filter?: string; names_only?: boolean },
): unknown {
  let ctrls = res.Controls;
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    ctrls = ctrls.filter((c) => c.Name.toLowerCase().includes(f));
  }
  if (opts.names_only) return { Name: res.Name, Controls: ctrls.map((c) => c.Name) };
  return { ...res, Controls: ctrls };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'qsys-mcp', version: PKG_VERSION });

  // Connection state is scoped to this server instance (NOT module-global):
  // multiple buildServer() instances in one process must not share a target,
  // and stale callbacks from an abandoned connect must not clobber a newer one.
  let client: QrcClient | null = null;
  let lastEngineStatus: EngineStatus | null = null;
  // Live-write capability, granted once per connection via qsys_connect's
  // allow_live_writes flag. Never inferred.
  let allowLiveWrites = false;
  // Bumped on every qsys_connect call; an attempt whose generation is stale by
  // the time it finishes was superseded and must close its candidate instead of
  // publishing it.
  let connectGeneration = 0;

  // Tie QRC cleanup to the MCP transport: when the client editor/agent goes away
  // (stdio EOF, transport close), drop the authenticated Core socket instead of
  // holding it open — and its keepalive — from an orphaned process.
  server.server.onclose = () => {
    connectGeneration++;
    client?.close();
    client = null;
    lastEngineStatus = null;
    allowLiveWrites = false;
  };

  function requireClient(): QrcClient {
    // Don't gate on isConnected(): a reconnect-enabled client may be mid-drop, and
    // its send() transparently waits for the socket to come back. Only a missing
    // client (never connected, or explicitly disconnected) is a hard error.
    if (!client) {
      throw new Error('Not connected to Q-SYS. Call qsys_connect first.');
    }
    return client;
  }

  /**
   * Fail-closed write gate, called BEFORE every mutation reaches the wire.
   * Writes are permitted only when the target is a known emulator, or the
   * caller explicitly connected with allow_live_writes. Unknown/missing engine
   * status counts as live — never guess with real audio.
   */
  function assertWritePermitted(): void {
    if (allowLiveWrites) return;
    if (!lastEngineStatus) {
      throw new Error(
        'Write refused: engine status is unknown, so the target must be assumed to be a LIVE Q-SYS Core. ' +
          'Reconnect with qsys_connect { allow_live_writes: true } to write anyway.',
      );
    }
    if (lastEngineStatus.IsEmulator !== true) {
      throw new Error(
        `Write refused: connected to a LIVE Q-SYS Core (design "${lastEngineStatus.DesignName}") — this would change real audio. ` +
          'Reconnect with qsys_connect { allow_live_writes: true } to enable live writes for this session.',
      );
    }
  }

  /** Warn when a permitted write just changed a live Core rather than an emulator. */
  function liveCoreWarning(): string | null {
    if (lastEngineStatus && lastEngineStatus.IsEmulator === false) {
      return `⚠ Writing to a LIVE Q-SYS Core (design "${lastEngineStatus.DesignName}"), not an emulator — this changes real audio.`;
    }
    return null;
  }

  server.registerTool(
    'qsys_connect',
    {
      title: 'Connect to Q-SYS',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Connect to a Q-SYS Core or to Q-SYS Designer running in Emulate mode (press F6 in Designer), over the QRC protocol (TCP). For a local emulator use host "127.0.0.1" and port 1710. Must be called before any other tool.',
      inputSchema: {
        host: z.string().default('127.0.0.1').describe('Core IP/hostname, or 127.0.0.1 for a local Designer emulator'),
        port: z.number().int().default(1710).describe('QRC port (default 1710)'),
        user: z.string().optional().describe('Username, if the design requires authentication'),
        password: z.string().optional().describe('Password, if the design requires authentication'),
        reconnect: z
          .boolean()
          .default(true)
          .describe('Auto-reconnect on a dropped socket (Core restart, network blip), replaying change-group registrations so polling resumes. Default true.'),
        allow_live_writes: z
          .boolean()
          .default(false)
          .describe(
            'Permit write tools against a LIVE (non-emulator) Core. Default false: writes are refused unless the target reports IsEmulator=true. Set true only when the user has explicitly approved changing a real system.',
          ),
      },
    },
    async ({ host, port, user, password, reconnect, allow_live_writes }) => {
      // Fail-safe ordering: drop the old connection immediately (a failed attempt
      // must not leave writes silently going to the previous target), publish the
      // candidate only after logon + status fully succeed, and close the candidate
      // on every failure path so no half-open socket leaks.
      const gen = ++connectGeneration;
      if (client) {
        client.close();
        client = null;
        lastEngineStatus = null;
      }
      allowLiveWrites = false;
      const c = new QrcClient({ host, port, reconnect });
      c.on('engineStatus', (s: EngineStatus) => {
        // Ignore pushes from a superseded/unpublished connection.
        if (client === c) lastEngineStatus = s;
      });
      c.on('error', () => {
        /* surfaced per-request; avoid crashing the server on transient socket errors */
      });
      c.on('reconnecting', (attempt: number) => console.error(`[qrc] connection dropped — reconnecting (attempt ${attempt})…`));
      c.on('reconnected', () => console.error('[qrc] reconnected; change-group registrations replayed'));
      c.on('reconnectFailed', () => console.error('[qrc] reconnect gave up; will retry on the next request'));
      try {
        await c.connect();
        if (user && password) await c.logon(user, password);
        const status = await c.statusGet();
        if (gen !== connectGeneration) {
          // A newer qsys_connect ran while this one was in flight — yield to it.
          c.close();
          return fail('This connect attempt was superseded by a newer qsys_connect call.');
        }
        client = c;
        lastEngineStatus = status;
        allowLiveWrites = allow_live_writes;
        const liveNote =
          status.IsEmulator === false && !allow_live_writes
            ? 'Target is a LIVE Core: write tools are DISABLED for this connection. Reconnect with allow_live_writes: true (with the user\'s explicit approval) to enable them.'
            : undefined;
        return ok({ connected: true, host, port, ...(liveNote ? { note: liveNote } : {}), status });
      } catch (e) {
        c.close();
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_status',
    {
      title: 'Q-SYS engine status',
      annotations: { readOnlyHint: true },
      description: 'Get the Q-SYS engine status: platform, design name, run state, emulator flag.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await requireClient().statusGet());
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_list_components',
    {
      title: 'List components',
      annotations: { readOnlyHint: true },
      description:
        'List named components in the running/emulated design, with type and properties (Component.GetComponents). On large designs use filter/type/names_only to trim the response. ' +
        'Note: QRC only sees components whose Designer "Script Access" is set to External or All (None is the default) — a component missing here, or one that silently ignores writes, most likely needs its Code Name + Script Access set in Designer.',
      inputSchema: {
        filter: z.string().optional().describe('Case-insensitive substring; only components whose name contains it are returned'),
        type: z.string().optional().describe('Case-insensitive substring on component type (e.g. "gain", "mixer")'),
        names_only: z.boolean().optional().describe('Return only name + type per component (drop properties) to save context'),
      },
    },
    async ({ filter, type, names_only }) => {
      try {
        return ok(shapeComponents(await requireClient().getComponents(), { filter, type, names_only }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_get_component_controls',
    {
      title: 'Get component controls',
      annotations: { readOnlyHint: true },
      description:
        "List a named component's controls and current values (Component.GetControls). Use filter/names_only to trim large components.",
      inputSchema: {
        name: z.string().describe('Component name (as returned by qsys_list_components)'),
        filter: z.string().optional().describe('Case-insensitive substring; only controls whose name contains it are returned'),
        names_only: z.boolean().optional().describe('Return only control names (drop values/positions) to save context'),
      },
    },
    async ({ name, filter, names_only }) => {
      try {
        return ok(shapeControls(await requireClient().getComponentControls(name), { filter, names_only }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_get_control',
    {
      title: 'Get control values',
      annotations: { readOnlyHint: true },
      description: 'Get the current values of one or more Named Controls (Control.Get).',
      inputSchema: { names: z.array(z.string()).min(1).describe('Named Control names') },
    },
    async ({ names }) => {
      try {
        return ok(await requireClient().getControl(names));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_get_component',
    {
      title: 'Get specific component control values',
      annotations: { readOnlyHint: true },
      description: 'Get specific control values within a named component (Component.Get).',
      inputSchema: {
        name: z.string().describe('Component name'),
        controls: z.array(z.string()).min(1).describe('Control names within the component'),
      },
    },
    async ({ name, controls }) => {
      try {
        return ok(await requireClient().getComponent(name, controls));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_set_control',
    {
      title: 'Set a control value',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Set a Named Control value, optionally ramped over a number of seconds (Control.Set). This MUTATES the running/emulated system.',
      inputSchema: {
        name: z.string().describe('Named Control name'),
        value: controlValue.describe('New value (number, string, or boolean)'),
        ramp: z.number().optional().describe('Ramp time in seconds (optional)'),
      },
    },
    async ({ name, value, ramp }) => {
      try {
        assertWritePermitted();
        const result = await requireClient().setControl(name, value, ramp);
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_set_component',
    {
      title: 'Set component control values',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Set one or more control values within a named component, each optionally ramped (Component.Set). This MUTATES the running/emulated system.',
      inputSchema: {
        name: z.string().describe('Component name'),
        controls: z
          .array(
            z.object({
              name: z.string(),
              value: controlValue,
              ramp: z.number().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ name, controls }) => {
      try {
        assertWritePermitted();
        const mapped = controls.map((c) => ({
          Name: c.name,
          Value: c.value,
          ...(c.ramp != null ? { Ramp: c.ramp } : {}),
        }));
        const result = await requireClient().setComponent(name, mapped);
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_load_snapshot',
    {
      title: 'Recall a snapshot',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Recall control settings from a saved snapshot bank/number, optionally ramped over seconds (Snapshot.Load). This MUTATES the running/emulated system.',
      inputSchema: {
        bank: z.string().describe('Snapshot bank name, as named in Q-SYS Designer'),
        number: z.number().int().min(1).describe('Snapshot number within the bank (1-based)'),
        ramp: z.number().optional().describe('Ramp time in seconds (optional)'),
      },
    },
    async ({ bank, number, ramp }) => {
      try {
        assertWritePermitted();
        const result = await requireClient().snapshotLoad(bank, number, ramp);
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_save_snapshot',
    {
      title: 'Save a snapshot',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Capture the current control settings into a snapshot bank/number (Snapshot.Save). This OVERWRITES the stored snapshot.',
      inputSchema: {
        bank: z.string().describe('Snapshot bank name, as named in Q-SYS Designer'),
        number: z.number().int().min(1).describe('Snapshot number within the bank (1-based)'),
      },
    },
    async ({ bank, number }) => {
      try {
        assertWritePermitted();
        const result = await requireClient().snapshotSave(bank, number);
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // ---- Mixer control (Mixer.Set*; write-only — read mixer state back via qsys_get_component) ----

  server.registerTool(
    'qsys_mixer_set_crosspoint',
    {
      title: 'Set mixer crosspoint(s)',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Set gain/delay (number, ramped) or mute/solo (boolean) on the crosspoints of an input×output selection ' +
        '(Mixer.SetCrossPoint{Gain,Delay,Mute,Solo}). This MUTATES the running/emulated system. ' +
        'Read mixer state back via qsys_get_component.',
      inputSchema: {
        name: z.string().describe('Mixer component name'),
        inputs: z.string().describe(`Input selector — ${mixerSelectorHint}`),
        outputs: z.string().describe(`Output selector — ${mixerSelectorHint}`),
        op: z.enum(['gain', 'delay', 'mute', 'solo']).describe('Which crosspoint property to set'),
        value: mixerValue.describe('Number (dB/seconds) for gain/delay; boolean for mute/solo'),
        ramp: z.number().optional().describe('Ramp time in seconds — gain/delay only, ignored otherwise'),
      },
    },
    async ({ name, inputs, outputs, op, value, ramp }) => {
      try {
        guardMixerValue(op, value);
        assertWritePermitted();
        const c = requireClient();
        let result: unknown;
        switch (op) {
          case 'gain': result = await c.mixerSetCrossPointGain(name, inputs, outputs, value as number, ramp); break;
          case 'delay': result = await c.mixerSetCrossPointDelay(name, inputs, outputs, value as number, ramp); break;
          case 'mute': result = await c.mixerSetCrossPointMute(name, inputs, outputs, value as boolean); break;
          case 'solo': result = await c.mixerSetCrossPointSolo(name, inputs, outputs, value as boolean); break;
        }
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_mixer_set_input',
    {
      title: 'Set mixer input(s)',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Set gain (number, ramped) or mute/solo (boolean) on selected mixer inputs ' +
        '(Mixer.SetInput{Gain,Mute,Solo}). This MUTATES the running/emulated system. ' +
        'Read mixer state back via qsys_get_component.',
      inputSchema: {
        name: z.string().describe('Mixer component name'),
        inputs: z.string().describe(`Input selector — ${mixerSelectorHint}`),
        op: z.enum(['gain', 'mute', 'solo']).describe('Which input property to set'),
        value: mixerValue.describe('Number (dB) for gain; boolean for mute/solo'),
        ramp: z.number().optional().describe('Ramp time in seconds — gain only, ignored otherwise'),
      },
    },
    async ({ name, inputs, op, value, ramp }) => {
      try {
        guardMixerValue(op, value);
        assertWritePermitted();
        const c = requireClient();
        let result: unknown;
        switch (op) {
          case 'gain': result = await c.mixerSetInputGain(name, inputs, value as number, ramp); break;
          case 'mute': result = await c.mixerSetInputMute(name, inputs, value as boolean); break;
          case 'solo': result = await c.mixerSetInputSolo(name, inputs, value as boolean); break;
        }
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_mixer_set_output',
    {
      title: 'Set mixer output(s)',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Set gain (number, ramped) or mute (boolean) on selected mixer outputs ' +
        '(Mixer.SetOutput{Gain,Mute}). This MUTATES the running/emulated system. ' +
        'Read mixer state back via qsys_get_component.',
      inputSchema: {
        name: z.string().describe('Mixer component name'),
        outputs: z.string().describe(`Output selector — ${mixerSelectorHint}`),
        op: z.enum(['gain', 'mute']).describe('Which output property to set'),
        value: mixerValue.describe('Number (dB) for gain; boolean for mute'),
        ramp: z.number().optional().describe('Ramp time in seconds — gain only, ignored otherwise'),
      },
    },
    async ({ name, outputs, op, value, ramp }) => {
      try {
        guardMixerValue(op, value);
        assertWritePermitted();
        const c = requireClient();
        let result: unknown;
        switch (op) {
          case 'gain': result = await c.mixerSetOutputGain(name, outputs, value as number, ramp); break;
          case 'mute': result = await c.mixerSetOutputMute(name, outputs, value as boolean); break;
        }
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_mixer_set_cue',
    {
      title: 'Set mixer cue(s)',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Set gain (number, ramped) or mute (boolean) on selected mixer cues ' +
        '(Mixer.SetCue{Gain,Mute}). This MUTATES the running/emulated system. ' +
        'Read mixer state back via qsys_get_component.',
      inputSchema: {
        name: z.string().describe('Mixer component name'),
        cues: z.string().describe('Cue selector (string specification of mixer cues)'),
        op: z.enum(['gain', 'mute']).describe('Which cue property to set'),
        value: mixerValue.describe('Number (dB) for gain; boolean for mute'),
        ramp: z.number().optional().describe('Ramp time in seconds — gain only, ignored otherwise'),
      },
    },
    async ({ name, cues, op, value, ramp }) => {
      try {
        guardMixerValue(op, value);
        assertWritePermitted();
        const c = requireClient();
        let result: unknown;
        switch (op) {
          case 'gain': result = await c.mixerSetCueGain(name, cues, value as number, ramp); break;
          case 'mute': result = await c.mixerSetCueMute(name, cues, value as boolean); break;
        }
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_mixer_set_cue_input',
    {
      title: 'Route/monitor input(s) to cue(s)',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Enable an input on a cue, or set its AFL (after-fade listen) flag (boolean) ' +
        '(Mixer.SetInputCue{Enable,Afl}). This MUTATES the running/emulated system. ' +
        'Read mixer state back via qsys_get_component.',
      inputSchema: {
        name: z.string().describe('Mixer component name'),
        cues: z.string().describe('Cue selector (string specification of mixer cues)'),
        inputs: z.string().describe(`Input selector — ${mixerSelectorHint}`),
        op: z.enum(['enable', 'afl']).describe('Set cue-input enable, or AFL monitoring'),
        value: mixerValue.describe('Boolean'),
      },
    },
    async ({ name, cues, inputs, op, value }) => {
      try {
        guardMixerValue(op, value);
        assertWritePermitted();
        const c = requireClient();
        let result: unknown;
        switch (op) {
          case 'enable': result = await c.mixerSetInputCueEnable(name, cues, inputs, value as boolean); break;
          case 'afl': result = await c.mixerSetInputCueAfl(name, cues, inputs, value as boolean); break;
        }
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // ---- Loop Player control (LoopPlayer.{Start,Stop,Cancel}; write-only — read per-output
  // state back via qsys_get_component). Outputs are integer lists, NOT Mixer String Syntax. ----

  server.registerTool(
    'qsys_loop_player_start',
    {
      title: 'Start Loop Player playback',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Schedule one or more audio files to play on a Loop Player component (LoopPlayer.Start). ' +
        'This MUTATES the running/emulated system. There is no QRC method to browse Core files — ' +
        'pass a file path you already know. Read Loop Player state back via qsys_get_component.',
      inputSchema: {
        name: z.string().describe('Loop Player component name (its "Code Name")'),
        files: z
          .array(
            z.object({
              name: z.string().describe('Path + filename of the file on the Core (e.g. "Audio/mainloop.wav")'),
              output: z.number().int().describe('Output track number to play on'),
            }),
          )
          .min(1)
          .describe('One file→output assignment per entry (a Files entry carries only name + output; the options below apply to the whole job)'),
        startTime: z
          .number()
          .optional()
          .describe('-1 = now, -2 = queue after current, ≥0 = absolute time-of-day (s). Omitted → Core default (0). With Time source "None", 0 plays now and >0 has no effect.'),
        loop: z.boolean().optional().describe('Loop playback continuously (default false)'),
        seek: z.number().optional().describe('Offset into the file to start playback, in seconds (default 0)'),
        log: z.boolean().optional().describe('Log start + errors to the Core event log (default false)'),
        refId: z
          .string()
          .optional()
          .describe('If set, the Core logs an async failure notification for this job (the notification is not surfaced by these tools yet)'),
      },
    },
    async ({ name, files, startTime, loop, seek, log, refId }) => {
      try {
        assertWritePermitted();
        const result = await requireClient().loopPlayerStart({ name, files, startTime, loop, seek, log, refId });
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_loop_player_stop_cancel',
    {
      title: 'Stop or cancel Loop Player playback',
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Stop current playback on outputs (op "stop"), or cancel a pending/queued future-start job ' +
        'without disrupting current playback (op "cancel") — LoopPlayer.Stop / LoopPlayer.Cancel. ' +
        'Outputs is a list of integer output numbers (e.g. [1, 2]). This MUTATES the running/emulated system.',
      inputSchema: {
        name: z.string().describe('Loop Player component name (its "Code Name")'),
        op: z.enum(['stop', 'cancel']).describe('"stop" halts current playback; "cancel" aborts a queued future-start job'),
        outputs: z.array(z.number().int()).min(1).describe('Output track numbers as an integer list, e.g. [1, 2]'),
        log: z.boolean().optional().describe('Log the stop/cancel to the Core event log (default false)'),
      },
    },
    async ({ name, op, outputs, log }) => {
      try {
        assertWritePermitted();
        const c = requireClient();
        const result = op === 'stop'
          ? await c.loopPlayerStop(name, outputs, log)
          : await c.loopPlayerCancel(name, outputs, log);
        const warning = liveCoreWarning();
        return ok(warning ? { warning, result } : result);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_create_change_group',
    {
      title: 'Create or extend a change group',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Create a change group (or add Named Controls to an existing one) so you can poll for changes (ChangeGroup.AddControl).',
      inputSchema: {
        id: z.string().describe('Change group id (any string; reused on poll)'),
        controls: z.array(z.string()).min(1).describe('Named Control names to watch'),
      },
    },
    async ({ id, controls }) => {
      try {
        return ok(await requireClient().changeGroupAddControl(id, controls));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_poll_change_group',
    {
      title: 'Poll a change group',
      annotations: { readOnlyHint: true },
      description: 'Poll a change group; returns the controls that changed since the last poll (ChangeGroup.Poll).',
      inputSchema: { id: z.string().describe('Change group id') },
    },
    async ({ id }) => {
      try {
        return ok(await requireClient().changeGroupPoll(id));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_change_group_add_component',
    {
      title: 'Add component controls to a change group',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        "Add a named component's controls to a change group so you can poll them for changes (ChangeGroup.AddComponentControl).",
      inputSchema: {
        id: z.string().describe('Change group id (any string; reused on poll)'),
        component: z.string().describe('Component name'),
        controls: z.array(z.string()).min(1).describe('Control names within the component to watch'),
      },
    },
    async ({ id, component, controls }) => {
      try {
        return ok(await requireClient().changeGroupAddComponentControl(id, component, controls));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_destroy_change_group',
    {
      title: 'Destroy a change group',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Destroy a change group, freeing its server-side state (ChangeGroup.Destroy).',
      inputSchema: { id: z.string().describe('Change group id') },
    },
    async ({ id }) => {
      try {
        return ok(await requireClient().changeGroupDestroy(id));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_change_group_remove',
    {
      title: 'Remove controls from a change group',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Remove Named Controls from a change group, leaving the group in place (ChangeGroup.Remove). Returns any unknown control names.',
      inputSchema: {
        id: z.string().describe('Change group id'),
        controls: z.array(z.string()).min(1).describe('Named Control names to stop watching'),
      },
    },
    async ({ id, controls }) => {
      try {
        return ok(await requireClient().changeGroupRemove(id, controls));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_change_group_clear',
    {
      title: 'Clear a change group',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Remove all controls from a change group without destroying it (ChangeGroup.Clear).',
      inputSchema: { id: z.string().describe('Change group id') },
    },
    async ({ id }) => {
      try {
        return ok(await requireClient().changeGroupClear(id));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'qsys_change_group_invalidate',
    {
      title: 'Invalidate a change group',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Invalidate a change group so the next poll resends every watched control, not just the changes (ChangeGroup.Invalidate). Handy after a reconnect to force a full snapshot.',
      inputSchema: { id: z.string().describe('Change group id') },
    },
    async ({ id }) => {
      try {
        return ok(await requireClient().changeGroupInvalidate(id));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // ChangeGroup.AutoPoll is intentionally omitted: MCP stdio is request/response,
  // so a Core-pushed poll has nowhere to land; manual qsys_poll_change_group covers it.
  server.registerTool(
    'qsys_disconnect',
    {
      title: 'Disconnect from Q-SYS',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Close the QRC connection to the Core/emulator. A later qsys_connect is required before other tools.',
      inputSchema: {},
    },
    async () => {
      if (client) {
        client.close();
        client = null;
        lastEngineStatus = null;
      }
      allowLiveWrites = false;
      return ok({ disconnected: true });
    },
  );

  return server;
}
