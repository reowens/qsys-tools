#!/usr/bin/env node
// Public client against a local, disposable Designer Emulate instance only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function runQrcSmoke({ QrcClient, host = '127.0.0.1', port = 1710 }) {
  assert.equal(host, '127.0.0.1', 'Only literal IPv4 loopback is allowed; no external Core targets');
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid port');
  const result = { schemaVersion: 1, status: 'failed', cases: [], versions: {}, timings: {}, artifacts: {} };
  const client = new QrcClient({ host, port, reconnect: false, requestTimeoutMs: 5000 });
  // EventEmitter error events must not crash before the receipt is written.
  client.on('error', () => {});
  const started = Date.now();
  async function check(name, fn) {
    const at = Date.now();
    try {
      const evidence = await fn();
      result.cases.push({ name, status: 'passed', durationMs: Date.now() - at, evidence });
      return evidence;
    } catch (error) {
      result.cases.push({ name, status: 'failed', durationMs: Date.now() - at, reason: String(error.message ?? error) });
      throw error;
    }
  }
  const group = `qsys-docker-${randomUUID()}`;
  let original, wrote = false, groupAttempted = false;
  async function readGain() {
    const reply = await client.getComponent('Levels', ['gain']);
    const control = reply.Controls?.find(c => c.Name === 'gain');
    assert.ok(control && typeof control.Value === 'number' && Number.isFinite(control.Value), 'Levels.gain numeric value absent');
    return control.Value;
  }
  async function pollUntil(fn, message) {
    const until = Date.now() + 5000;
    do {
      if (await fn()) return;
      await new Promise(r => setTimeout(r, 100));
    } while (Date.now() < until);
    throw new Error(message);
  }
  try {
    await check('connect', async () => { await client.connect(); });
    await check('is-emulator', async () => {
      const status = await client.statusGet();
      assert.equal(status.IsEmulator, true, 'Refusing writes: StatusGet.IsEmulator must be true');
      return { IsEmulator: status.IsEmulator, State: status.State };
    });
    await check('discovery-read', async () => {
      const components = await client.getComponents();
      assert.ok(components.some(c => c.Name === 'Levels'), 'Fixture requires QRC-accessible Levels component');
      const controls = await client.getComponentControls('Levels');
      assert.ok(controls.Controls?.some(c => c.Name === 'gain'), 'Fixture requires Levels.gain');
      original = await readGain();
      return { component: 'Levels', control: 'gain', original };
    });
    await check('change-group-register', async () => {
      groupAttempted = true;
      await client.changeGroupAddComponentControl(group, 'Levels', ['gain']);
      await client.changeGroupPoll(group); // Drain initial state; later poll must reflect our write.
    });
    // Move toward the interior of the usual gain range, avoiding a clamp at its extremes.
    const target = original >= 0 ? original - 1 : original + 1;
    await check('write-readback', async () => {
      // A second guard immediately before the only value mutation.
      assert.equal((await client.statusGet()).IsEmulator, true, 'Emulator guard changed');
      wrote = true; // Even a lost acknowledgement requires a restoration attempt.
      await client.setComponent('Levels', [{ Name: 'gain', Value: target }]);
      await pollUntil(async () => Math.abs(await readGain() - target) < 0.001, 'Gain readback did not match write');
      return { original, target };
    });
    await check('change-group-update', async () => {
      await pollUntil(async () => {
        const reply = await client.changeGroupPoll(group);
        return reply.Changes?.some(c => (c.Name === 'gain' || c.Name === 'Levels.gain') &&
          typeof c.Value === 'number' && Math.abs(c.Value - target) < 0.001);
      }, 'No matching gain update in ChangeGroup.Poll');
    });
  } catch (error) {
    result.error = String(error.message ?? error);
  } finally {
    if (wrote) {
      try {
        await check('restore-control', async () => {
          assert.equal((await client.statusGet()).IsEmulator, true, 'Refusing restore to non-emulator');
          await client.setComponent('Levels', [{ Name: 'gain', Value: original }]);
          await pollUntil(async () => Math.abs(await readGain() - original) < 0.001, 'Original gain not restored');
        });
      } catch { /* recorded; still destroy the group */ }
    }
    if (groupAttempted) {
      try { await check('destroy-change-group', () => client.changeGroupDestroy(group)); } catch { /* recorded */ }
    }
    client.close();
  }
  for (const name of ['connect', 'is-emulator', 'discovery-read', 'change-group-register', 'write-readback',
    'change-group-update', 'restore-control', 'destroy-change-group']) {
    if (!result.cases.some(c => c.name === name)) result.cases.push({ name, status: 'skipped', reason: 'Prerequisite failed; no operation attempted' });
  }
  result.status = result.cases.every(c => c.status === 'passed') ? 'passed' : 'failed';
  result.timings.totalMs = Date.now() - started;
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  let output = '/artifacts/qrc.json';
  let result;
  try {
    const { values } = parseArgs({ args: argv, options: {
      host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '1710' },
      output: { type: 'string', default: output },
    } });
    output = values.output;
    assert.equal(values.host, '127.0.0.1', 'Only literal IPv4 loopback is allowed');
    const { QrcClient } = await import('qsys-qrc'); // installed locally under /opt/qsys-test/node_modules
    result = await runQrcSmoke({ QrcClient, host: values.host, port: Number(values.port) });
    result.versions.node = process.version;
  } catch (error) {
    result = { schemaVersion: 1, status: 'failed', cases: [{ name: 'qrc-setup', status: 'failed', reason: String(error.message ?? error) }], versions: { node: process.version }, timings: {}, artifacts: {} };
  }
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  await rename(`${output}.tmp`, output);
  return result.status === 'passed' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
