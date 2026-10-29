import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runCli } from '../lib/launcher.mjs';

function fixture() {
  const child = new EventEmitter();
  const parent = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  let invocation;
  const stderr = { output: '', write(text) { this.output += text; } };
  const options = { platform: 'linux', spawnImpl: (...args) => { invocation = args; return child; }, processImpl: parent, stderr };
  return { child, parent, signals, stderr, options, invocation: () => invocation };
}

test('forwards installer arguments literally and returns the recipe exit code', async () => {
  const f = fixture();
  const args = ['install', '/tmp/a file;$(never-run).zip', '--scale', '200'];
  const result = runCli(args, f.options);
  assert.equal(f.invocation()[0], 'python3');
  assert.deepEqual(f.invocation()[1].slice(1), args);
  assert.deepEqual(f.invocation()[2], { stdio: 'inherit' });
  f.child.emit('close', 7, null);
  assert.equal(await result, 7);
});

test('forwards termination to Python so its prefix cleanup can run', async () => {
  const f = fixture();
  const result = runCli(['launch'], f.options);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) f.parent.emit(signal);
  assert.deepEqual(f.signals, ['SIGINT', 'SIGTERM', 'SIGHUP']);
  f.child.emit('close', 130, null);
  assert.equal(await result, 130);
  assert.equal(f.parent.listenerCount('SIGTERM'), 0);
});

test('missing Python gets an actionable error and removes signal listeners', async () => {
  const f = fixture();
  const result = runCli(['status'], f.options);
  f.child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  assert.equal(await result, 1);
  assert.match(f.stderr.output, /requires Python 3/);
  assert.equal(f.parent.listenerCount('SIGHUP'), 0);
});

test('unsupported hosts refuse execution without starting Python', async () => {
  const f = fixture();
  assert.equal(await runCli(['install', 'vendor.zip'], { ...f.options, platform: 'darwin' }), 1);
  assert.equal(f.invocation(), undefined);
  assert.match(f.stderr.output, /qsys-mac/);
});
