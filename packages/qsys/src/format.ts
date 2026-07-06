import type { ControlValue, QrcControl } from 'qsys-qrc';

/** A poll/get row; change-group polls tag component controls with their owner. */
export type ControlRow = QrcControl & { Component?: string };

export const CONTROL_HEADER = ['NAME', 'VALUE', 'STRING', 'POSITION'];

export function controlRow(c: ControlRow): string[] {
  return [
    c.Component ? `${c.Component}.${c.Name}` : c.Name,
    fmtValue(c.Value),
    c.String ?? '',
    c.Position == null ? '' : c.Position.toFixed(3),
  ];
}

export function fmtValue(v: ControlValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'number' && !Number.isInteger(v)) {
    return String(Number(v.toFixed(4)));
  }
  return String(v);
}

/** Right-pad cells so columns align. No wrapping — terminals scroll. */
export function renderTable(header: string[], rows: string[][]): string {
  const all = header.length > 0 ? [header, ...rows] : rows;
  const cols = Math.max(...all.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths.push(Math.max(...all.map((r) => (r[c] ?? '').length)));
  }
  return all
    .map((r) => r.map((cell, c) => (cell ?? '').padEnd(widths[c])).join('  ').trimEnd())
    .join('\n');
}

/** Two-column key/value block (status output). */
export function renderKv(pairs: Array<[string, string]>): string {
  return renderTable([], pairs.map(([k, v]) => [k, v]));
}

/**
 * CLI arg → QRC control value: `true`/`false` → boolean, numeric → number,
 * anything else stays a string (e.g. a combo-box item name).
 */
export function coerceValue(raw: string): ControlValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(n)) return n;
  return raw;
}
