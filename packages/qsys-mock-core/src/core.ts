/**
 * MockCore — the metadata-aware QRC engine. Loads a Design and answers the QRC
 * control-plane method set (status, controls, components, change groups, snapshots)
 * exactly like a real Core / Designer Emulate session, clamping/coercing sets to
 * each control's type+range and replying through design.ts's `render()` so the
 * {Value, String, Position} triple never drifts between paths.
 *
 * Deliberately minimal vs. a full emulator: sets apply immediately (no ramp
 * interpolation) and meters are static (no tick loop) — that fidelity lives in the
 * fuller (private) emulator. Pure logic, no transport: `handleRequest` takes
 * reply/error callbacks so the socket layer (server.ts) lives elsewhere.
 */
import type { EngineStatus, QrcControl, ControlValue } from 'qsys-qrc';
import {
  type Design, type ControlDef, type ComponentDef,
  render, coerce, defaultValue, rangeOf,
} from './design.js';

export interface CoreOptions {
  /** Reject Control.Set / Component.Set / Get on controls the design doesn't declare. Default false. */
  strict?: boolean;
  /** Value of EngineStatus.IsEmulator (drives the MCP "live Core" warning). Default true. */
  isEmulator?: boolean;
}

export interface QrcRequest {
  method: string;
  params?: any;
  id?: number | string;
}

export type Reply = (result: unknown) => void;
export type ErrorReply = (code: number, message: string) => void;

interface ChangeGroup {
  controls: Set<string>;
  componentControls: Array<{ component: string; control: string }>;
  lastSent: Map<string, ControlValue>;
}

const ERR_INVALID_PARAMS = -32602;
const ERR_METHOD_NOT_FOUND = -32601;

export class MockCore {
  private readonly strict: boolean;
  private readonly status: EngineStatus;

  /** Named-control name → def, and current value. */
  private readonly namedDef = new Map<string, ControlDef>();
  private readonly namedVal = new Map<string, ControlValue>();
  /** Component name → (def, and control name → def / value). */
  private readonly compDef = new Map<string, ComponentDef>();
  private readonly compCtrlDef = new Map<string, Map<string, ControlDef>>();
  private readonly compVal = new Map<string, Map<string, ControlValue>>();

  private readonly changeGroups = new Map<string, ChangeGroup>();
  /** bank → number → controlKey → value. controlKey: named name or "Component/control". */
  private readonly snapshots = new Map<string, Map<string, Map<string, ControlValue>>>();

  private logons = 0;
  private snapLoadParams: unknown = null;
  private snapSaveParams: unknown = null;
  /** Last Mixer.Set* call — recorded (not applied): wire-proof only, no grid fidelity here. */
  private mixerCall: { method: string; params: unknown } | null = null;

  constructor(private readonly design: Design, opts: CoreOptions = {}) {
    this.strict = opts.strict ?? false;
    this.status = {
      Platform: design.design.platform,
      State: 'Active',
      DesignName: design.design.name,
      DesignCode: design.design.code,
      IsRedundant: false,
      IsEmulator: opts.isEmulator ?? true,
      Status: { Code: 0, String: 'OK' },
    };

    for (const def of design.namedControls) {
      this.namedDef.set(def.name, def);
      this.namedVal.set(def.name, defaultValue(def));
    }
    for (const comp of design.components) {
      this.compDef.set(comp.name, comp);
      const defs = new Map<string, ControlDef>();
      const vals = new Map<string, ControlValue>();
      for (const c of comp.controls) {
        defs.set(c.name, c);
        vals.set(c.name, defaultValue(c));
      }
      this.compCtrlDef.set(comp.name, defs);
      this.compVal.set(comp.name, vals);
    }
    for (const [bank, slots] of Object.entries(design.snapshots ?? {})) {
      const b = new Map<string, Map<string, ControlValue>>();
      for (const [num, values] of Object.entries(slots)) {
        b.set(num, new Map(Object.entries(values)));
      }
      this.snapshots.set(bank, b);
    }
  }

  /** EngineStatus payload — server sends this on connect and as the StatusGet reply. */
  engineStatus(): EngineStatus {
    return { ...this.status };
  }

  logonCount(): number {
    return this.logons;
  }
  lastSnapshotLoad(): unknown {
    return this.snapLoadParams;
  }
  lastSnapshotSave(): unknown {
    return this.snapSaveParams;
  }
  /** The last Mixer.Set* call this core acked ({ method, params }), or null if none. */
  lastMixerCall(): { method: string; params: unknown } | null {
    return this.mixerCall;
  }
  /** Simulate a Core restart losing its change groups. */
  resetChangeGroups(): void {
    this.changeGroups.clear();
  }

