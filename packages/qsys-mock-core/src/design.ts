/**
 * Design model for qsys-mock-core — the in-memory shape the mock serves over QRC.
 * A "design" is the set of named controls + named components (each with its own
 * controls), their types, ranges, defaults, and snapshots. Designs are supplied by
 * the caller (tests hand-author small literals); this package ships none.
 *
 * `QrcControl` / `ControlValue` are reused from the QRC client so the wire shape
 * can't drift between the client and this mock.
 */
import type { QrcControl, ControlValue } from 'qsys-qrc';

export type { ControlValue };

/**
 * The mock-side control type. Drives coercion, range defaults, and how `render()`
 * builds the QRC {Value, String, Position} triple.
 *  - gain     numeric, dB-formatted String, linear Position over [min,max]
 *  - mute     boolean (0/1), the family of latching on/off controls
 *  - trigger  boolean momentary (a button); same wire shape as mute
 *  - float    numeric, no unit formatting
 *  - integer  numeric, rounded
 *  - string   passthrough text (e.g. a script's `code`, a label)
 *  - meter    read-only numeric (static here — the fuller emulator animates it)
 */
export type ControlType = 'gain' | 'mute' | 'trigger' | 'float' | 'integer' | 'string' | 'meter';

export interface ControlDef {
  name: string;
  type: ControlType;
  /** Inclusive value range. Omitted → DEFAULT_RANGE[type]. */
  min?: number;
  max?: number;
  /** Initial value. Omitted → min for numerics, false for boolean, '' for string. */
  value?: ControlValue;
  /** Display unit; 'dB' switches String formatting to "-6.0dB". */
  units?: string;
  /** Read-only controls a fuller emulator may animate (this mock leaves them static). */
  live?: 'meter' | 'signal';
}

export interface ComponentDef {
  /** Named-component name as addressed by Component.* (Q-SYS `_ClassName` instance label). */
  name: string;
  /** Component class (`gain`, `mixer`, `equalizer_parametric`, …) — surfaced in Component.GetComponents. */
  type: string;
  controls: ControlDef[];
}

export interface DesignMeta {
  name: string;
  code: string;
  platform: string;
}

export interface Design {
  design: DesignMeta;
  namedControls: ControlDef[];
  components: ComponentDef[];
  /** bank → snapshot-number → { controlKey: value }. controlKey is a named control or "Component/control". */
  snapshots?: Record<string, Record<string, Record<string, ControlValue>>>;
}

/**
 * Default [min, max] per control type. A hand-authored ControlDef may override via
 * min/max. Gain bounds match Q-SYS's standard fader (-100 dB .. +20 dB).
 */
export const DEFAULT_RANGE: Record<ControlType, [number, number]> = {
  gain: [-100, 20],
  mute: [0, 1],
  trigger: [0, 1],
  float: [0, 1],
  integer: [0, 100],
  string: [0, 1],
  meter: [-100, 20],
};

const BOOLEAN_TYPES: ReadonlySet<ControlType> = new Set<ControlType>(['mute', 'trigger']);

export function isBooleanType(type: ControlType): boolean {
  return BOOLEAN_TYPES.has(type);
}

/** A control's effective [min, max]: explicit bounds win, else the type default. */
export function rangeOf(def: ControlDef): [number, number] {
  const [dmin, dmax] = DEFAULT_RANGE[def.type];
  return [def.min ?? dmin, def.max ?? dmax];
}

/** The starting value for a control if its def omits `value`. */
export function defaultValue(def: ControlDef): ControlValue {
  if (def.value !== undefined) return def.value;
  if (isBooleanType(def.type)) return false;
  if (def.type === 'string') return '';
  return rangeOf(def)[0];
}

/**
 * Coerce an inbound Control.Set/Component.Set value to the control's type and
 * clamp numerics to range. Booleans accept 0/1, "0"/"1", "true"/"false".
 */
export function coerce(def: ControlDef, raw: ControlValue): ControlValue {
  if (isBooleanType(def.type)) {
    return raw === true || raw === 1 || raw === '1' || raw === 'true';
  }
  if (def.type === 'string') return String(raw);
  const [min, max] = rangeOf(def);
  let n = Number(raw);
  if (!Number.isFinite(n)) n = min;
  if (def.type === 'integer') n = Math.round(n);
  return Math.min(max, Math.max(min, n));
}

/**
 * value + def → the {Name, Value, String, Position} triple QRC returns. The single
 * source of truth for every reply path (Control.Get, Component.Get/GetControls,
 * ChangeGroup.Poll), so the wire shape can't drift between them.
 */
