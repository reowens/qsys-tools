import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('packed npm consumer has its recipe, helpers, and fonts without a sibling checkout', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'qsys-linux-consumer-'));
  try {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8' }))[0];
    const names = packed.files.map(f => f.path);
    assert.ok(names.includes('lib/support/assemble-msi.py'));
    assert.ok(names.includes('lib/support/fonts/LICENSE.txt'));
    assert.equal(names.filter(n => n.endsWith('.ttf')).length, 5);
    assert.ok(names.every(n => !/\.(?:exe|dll|qsys|deb|pyc)$/.test(n)), 'package must not contain proprietary payloads, runtimes, or generated Python bytecode');
    const consumer = path.join(temporary, 'consumer with spaces');
    mkdirSync(consumer);
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed.filename)], { cwd: consumer });
    const installed = path.join(consumer, 'node_modules/qsys-linux');
    const help = execFileSync(process.execPath, [path.join(installed, 'bin/qsys-linux.mjs'), '--help'], { cwd: consumer, encoding: 'utf8' });
    assert.match(help, /install,launch,scale,remove,status,doctor/);
    execFileSync('python3', ['-c', 'import importlib.util,sys;from pathlib import Path;s=importlib.util.spec_from_file_location("recipe",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);helpers,fonts=m.support_paths();assert (helpers/"assemble-msi.py").is_file();assert (fonts/"selawk.ttf").is_file()', path.join(installed, 'lib/qsys_linux.py')], { cwd: consumer });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