  /**
   * Poll a change group by id, returning the delta since its last poll (or undefined
   * if the group doesn't exist). Public so the server's AutoPoll loop can push the
   * same deltas as unsolicited notifications. Advances the group's lastSent.
   */
  pollGroup(id: string): { Id: string; Changes: QrcControl[] } | undefined {
    const g = this.changeGroups.get(id);
    if (!g) return undefined;
    return { Id: id, Changes: this.pollChanges(g) };
  }

  handleRequest(msg: QrcRequest, reply: Reply, error: ErrorReply): void {
    switch (msg.method) {
      case 'NoOp':
        return;
      case 'Logon':
        this.logons++;
        return reply({});
      case 'StatusGet':
        return reply(this.engineStatus());

      case 'Component.GetComponents':
        return reply(this.design.components.map((c) => ({
          ID: c.name, Name: c.name, Type: c.type, Properties: [],
        })));

      case 'Component.GetControls': {
        const name = msg.params?.Name;
        const defs = this.compCtrlDef.get(name);
        const vals = this.compVal.get(name);
        if (!defs || !vals) return error(ERR_INVALID_PARAMS, `Unknown component: ${name}`);
        return reply({
          Name: name,
          Controls: [...defs.values()].map((d) => {
            const [min, max] = rangeOf(d);
            return { ...render(d, vals.get(d.name)!), ValueMin: min, ValueMax: max };
          }),
        });
      }

      case 'Component.Get': {
        const name = msg.params?.Name;
        const defs = this.compCtrlDef.get(name);
        const vals = this.compVal.get(name);
        if (!defs || !vals) return error(ERR_INVALID_PARAMS, `Unknown component: ${name}`);
        const requested: string[] = (msg.params?.Controls ?? []).map((c: any) => c.Name);
        return reply({
          Name: name,
          Controls: requested.map((n) => {
            const d = defs.get(n);
            if (!d) return { Name: n, Value: 0, String: '0', Position: 0 };
            return render(d, vals.get(n)!);
          }),
        });
      }

      case 'Component.Set': {
        const name = msg.params?.Name;
        const defs = this.compCtrlDef.get(name);
        const vals = this.compVal.get(name);
        if (!defs || !vals) return error(ERR_INVALID_PARAMS, `Unknown component: ${name}`);
        for (const c of msg.params?.Controls ?? []) {
          const d = defs.get(c.Name);
          if (!d) {
            if (this.strict) return error(ERR_INVALID_PARAMS, `Unknown control: ${name}.${c.Name}`);
            continue;
          }
          vals.set(d.name, coerce(d, c.Value));
        }
        return reply(null);
      }

      case 'Control.Get': {
        const names: string[] = msg.params ?? [];
        return reply(names.map((n) => {
          const d = this.namedDef.get(n);
          if (!d) return { Name: n, Value: 0, String: '0', Position: 0 };
          return render(d, this.namedVal.get(n)!);
        }));
      }

      case 'Control.Set': {
        const name = msg.params?.Name;
        const d = this.namedDef.get(name);
        if (!d) {
          if (this.strict) return error(ERR_INVALID_PARAMS, `Unknown control: ${name}`);
          return reply(null);
        }
        this.namedVal.set(name, coerce(d, msg.params?.Value));
        return reply(null);
      }

      case 'ChangeGroup.AddControl': {
        const g = this.group(msg.params.Id);
        for (const c of msg.params.Controls ?? []) g.controls.add(c);
        return reply(null);
      }
      case 'ChangeGroup.AddComponentControl': {
        const g = this.group(msg.params.Id);
        const component = msg.params.Component?.Name;
        for (const c of msg.params.Component?.Controls ?? []) {
          g.componentControls.push({ component, control: c.Name });
        }
        return reply(null);
      }
      case 'ChangeGroup.Remove': {
        const g = this.changeGroups.get(msg.params.Id);
        if (!g) return error(ERR_INVALID_PARAMS, `Unknown change group: ${msg.params.Id}`);
        for (const c of msg.params.Controls ?? []) {
          g.controls.delete(c);
          g.lastSent.delete(c);
        }
        return reply(null);
      }
      case 'ChangeGroup.Clear': {
        const g = this.changeGroups.get(msg.params.Id);
        if (!g) return error(ERR_INVALID_PARAMS, `Unknown change group: ${msg.params.Id}`);
        g.controls.clear();
        g.componentControls = [];
        g.lastSent.clear();
        return reply(null);
      }
      case 'ChangeGroup.Invalidate': {
        const g = this.changeGroups.get(msg.params.Id);
        if (!g) return error(ERR_INVALID_PARAMS, `Unknown change group: ${msg.params.Id}`);
        g.lastSent.clear(); // force the next poll to resend everything
        return reply(null);
      }
      case 'ChangeGroup.Destroy':
        this.changeGroups.delete(msg.params.Id);
        return reply(null);
      case 'ChangeGroup.Poll': {
        const res = this.pollGroup(msg.params.Id);
        if (!res) return error(ERR_INVALID_PARAMS, `Unknown change group: ${msg.params.Id}`);
        return reply(res);
      }

      case 'Snapshot.Load':
        this.snapLoadParams = msg.params;
        this.loadSnapshot(msg.params?.Name, String(msg.params?.Bank));
        return reply(null);
      case 'Snapshot.Save':
        this.snapSaveParams = msg.params;
        this.saveSnapshot(msg.params?.Name, String(msg.params?.Bank));
        return reply(null);

      // Mixer.Set* — deliberately thin: record the wire call + ack, no crosspoint-grid
      // state, no selector expansion, no readback. That fidelity is the private moat.
      case 'Mixer.SetCrossPointGain':
      case 'Mixer.SetCrossPointDelay':
      case 'Mixer.SetCrossPointMute':
      case 'Mixer.SetCrossPointSolo':
      case 'Mixer.SetInputGain':
      case 'Mixer.SetInputMute':
      case 'Mixer.SetInputSolo':
      case 'Mixer.SetOutputGain':
      case 'Mixer.SetOutputMute':
      case 'Mixer.SetCueGain':
      case 'Mixer.SetCueMute':
      case 'Mixer.SetInputCueEnable':
      case 'Mixer.SetInputCueAfl':
        this.mixerCall = { method: msg.method, params: msg.params };
        return reply(null);

      default:
        return error(ERR_METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    }
  }

  // ---- internals ----

  private group(id: string): ChangeGroup {
    let g = this.changeGroups.get(id);
    if (!g) {
      g = { controls: new Set(), componentControls: [], lastSent: new Map() };
      this.changeGroups.set(id, g);
    }
    return g;
  }

  /** Controls whose value changed since the group's last poll, rendered for the wire. */
  private pollChanges(g: ChangeGroup): QrcControl[] {
    const out: QrcControl[] = [];
    for (const n of g.controls) {
      const d = this.namedDef.get(n);
      const v = this.namedVal.get(n) ?? 0;
      if (g.lastSent.get(n) !== v) {
        out.push(d ? render(d, v) : { Name: n, Value: v, String: String(v), Position: 0 });
        g.lastSent.set(n, v);
      }
    }
    for (const { component, control } of g.componentControls) {
      const key = `${component}/${control}`;
      const d = this.compCtrlDef.get(component)?.get(control);
      const v = this.compVal.get(component)?.get(control) ?? 0;
      if (g.lastSent.get(key) !== v) {
        out.push(d ? render(d, v) : { Name: control, Value: v, String: String(v), Position: 0 });
        g.lastSent.set(key, v);
      }
    }
    return out;
  }

  private saveSnapshot(bank: string, num: string): void {
    if (!bank) return;
    const snap = new Map<string, ControlValue>();
    for (const [n, v] of this.namedVal) snap.set(n, v);
    for (const [comp, vals] of this.compVal) {
      for (const [c, v] of vals) snap.set(`${comp}/${c}`, v);
    }
    let b = this.snapshots.get(bank);
    if (!b) {
      b = new Map();
      this.snapshots.set(bank, b);
    }
    b.set(num, snap);
  }

  private loadSnapshot(bank: string, num: string): void {
    const snap = this.snapshots.get(bank)?.get(num);
    if (!snap) return;
    for (const [key, value] of snap) {
      const slash = key.indexOf('/');
      if (slash === -1) {
        const d = this.namedDef.get(key);
        if (d) this.namedVal.set(key, coerce(d, value));
      } else {
        const comp = key.slice(0, slash);
        const ctrl = key.slice(slash + 1);
        const d = this.compCtrlDef.get(comp)?.get(ctrl);
        const vals = this.compVal.get(comp);
        if (d && vals) vals.set(ctrl, coerce(d, value));
      }
    }
  }
}