export function render(def: ControlDef, value: ControlValue): QrcControl {
  if (isBooleanType(def.type)) {
    const on = value === true || value === 1;
    return { Name: def.name, Value: on ? 1 : 0, String: on ? 'true' : 'false', Position: on ? 1 : 0 };
  }
  if (def.type === 'string') {
    return { Name: def.name, Value: String(value), String: String(value), Position: 0 };
  }
  const n = Number(value);
  const [min, max] = rangeOf(def);
  const position = max > min ? Math.min(1, Math.max(0, (n - min) / (max - min))) : 0;
  let str: string;
  if (def.units === 'dB') str = `${n.toFixed(1)}dB`;
  else if (def.type === 'integer') str = String(Math.round(n));
  else str = String(n);
  return { Name: def.name, Value: n, String: str, Position: position };
}

// ---- validation ----

const CONTROL_TYPES: ReadonlySet<string> = new Set<ControlType>([
  'gain', 'mute', 'trigger', 'float', 'integer', 'string', 'meter',
]);

export class DesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignError';
  }
}

/** Validate an already-parsed object into a Design, throwing DesignError on any structural fault. */
export function parseDesign(data: unknown): Design {
  if (!isRecord(data)) throw new DesignError('design must be a JSON object');

  const meta = data.design;
  if (!isRecord(meta) || typeof meta.name !== 'string') {
    throw new DesignError('design.design.name is required');
  }
  const design: DesignMeta = {
    name: meta.name,
    code: typeof meta.code === 'string' ? meta.code : 'emu',
    platform: typeof meta.platform === 'string' ? meta.platform : 'Emulator',
  };

  const namedControls = parseControls(data.namedControls, 'namedControls');
  assertUnique(namedControls.map((c) => c.name), 'named control');

  const componentsRaw = data.components ?? [];
  if (!Array.isArray(componentsRaw)) throw new DesignError('components must be an array');
  const components: ComponentDef[] = componentsRaw.map((c, i) => {
    if (!isRecord(c) || typeof c.name !== 'string') {
      throw new DesignError(`components[${i}].name is required`);
    }
    const controls = parseControls(c.controls, `components.${c.name}.controls`);
    assertUnique(controls.map((x) => x.name), `control in component "${c.name}"`);
    return { name: c.name, type: typeof c.type === 'string' ? c.type : 'unknown', controls };
  });
  assertUnique(components.map((c) => c.name), 'component');

  const snapshots = data.snapshots;
  if (snapshots !== undefined && !isRecord(snapshots)) {
    throw new DesignError('snapshots must be an object');
  }

  const out: Design = { design, namedControls, components };
  if (isRecord(snapshots)) {
    validateSnapshotKeys(snapshots, namedControls, components);
    out.snapshots = snapshots as Design['snapshots'];
  }
  return out;
}

function parseControls(raw: unknown, where: string): ControlDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new DesignError(`${where} must be an array`);
  return raw.map((c, i) => {
    if (!isRecord(c) || typeof c.name !== 'string') {
      throw new DesignError(`${where}[${i}].name is required`);
    }
    if (typeof c.type !== 'string' || !CONTROL_TYPES.has(c.type)) {
      throw new DesignError(`${where}[${i}] ("${c.name}") has invalid type ${JSON.stringify(c.type)}`);
    }
    const def: ControlDef = { name: c.name, type: c.type as ControlType };
    if (c.min !== undefined) def.min = asNumber(c.min, `${where}.${c.name}.min`);
    if (c.max !== undefined) def.max = asNumber(c.max, `${where}.${c.name}.max`);
    if (def.min !== undefined && def.max !== undefined && def.min >= def.max) {
      throw new DesignError(`${where}.${c.name}: min (${def.min}) must be < max (${def.max})`);
    }
    if (c.value !== undefined) def.value = c.value as ControlValue;
    if (typeof c.units === 'string') def.units = c.units;
    if (c.live === 'meter' || c.live === 'signal') def.live = c.live;
    return def;
  });
}

function validateSnapshotKeys(
  snapshots: Record<string, unknown>,
  namedControls: ControlDef[],
  components: ComponentDef[],
): void {
  const known = new Set<string>(namedControls.map((c) => c.name));
  for (const comp of components) {
    for (const ctrl of comp.controls) known.add(`${comp.name}/${ctrl.name}`);
  }
  for (const [bank, slots] of Object.entries(snapshots)) {
    if (!isRecord(slots)) throw new DesignError(`snapshots.${bank} must be an object`);
    for (const [slot, values] of Object.entries(slots)) {
      if (!isRecord(values)) throw new DesignError(`snapshots.${bank}.${slot} must be an object`);
      for (const key of Object.keys(values)) {
        if (!known.has(key)) {
          throw new DesignError(`snapshots.${bank}.${slot} references unknown control "${key}"`);
        }
      }
    }
  }
}

function assertUnique(names: string[], what: string): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new DesignError(`duplicate ${what} name: "${n}"`);
    seen.add(n);
  }
}

function asNumber(v: unknown, where: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DesignError(`${where} must be a finite number`);
  return n;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
