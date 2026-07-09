#!/usr/bin/env node
/**
 * qsys — control a running Q-SYS Core (or Q-SYS Designer's Emulate mode) over QRC from the
 * shell. The human/scriptable sibling of qsys-mcp, over the same QrcClient.
 *
 *   qsys status --host 192.168.1.10
 *   qsys set MainGain -6 --ramp 2
 *   qsys watch MainGain --interval 0.2
 *
 * The published bin is the compiled dist/bin.js; in the workspace, run it
 * via `npm -w qsys run qsys` (tsx) instead of executing this file directly.
 */
import { runCli } from './cli.js';

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());
process.on('SIGTERM', () => abort.abort());

runCli(process.argv.slice(2), {
  out: console.log,
  err: console.error,
  signal: abort.signal,
}).then(
  (code) => process.exit(code),
  (err) => {
    console.error('qsys: fatal:', err);
    process.exit(1);
  },
);
