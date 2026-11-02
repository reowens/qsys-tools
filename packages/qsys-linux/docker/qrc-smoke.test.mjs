// Exercise the actual public QrcClient over a minimal wire recorder, not a private emulator.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { QrcClient } from '../../qsys-qrc/dist/index.js';
import { runQrcSmoke } from './qrc-smoke.mjs';

async function wireRun(options = {}) {
  let gain = -17, pending = false;
  const calls = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      while (buffer.includes('\0')) {
        const at = buffer.indexOf('\0');
        const request = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        const { id, method, params } = request;
        calls.push({ method, params });
        let result = true;
        if (method === 'StatusGet') result = { IsEmulator: options.emulator !== false, State: 'Active' };
        if (method === 'Component.GetComponents') result = options.missing ? [] : [{ Name: 'Levels' }];
        if (method === 'Component.GetControls' || method === 'Component.Get') result = { Name: 'Levels', Controls: [{ Name: 'gain', Value: gain }] };
        if (method === 'Component.Set') {
          gain = params.Controls[0].Value;
          pending = true;
        }
        if (method === 'ChangeGroup.Poll') {
          result = { Id: params.Id, Changes: pending ? [{ Name: 'gain', Value: gain }] : [] };
          pending = false;
          if (options.pollError && calls.some(c => c.method === 'Component.Set')) {
            socket.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: 'injected poll failure' } }) + '\0');
            continue;
          }
        }
        if (id !== undefined) socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\0');
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const receipt = await runQrcSmoke({ QrcClient, port: server.address().port });
    return { receipt, calls, gain };
  } finally {
    await new Promise(r => server.close(r));
  }
}

test('real public client performs wire read/write/group update and restores', async () => {
  const { receipt, calls, gain } = await wireRun();
  assert.equal(receipt.status, 'passed');
  assert.equal(gain, -17);
  assert.equal(calls.filter(c => c.method === 'Component.Set').length, 2);
  assert.equal(calls.at(-1).method, 'ChangeGroup.Destroy');
});
test('non-emulator guard prohibits all writes and group changes', async () => {
  const { receipt, calls } = await wireRun({ emulator: false });
  assert.equal(receipt.status, 'failed');
  assert.ok(!calls.some(c => c.method === 'Component.Set' || c.method.startsWith('ChangeGroup.')));
});
test('missing fixture fails honestly without mutation', async () => {
  const { receipt, calls } = await wireRun({ missing: true });
  assert.equal(receipt.status, 'failed');
  assert.ok(!calls.some(c => c.method === 'Component.Set'));
});
test('failure after mutation still restores gain and destroys group', async () => {
  const { receipt, gain, calls } = await wireRun({ pollError: true });
  assert.equal(receipt.status, 'failed');
  assert.equal(gain, -17);
  assert.equal(calls.at(-1).method, 'ChangeGroup.Destroy');
  assert.equal(receipt.cases.find(c => c.name === 'restore-control').status, 'passed');
});
test('external targets rejected before client construction', async () => {
  await assert.rejects(runQrcSmoke({ QrcClient, host: '192.0.2.1' }), /loopback/);
});
