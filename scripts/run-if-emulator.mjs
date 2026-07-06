#!/usr/bin/env node
/**
 * Gate a test command on the private qsys-emulator package being installed.
 * The emulator-backed e2e suites need it; public checkouts don't have it, so
 * they skip instead of failing. Enable locally with:
 *
 *   npm i --no-save ../qsys-emulator     # from the repo root, sibling checkout
 *
 * Usage (from a package script): node ../../scripts/run-if-emulator.mjs "<shell command>"
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
try {
  require.resolve('qsys-emulator');
} catch {
  console.log('skip: e2e suite needs the private qsys-emulator package (npm i --no-save ../qsys-emulator from the repo root)');
  process.exit(0);
}

const cmd = process.argv.slice(2).join(' ');
const res = spawnSync(cmd, { stdio: 'inherit', shell: true });
process.exit(res.status ?? 1);
