// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm, readdir, mkdir, symlink, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runSmoke, parseArgs, bytes, streamArtifacts } from '../scripts/docker-smoke.mjs';
const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../scripts/docker-smoke.mjs', import.meta.url));

// A deliberately separate CLI process exercises argv boundaries and stdin, not a
// stub of runSmoke internals. It emulates Docker responses, not Designer runtime.
const fakeSource = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.dirname(process.argv[1]);
const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json')));
let args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
if (args[0] === '--context') args = args.slice(2);
const statePath = path.join(root, 'state.json');
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
// Barrier before the transaction lets both real driver processes observe the
// first-cache miss. The test releases them together, never by elapsed delay.
let forcedMiss = false;
if (settings.cacheBarrier && args[0] === 'volume' && args[1] === 'inspect' && args.at(-1) === 'shared-cache' && !fs.existsSync(path.join(root, 'cache-release'))) {
  forcedMiss = true;
  fs.writeFileSync(path.join(root, 'cache-ready-' + process.pid), 'ready');
  while (!fs.existsSync(path.join(root, 'cache-release'))) await pause();
}
const lockPath = path.join(root, 'transaction.lock');
while (true) {
  try { fs.mkdirSync(lockPath); break; }
  catch (error) { if (error.code !== 'EEXIST') throw error; await pause(); }
}
let locked = true;
const unlock = () => { if (locked) { fs.rmdirSync(lockPath); locked = false; } };
process.on('exit', unlock);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { containers: {}, volumes: {} };
const save = () => { const temp = statePath + '.' + process.pid; fs.writeFileSync(temp, JSON.stringify(state)); fs.renameSync(temp, statePath); };
const output = value => { unlock(); console.log(typeof value === 'string' ? value : JSON.stringify(value)); };
const fail = text => { console.error(text); process.exit(9); };
const name = args.at(-1);
if (args[0] === 'context') {
  if (args[1] === 'show') output('remote existing');
  else output([{ Endpoints: { docker: { Host: 'tcp://already-configured.invalid:2376' } } }]);
} else if (args[0] === 'info') output({ OSType: 'linux', Architecture: settings.armEngine ? 'aarch64' : 'x86_64', MemTotal: settings.lowMemory ? 1024 : 8 * 1024 ** 3, NCPU: 8, Name: 'fake-remote-engine', ServerVersion: 'test' });
else if (args[0] === 'image') {
  if (settings.missingImage) fail('No such image');
  output([{ Id: 'sha256:fake-local-image', Os: 'linux', Architecture: settings.wrongPlatform ? 'arm64' : 'amd64', Config: { User: 'qsys' }, RepoDigests: [] }]);
} else if (args[0] === 'volume' && args[1] === 'create') {
  state.volumes[name] ||= { Labels: Object.fromEntries(args.flatMap((a,i) => a === '--label' ? [args[i+1].split('=')] : [])) }; save(); output(name);
} else if (args[0] === 'volume' && args[1] === 'inspect') { if (forcedMiss || !state.volumes[name]) fail('No such volume: ' + name); output([state.volumes[name]]); }
else if (args[0] === 'volume' && args[1] === 'rm') {
  delete state.volumes[name]; save();
  if (settings.terminalJournalCollision && name.endsWith('-input')) {
    const journal=path.join(root,'artifacts with spaces','journal');
    const last=Math.max(...fs.readdirSync(journal).filter(n=>/^\d+\.json$/.test(n)).map(n=>Number(n.split('.')[0])));
    fs.writeFileSync(path.join(journal,String(last+3).padStart(6,'0')+'.json'),'{}');
  }
}
else if (args[0] === 'create') {
  const container = args[args.indexOf('--name') + 1];
  if (state.containers[container]) fail('Conflict: container name already in use');
  state.containers[container] = { Config: { Labels: { 'io.qsys.docker-smoke.run': args[args.indexOf('--label') + 1].split('=')[1] } }, mode: args.includes('--execution') ? args[args.lastIndexOf('--execution')+1] : null }; save();
  if (settings.crashRole && (settings.crashRole === 'cache-lock' ? container.startsWith('qsys-smoke-cache-lock-') : container.endsWith('-' + settings.crashRole))) {
    unlock();
    fs.writeFileSync(path.join(root, 'checkpoint-pid'), String(process.pid));
    await new Promise(() => setInterval(() => {}, 1000));
  }
  if ((settings.failAfterCreate && container.endsWith('-stage')) || (settings.failTestCreate && container.endsWith('-test'))) fail('accepted create then lost response'); output(container);
} else if (args[0] === 'inspect') {
  const resource = state.containers[name];
  if (!resource) fail('No such container: ' + name);
  if ((settings.foreignLabel && name.endsWith('-stage')) || (settings.foreignTestLabel && name.endsWith('-test'))) resource.Config.Labels['io.qsys.docker-smoke.run'] = 'foreign-run';
  output([resource]);
}
else if (args[0] === 'rm') { if(settings.failRemove && name.endsWith('-test')) fail('injected remove failure'); delete state.containers[name]; save(); if (settings.lostRemove && name.endsWith('-test')) fail('accepted remove then lost response'); }
else if (args[0] === 'logs') output('captured container diagnostic log');
else if (args[0] === 'stop') { if (settings.failStop) fail('injected stop failure'); output(name); }
else if (args[0] === 'start') {
  unlock();
  if (name.endsWith('-preflight')) {
    output('1000\nFilesystem 1024-blocks Used Available Capacity Mounted on');
    for (const mount of ['/input', '/work', '/cache', '/artifacts', '/home/qsys']) output('overlay 50000000 1000 ' + (settings.lowDisk ? '1024' : '40000000') + ' 1% ' + mount);
  } else if (name.endsWith('-stage')) {
    if (settings.failStage) fail('injected staging failure');
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    fs.writeFileSync(path.join(root, 'staged.tar'), Buffer.concat(chunks));
  } else if (name.endsWith('-test')) {
    if (settings.journalCollision) {
      const journal = path.join(root, 'artifacts with spaces', 'journal');
      const last = Math.max(...fs.readdirSync(journal).filter(n => /^\d+\.json$/.test(n)).map(n => Number(n.split('.')[0])));
      const next = path.join(journal, String(last + 1).padStart(6, '0') + '.json');
      fs.symlinkSync(path.join(root, 'victim.json'), next);
    }
    if (settings.namespaceRace) {
      fs.renameSync(path.join(root, 'artifacts with spaces'), path.join(root, 'displaced artifacts'));
      fs.symlinkSync(path.join(root, 'foreign output'), path.join(root, 'artifacts with spaces'));
    }
    if (settings.competition) {
      fs.writeFileSync(path.join(root, 'running'), 'yes');
      while (!fs.existsSync(path.join(root, 'test-release'))) await pause();
    }
    if (settings.hang) {
      process.on('SIGTERM', () => { fs.writeFileSync(path.join(root, 'signal-forwarded'), 'TERM'); process.exit(143); });
      process.on('SIGINT', () => { fs.writeFileSync(path.join(root, 'signal-forwarded'), 'INT'); process.exit(130); });
      fs.writeFileSync(path.join(root, 'attached-pid'), String(process.pid));
      fs.writeFileSync(path.join(root, 'running'), 'yes'); await new Promise(() => setInterval(() => {}, 1000));
    }
    if (settings.failTest) fail('injected smoke failure');
    output('test log');
  }
} else if (args[0] === 'cp') {
  if (settings.failExport) fail('injected export failure');
  const container = state.containers[args[1].split(':')[0]];
  const runId = settings.foreignPhase ? 'another-run' : container.Config.Labels['io.qsys.docker-smoke.run'];
  const entries=[['result.json',settings.invalidJson ? '{invalid' : settings.invalidSchema ? '"not a receipt"' : JSON.stringify({schemaVersion:1,status:settings.incomplete?'incomplete':'passed',cases:[{name:'fixture assertion',status:settings.incomplete?'skipped':'passed'}],versions:{},timings:{},artifacts:{}})],
    ['provisioning.json',JSON.stringify({schemaVersion:1,runId,status:'passed',manifestSha256:'a'.repeat(64),installerSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'selected installer.ZIP'))).digest('hex')})]];
  if(!settings.missingPhases)entries.push(['phases.json',JSON.stringify({schemaVersion:1,runId,mode:container.mode,execution:{mode:container.mode},status:'passed',phases:[{name:'provisioning',status:'passed'},{name:'application',status:settings.failedPhase?'failed':'passed'}]})]);
  const chunks=[];
  for(const [entry,value] of entries){
    if(settings.symlink===entry)continue;
    const data=Buffer.from(value),header=Buffer.alloc(512);
    const oct=(v,o,w)=>header.write(v.toString(8).padStart(w-1,'0')+'\0',o,w,'ascii');
    header.write('./'+entry);oct(0o600,100,8);oct(1000,108,8);oct(1000,116,8);oct(data.length,124,12);oct(0,136,12);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);header.write(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);
    chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  if(settings.symlink){
    const header=Buffer.alloc(512);header.write('./'+settings.symlink);header.write('0000600\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write('00000000000\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header[156]=50;header.write(path.join(root,'victim.json'),157,100);header.write('ustar\0',257);header.write('00',263);header.write(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);chunks.push(header);
  }
  unlock();process.stdout.write(Buffer.concat([...chunks,Buffer.alloc(1024)]));
} else fail('Unexpected arguments ' + JSON.stringify(args));
`;

async function fixture(t, settings = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qsys runner spaces '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const docker = path.join(dir, 'docker mock.mjs');
  await writeFile(docker, fakeSource); await chmod(docker, 0o700);
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify(settings));
  const installer = path.join(dir, 'selected installer.ZIP');
  const design = path.join(dir, 'selected design.qsys');
  await writeFile(installer, 'selected installer stream bytes');
  await writeFile(design, 'selected disposable fixture bytes');
  await writeFile(path.join(dir, 'unselected secret.txt'), 'must not stage');
  const artifacts = path.join(dir, 'artifacts with spaces');
  const options = { docker, context: 'remote existing', installer, design, artifacts };
  return { dir, options, calls: async () => (await readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) };
}
async function cleaned(dir) {
  const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(state, { containers: {}, volumes: {} });
}

test('option validation and resource sizes', () => {
  assert.equal(bytes('4g'), 4 * 1024 ** 3);
  assert.equal(bytes('1.5g'), 1.5 * 1024 ** 3);
  assert.throws(() => bytes('4gb'));
  assert.throws(() => parseArgs(['--installer']));
  assert.throws(() => parseArgs(['--surprise', 'x']));
  assert.throws(() => parseArgs(['--shm-size', '1g', '--shm-size', '2g']));
  assert.equal(parseArgs(['--shm-size', '1g']).shmSize, '1g');
});

test('remote context: only selected streams, paths with spaces, readonly input, caller artifact export and scoped cleanup', async t => {
  const f = await fixture(t);
  const result = await runSmoke(f.options);
  assert.equal(result.result.status, 'passed');
  assert.equal(result.engine.name, 'fake-remote-engine');
  assert.equal(result.artifactsExported, true);
  const calls = await f.calls();
  assert.ok(calls.every(argv => argv[0] === '--context' && argv[1] === 'remote existing'));
  const creates = calls.filter(argv => argv[2] === 'create');
  assert.equal(creates.length, 3);
  const stage = creates.find(argv => argv.includes('/bin/tar'));
  assert.ok(stage.includes('--interactive'));
  const smoke = creates.find(argv => argv.includes('smoke'));
  assert.ok(smoke.some(arg => /^type=volume,source=qsys-smoke-.*target=\/input,readonly$/.test(arg)));
  assert.ok(smoke.includes('--init'));
  assert.ok(creates.every(argv => argv.includes('1000:1000') && argv.includes('linux/amd64') && argv.includes('never')));
  assert.ok(!calls.flat().some(arg => arg.includes('type=bind') || arg.includes(f.options.installer) || arg.includes(f.options.design)));
  assert.ok(!calls.some(argv => ['build', 'push', 'pull', 'prune'].includes(argv[2])));
  const archive = path.join(f.dir, 'staged.tar');
  const listing = await exec('tar', ['-tf', archive]);
  assert.deepEqual(listing.stdout.trim().split('\n'), ['installer.zip', 'design.qsys']);
  assert.equal((await exec('tar', ['-xOf', archive, 'installer.zip'])).stdout, 'selected installer stream bytes');
  assert.equal((await exec('tar', ['-xOf', archive, 'design.qsys'])).stdout, 'selected disposable fixture bytes');
  const cp = calls.find(argv => argv[2] === 'cp');
  assert.equal(cp.at(-1), '-');
  assert.equal(JSON.parse(await readFile(path.join(f.options.artifacts, 'container/result.json'))).status, 'passed');
  assert.ok(smoke.includes('ALL') && smoke.includes('no-new-privileges') && smoke.includes('2048'));
  await cleaned(f.dir);
});

for (const [name, settings, message] of [
  ['accepted creation with failed CLI response', { failAfterCreate: true }, /lost response/],
  ['staging failure', { failStage: true }, /staging|stream|EPIPE/],
  ['failed test command', { failTest: true }, /exited 9/],
  ['artifact export failure', { failExport: true }, /result.json/],
  ['incomplete application result', { incomplete: true }, /incomplete/],
  ['insufficient daemon disk', { lowDisk: true }, /free bytes/],
]) test(`${name} fails truthfully and removes owned containers and volumes`, async t => {
  const f = await fixture(t, settings);
  await assert.rejects(runSmoke(f.options), message);
  await cleaned(f.dir);
  const receipt = JSON.parse(await readFile(path.join(f.options.artifacts, 'runner.json'), 'utf8'));
  assert.ok(receipt.error);
  if (settings.failTest) {
    const calls = await f.calls();
    const cpIndex = calls.findIndex(argv => argv[2] === 'cp');
    const rmIndex = calls.findIndex(argv => argv[2] === 'rm');
    assert.ok(cpIndex > 0 && cpIndex < rmIndex, 'export precedes removal');
  }
});

for (const settings of [{ lowMemory: true }, { missingImage: true }, { wrongPlatform: true }, { armEngine: true }]) test(`preflight rejects ${Object.keys(settings)[0]} before allocation`, async t => {
  const f = await fixture(t, settings);
  await assert.rejects(runSmoke(f.options));
  assert.ok(!(await f.calls()).some(argv => argv[2] === 'create' || argv[2] === 'volume'));
});

test('hybrid emulator checksum is checked before any daemon resource allocation', async t => {
  const f = await fixture(t);
  await assert.rejects(runSmoke({...f.options,execution:'hybrid-qemu',emulator:f.options.design}), /QEMU checksum/);
  assert.equal(await readFile(path.join(f.dir,'calls.jsonl')).catch(e=>e.code), 'ENOENT');
});

for (const settings of [{missingPhases:true},{foreignPhase:true},{failedPhase:true}]) test(`passing application cannot bypass ${Object.keys(settings)[0]}`, async t => {
  const f=await fixture(t,settings);
  await assert.rejects(runSmoke(f.options));
  assert.equal(JSON.parse(await readFile(path.join(f.options.artifacts,'result.json'))).status,'failed');
  await cleaned(f.dir);
});

test('explicit cache is retained across fresh runs while work and leases are removed', async t => {
  const f=await fixture(t); const options={...f.options,cacheVolume:'shared-cache'};
  await runSmoke(options);
  await runSmoke({...options,artifacts:path.join(f.dir,'second artifacts')});
  const state=JSON.parse(await readFile(path.join(f.dir,'state.json')));
  assert.deepEqual(state,{containers:{},volumes:{'shared-cache':{Labels:{'io.qsys.docker-smoke.cache':'v1'}}}});
  const calls=await f.calls();
  assert.equal(calls.filter(a=>a[2]==='volume'&&a[3]==='create'&&a.at(-1)==='shared-cache').length,1);
  assert.ok(!calls.some(a=>a[2]==='volume'&&a[3]==='rm'&&a.at(-1)==='shared-cache'));
});

for (const busy of [false,true]) test(`cache refuses ${busy?'concurrent lease':'foreign volume'} without removing it`, async t => {
  const f=await fixture(t);
  const lock='qsys-smoke-cache-lock-'+createHash('sha256').update('shared-cache').digest('hex').slice(0,24);
  const original={containers:busy?{[lock]:{Config:{Labels:{'io.qsys.docker-smoke.run':'another-run'}}}}:{},volumes:{'shared-cache':{Labels:{'io.qsys.docker-smoke.cache':busy?'v1':'foreign'}}}};
  await writeFile(path.join(f.dir,'state.json'),JSON.stringify(original));
  await assert.rejects(runSmoke({...f.options,cacheVolume:'shared-cache'}),busy?/Conflict/:/foreign/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir,'state.json'))),original);
  assert.ok(!(await f.calls()).some(a=>a[2]==='rm'||(a[2]==='volume'&&a[3]==='rm')));
});

for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]]) test(`${signal} collects artifacts and removes only owned resources before exit ${exitCode}`, { timeout: 15000 }, async t => {
  const f = await fixture(t, { hang: true });
  const argv = Object.entries(f.options).flatMap(([key, value]) => [`--${key}`, value]);
  const child = spawn(process.execPath, [runner, ...argv], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 150; i++) {
    if ((await readdir(f.dir)).includes('running')) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok((await readdir(f.dir)).includes('running'), stderr);
  if (signal === 'SIGINT') process.kill(-child.pid, signal);
  else child.kill(signal);
  assert.deepEqual(await completed, { code: exitCode, signal: null });
  await cleaned(f.dir);
  const receipt = JSON.parse(await readFile(path.join(f.options.artifacts, 'runner.json'), 'utf8'));
  assert.equal(receipt.artifactsExported, true);
  assert.ok(receipt.error.includes(signal));
  assert.ok(!(await readdir(f.dir)).includes('signal-forwarded'));
  assert.equal((await f.calls()).filter(argv => argv[2] === 'stop').length, 1);
});

for (const symlink of ['runner.json', 'result.json']) test(`exported ${symlink} symlink cannot read or overwrite host files`, async t => {
  const f = await fixture(t, { symlink });
  const victim = path.join(f.dir, 'victim.json');
  await writeFile(victim, 'private host sentinel');
  await assert.rejects(runSmoke(f.options));
  assert.equal(await readFile(victim, 'utf8'), 'private host sentinel');
  const receipt = JSON.parse(await readFile(path.join(f.options.artifacts, 'runner.json'), 'utf8'));
  assert.ok(receipt.cleanupErrors.some(error => /Unsafe exported artifact/.test(error)));
  assert.equal(receipt.artifactsExported, false);
  await cleaned(f.dir);
});

for (const [settings, expected] of [[{ invalidJson: true }, '{invalid'], [{ invalidSchema: true }, '"not a receipt"']]) test(`invalid container ${Object.keys(settings)[0]} is preserved separately from runner fallback`, async t => {
  const f = await fixture(t, settings);
  await assert.rejects(runSmoke(f.options), /readable result.json/);
  assert.equal(await readFile(path.join(f.options.artifacts, 'container/result.json'), 'utf8'), expected);
  assert.equal(JSON.parse(await readFile(path.join(f.options.artifacts, 'result.json'), 'utf8')).status, 'failed');
  await cleaned(f.dir);
});


test('cleanup refuses a resource with another ownership label', async t => {
  const f = await fixture(t, { foreignLabel: true, failStage: true });
  await assert.rejects(runSmoke(f.options));
  const calls = await f.calls();
  assert.ok(!calls.some(argv => argv[2] === 'rm' && argv.at(-1).endsWith('-stage')));
  const receipt = JSON.parse(await readFile(path.join(f.options.artifacts, 'runner.json'), 'utf8'));
  assert.ok(receipt.cleanupErrors.some(error => /ownership label mismatch/.test(error)));
});


test('stop and export also refuse a foreign-labeled test container', async t => {
  const f = await fixture(t, { foreignTestLabel: true });
  await assert.rejects(runSmoke(f.options));
  const calls = await f.calls();
  assert.ok(!calls.some(argv => ['stop', 'cp', 'logs'].includes(argv[2])));
  assert.ok(!calls.some(argv => argv[2] === 'rm' && argv.at(-1).endsWith('-test')));
  const receipt = JSON.parse(await readFile(path.join(f.options.artifacts, 'runner.json'), 'utf8'));
  assert.ok(receipt.cleanupErrors.some(error => /Refusing stop\/export/.test(error)));
});

test('failed stop never exports a possibly running container snapshot', async t => {
  const f = await fixture(t, { failStop: true });
  await assert.rejects(runSmoke(f.options));
  assert.ok(!(await f.calls()).some(argv => argv[2] === 'cp'));
  const receipt = JSON.parse(await readFile(path.join(f.options.artifacts, 'runner.json'), 'utf8'));
  assert.equal(receipt.artifactsExported, false);
  await cleaned(f.dir);
});

 test('cache lease stays reserved when test container removal fails', async t => {
 const f=await fixture(t,{failRemove:true});
 await assert.rejects(runSmoke({...f.options,cacheVolume:'shared-cache'}));
 const state=JSON.parse(await readFile(path.join(f.dir,'state.json')));
 assert.ok(Object.keys(state.containers).some(n=>n.startsWith('qsys-smoke-cache-lock-')));
 assert.ok(Object.keys(state.containers).some(n=>n.endsWith('-test')));
 const r=JSON.parse(await readFile(path.join(f.options.artifacts,'runner.json')));
 assert.ok(r.cleanupErrors.some(e=>e.includes('Retaining cache lease')));
 });

// Only mock CLI/driver processes below; these do not execute Docker or Designer.
async function waitFor(check, message) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
function driver(t, options, launch = {}) {
  const child = spawn(process.execPath, [runner, ...Object.entries(options).flatMap(([key, value]) => [`--${key === 'cacheVolume' ? 'cache-volume' : key}`, value])], { stdio: ['ignore', 'pipe', 'pipe'], ...launch });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, stderr })); });
  t.after(() => child.kill('SIGKILL'));
  return { child, done };
}
async function snapshots(artifacts) {
  const directory = path.join(artifacts, 'journal');
  const names = (await readdir(directory)).filter(name => /^\d+\.json$/.test(name)).sort();
  return Promise.all(names.map(name => readFile(path.join(directory, name), 'utf8').then(JSON.parse)));
}
for (const foreign of [false, true]) test(`P1 ambiguous test create preserves diagnostics; foreign=${foreign}`, async t => {
  const f = await fixture(t, { failTestCreate: true, foreignTestLabel: foreign });
  await assert.rejects(runSmoke(f.options), /lost response/);
  const calls = await f.calls();
  if (foreign) assert.ok(!calls.some(a => ['stop', 'logs', 'cp'].includes(a[2])));
  else {
    const stop = calls.findIndex(a => a[2] === 'stop');
    const logs = calls.findIndex(a => a[2] === 'logs');
    const cp = calls.findIndex(a => a[2] === 'cp');
    const remove = calls.findIndex(a => a[2] === 'rm');
    assert.ok(stop > 0 && logs > stop && cp > logs && remove > cp);
    await cleaned(f.dir);
  }
  const journal = await snapshots(f.options.artifacts);
  assert.equal(journal.at(-1).state, 'failed');
  assert.ok(journal.at(-1).errors.some(e => /lost response/.test(e)));
  const intent = journal.find(s => s.phase === 'allocate-test');
  assert.equal(intent.resources.find(r => r.role === 'test').state, 'intended');
});

test('P1 simultaneous first-cache two-process competition has one lease winner', { timeout: 30000 }, async t => {
  const f = await fixture(t, { cacheBarrier: true, competition: true });
  const first = driver(t, { ...f.options, cacheVolume: 'shared-cache' });
  const second = driver(t, { ...f.options, cacheVolume: 'shared-cache', artifacts: path.join(f.dir, 'second') });
  await waitFor(async () => (await readdir(f.dir)).filter(n => n.startsWith('cache-ready-')).length === 2, 'both processes reached first-cache barrier');
  await writeFile(path.join(f.dir, 'cache-release'), 'go');
  const loser = await Promise.race([first.done, second.done]);
  assert.equal(loser.code, 1, loser.stderr);
  assert.match(loser.stderr, /Conflict/);
  await waitFor(async () => (await readdir(f.dir)).includes('running'), 'winner attached');
  const before = await f.calls();
  const locks = before.filter(a => a[2] === 'create' && a.includes('--name') && a[a.indexOf('--name') + 1].startsWith('qsys-smoke-cache-lock-'));
  assert.equal(locks.length, 2);
  const workRuns = new Set(before.filter(a => a[2] === 'volume' && a[3] === 'create' && a.at(-1) !== 'shared-cache').map(a => a[a.indexOf('--label') + 1]));
  assert.equal(workRuns.size, 1, 'loser never allocates work volumes');
  assert.ok(!before.some(a => a[2] === 'rm'), 'loser never removes winner resources');
  await writeFile(path.join(f.dir, 'test-release'), 'go');
  const outcomes = await Promise.all([first.done, second.done]);
  assert.deepEqual(outcomes.map(o => o.code).sort(), [0, 1]);
  const state = JSON.parse(await readFile(path.join(f.dir, 'state.json')));
  assert.deepEqual(state, { containers: {}, volumes: { 'shared-cache': { Labels: { 'io.qsys.docker-smoke.cache': 'v1' } } } });
  assert.equal((await f.calls()).filter(a => a[2] === 'volume' && a[3] === 'create' && a.at(-1) === 'shared-cache').length, 2, 'both first-cache creates really competed');
});

test('P1 foreign cache wins inspect/create race and stays untouched', { timeout: 15000 }, async t => {
  const f = await fixture(t, { cacheBarrier: true });
  const run = driver(t, { ...f.options, cacheVolume: 'shared-cache' });
  await waitFor(async () => (await readdir(f.dir)).some(n => n.startsWith('cache-ready-')), 'cache miss barrier');
  await exec(f.options.docker, ['volume', 'create', '--label', 'io.qsys.docker-smoke.cache=foreign', 'shared-cache']);
  await writeFile(path.join(f.dir, 'cache-release'), 'go');
  const outcome = await run.done;
  assert.equal(outcome.code, 1); assert.match(outcome.stderr, /foreign/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'state.json'))), { containers: {}, volumes: { 'shared-cache': { Labels: { 'io.qsys.docker-smoke.cache': 'foreign' } } } });
  assert.ok(!(await f.calls()).some(a => a[2] === 'rm' || (a[2] === 'volume' && a[3] === 'rm')));
});

test('P1 accepted removal lost response retains lease despite absent test', async t => {
  const f = await fixture(t, { lostRemove: true });
  await assert.rejects(runSmoke({ ...f.options, cacheVolume: 'shared-cache' }));
  const state = JSON.parse(await readFile(path.join(f.dir, 'state.json')));
  assert.ok(!Object.keys(state.containers).some(n => n.endsWith('-test')));
  assert.equal(Object.keys(state.containers).filter(n => n.startsWith('qsys-smoke-cache-lock-')).length, 1);
  const journal = (await snapshots(f.options.artifacts)).at(-1);
  assert.equal(journal.state, 'failed');
  assert.ok(journal.errors.some(e => /Retaining cache lease/.test(e)));
});

test('P1 SIGKILL leaves durable incomplete evidence and next runner refuses stale lease', { timeout: 20000 }, async t => {
  const f = await fixture(t, { hang: true });
  const first = driver(t, { ...f.options, cacheVolume: 'shared-cache' });
  await waitFor(async () => (await readdir(f.dir)).includes('running'), 'disposable runner attached');
  first.child.kill('SIGKILL');
  assert.equal((await first.done).signal, 'SIGKILL');
  // The attached fake CLI is detached like Docker. Kill this disposable child
  // explicitly: SIGKILL of the driver cannot run finally or reap its CLI.
  process.kill(Number(await readFile(path.join(f.dir, 'attached-pid'), 'utf8')), 'SIGKILL');
  const stateBefore = JSON.parse(await readFile(path.join(f.dir, 'state.json')));
  const journal = await snapshots(f.options.artifacts);
  assert.equal(journal.at(-1).state, 'incomplete');
  assert.equal(journal.at(-1).phase, 'attached-test');
  assert.ok(journal.every((s, i) => s.sequence === i + 1 && s.state === 'incomplete'));
  assert.ok(journal.at(-1).resources.some(r => r.role === 'cache-lock' && r.state === 'acquired'));
  assert.equal(await readFile(path.join(f.options.artifacts, 'runner.json')).catch(e => e.code), 'ENOENT');
  const next = driver(t, { ...f.options, cacheVolume: 'shared-cache', artifacts: path.join(f.dir, 'after crash') });
  assert.match((await next.done).stderr, /Conflict/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'state.json'))), stateBefore);
  assert.ok(!(await f.calls()).some(a => ['stop', 'rm', 'cp'].includes(a[2])));
});

for (const role of ['cache-lock', 'stage']) test(`P1 SIGKILL during accepted ${role} allocation retains intent and lease`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { crashRole: role });
  t.after(async () => {
    const pid = await readFile(path.join(f.dir, 'checkpoint-pid'), 'utf8').catch(() => null);
    if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  });
  const first = driver(t, { ...f.options, cacheVolume: 'shared-cache' });
  await waitFor(async () => (await readdir(f.dir)).includes('checkpoint-pid'), 'accepted allocation checkpoint');
  first.child.kill('SIGKILL');
  assert.equal((await first.done).signal, 'SIGKILL');
  process.kill(Number(await readFile(path.join(f.dir, 'checkpoint-pid'), 'utf8')), 'SIGKILL');
  const durable = (await snapshots(f.options.artifacts)).at(-1);
  assert.equal(durable.state, 'incomplete');
  assert.equal(durable.phase, `allocate-${role}`);
  assert.equal(durable.resources.find(r => r.role === role).state, 'intended');
  const before = JSON.parse(await readFile(path.join(f.dir, 'state.json')));
  const next = driver(t, { ...f.options, cacheVolume: 'shared-cache', artifacts: path.join(f.dir, 'retry') });
  assert.match((await next.done).stderr, /Conflict/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'state.json'))), before);
  assert.ok(!(await f.calls()).some(a => ['rm', 'stop', 'cp'].includes(a[2])));
});

test('P1 namespace replacement fails closed and preserves foreign output', async t => {
  const f = await fixture(t, { namespaceRace: true });
  const victim = path.join(f.dir, 'foreign output');
  await mkdir(victim);
  await writeFile(path.join(victim, 'sentinel'), 'untouched');
  await assert.rejects(runSmoke(f.options), error => {
    assert.match(error.message, /did not export a safe readable result.json/);
    assert.ok(error.cleanupErrors.some(message => /namespace changed/.test(message)));
    return true;
  });
  assert.deepEqual(await readdir(victim), ['sentinel']);
  assert.equal(await readFile(path.join(victim, 'sentinel'), 'utf8'), 'untouched');
  const durable = await snapshots(path.join(f.dir, 'displaced artifacts'));
  assert.ok(durable.every(s => s.state === 'incomplete'));
  await cleaned(f.dir);
});

test('P1 symlink artifact ancestor is rejected before daemon or output writes', async t => {
  const f = await fixture(t);
  const victim = path.join(f.dir, 'foreign output');
  await mkdir(victim);
  const alias = path.join(f.dir, 'alias');
  await symlink(victim, alias);
  await assert.rejects(runSmoke({ ...f.options, artifacts: path.join(alias, 'new output') }), /Unsafe artifacts/);
  assert.deepEqual(await readdir(victim), []);
  assert.equal(await readFile(path.join(f.dir, 'calls.jsonl')).catch(e => e.code), 'ENOENT');
});

test('P1 successful journal completes only after authoritative receipts exist', async t => {
  const f = await fixture(t);
  await runSmoke(f.options);
  const entries = await snapshots(f.options.artifacts);
  assert.ok(entries.slice(0, -1).every(s => s.state === 'incomplete'));
  assert.equal(entries.at(-1).state, 'completed');
  assert.equal(entries.at(-1).schemaVersion, 1);
  assert.equal(entries.at(-1).imageId, 'sha256:fake-local-image');
  assert.equal(entries.at(-1).dockerEndpoint, 'tcp://already-configured.invalid:2376');
  assert.equal(entries.at(-1).inputs['installer.zip'], createHash('sha256').update('selected installer stream bytes').digest('hex'));
  assert.ok(entries.at(-1).resources.every(r => r.state === 'removed'));
  assert.equal(JSON.parse(await readFile(path.join(f.options.artifacts, 'result.json'))).status, 'passed');
  assert.equal(JSON.parse(await readFile(path.join(f.options.artifacts, 'runner.json'))).error, undefined);
  await cleaned(f.dir);
});

test('P1 journal sequence collision never follows or replaces a symlink', async t => {
  const f = await fixture(t, { journalCollision: true });
  await writeFile(path.join(f.dir, 'victim.json'), 'immutable sentinel');
  await assert.rejects(runSmoke(f.options));
  assert.equal(await readFile(path.join(f.dir, 'victim.json'), 'utf8'), 'immutable sentinel');
  const receipt = JSON.parse(await readFile(path.join(f.options.artifacts, 'runner.json')));
  // Linux publishes via Node; macOS uses Python's descriptor-relative helper.
  assert.ok(receipt.cleanupErrors.some(e => /Journal:[\s\S]*(?:EEXIST|FileExistsError: \[Errno 17\])/.test(e)));
  assert.equal(JSON.parse(await readFile(path.join(f.options.artifacts, 'result.json'))).status, 'failed');
  await cleaned(f.dir);
});

test('review: Python ignores cwd module shadows and PYTHONPATH', async t => {
  const f=await fixture(t);
  const shadow="from pathlib import Path\nPath(__file__).with_name('HIJACKED').write_text('bad')\nraise RuntimeError('cwd import executed')\n";
  for(const name of ['json.py','uuid.py']) await writeFile(path.join(f.dir,name),shadow);
  const result=await driver(t,f.options,{cwd:f.dir,env:{...process.env,PYTHONPATH:f.dir}}).done;
  assert.equal(result.code,0,result.stderr);
  assert.equal(await readFile(path.join(f.dir,'HIJACKED')).catch(e=>e.code),'ENOENT');
  await cleaned(f.dir);
});

test('review: relative Docker executable supports streaming export', async t => {
  const f=await fixture(t);
  const result=await driver(t,{...f.options,docker:'./docker mock.mjs'},{cwd:f.dir}).done;
  assert.equal(result.code,0,result.stderr);await cleaned(f.dir);
});

for (const mode of ['truncated', 'failed-producer', 'hang', 'reject-midstream']) test(`stream: ${mode} cannot pass and producer is reaped`, async t => {
  const f=await fixture(t);const output=path.join(f.dir,'stream output');await mkdir(output);
  const helper=path.join(f.dir,'stream producer.mjs');
  const encoded=await exec('python3',['-I','-c',"import tarfile,io,sys;p=io.BytesIO();a=tarfile.open(fileobj=p,mode='w');h=tarfile.TarInfo('file');h.size=3;a.addfile(h,io.BytesIO(b'abc'));a.close();sys.stdout.buffer.write(p.getvalue())"],{encoding:'buffer'});
  await writeFile(helper+'.tar',mode==='truncated'?encoded.stdout.subarray(0,514):mode==='reject-midstream'?Buffer.alloc(512,1):encoded.stdout);
  await writeFile(helper,`#!/usr/bin/env node\nimport fs from 'node:fs';fs.writeFileSync(process.argv[1]+'.pid',String(process.pid));const data=fs.readFileSync(process.argv[1]+'.tar');${mode==='hang'?"process.stdout.write(data);setInterval(()=>{},1000);":mode==='failed-producer'?"process.stdout.end(data,()=>process.exit(23));":"process.stdout.end(data);"}`,{mode:0o700});
  if(mode==='reject-midstream') await writeFile(helper,`#!/usr/bin/env node\nimport fs from 'node:fs';fs.writeFileSync(process.argv[1]+'.pid',String(process.pid));process.stderr.write('producer secondary diagnostic\\n');process.stdout.on('error',()=>{setInterval(()=>{},1000);});const data=fs.readFileSync(process.argv[1]+'.tar');function send(){while(process.stdout.write(data)){} }process.stdout.on('drain',send);send();`,{mode:0o700});
  const fd=await open(output,'r');
  try {
    await assert.rejects(streamArtifacts(helper,[],'test-only',fd.fd,{timeout:mode==='hang'?2000:10000}),mode==='hang'?/timed out/:mode==='truncated'?/Truncated/:mode==='reject-midstream'?/Artifact stream rejected:/:/failed \(23\)/);
  } finally {await fd.close();}
  const pid=Number(await readFile(helper+'.pid','utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('stream: missing Docker executable reports the spawn failure', async t => {
  const f=await fixture(t);const output=path.join(f.dir,'stream output');await mkdir(output);
  const fd=await open(output,'r');
  try {await assert.rejects(streamArtifacts(path.join(f.dir,'missing-docker'),[],'test-only',fd.fd),{code:'ENOENT'});}
  finally {await fd.close();}
});

test('review: caller configured symlinked temporary root is canonicalized once', async t => {
  const f=await fixture(t);const alias=path.join(f.dir,'declared-tmp');await symlink(f.dir,alias);
  const artifacts=path.join(alias,'temporary output');
  const result=await driver(t,{...f.options,artifacts},{env:{...process.env,TMPDIR:alias}}).done;
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(await readFile(path.join(f.dir,'temporary output','result.json'))).status,'passed');
  await cleaned(f.dir);
});

test('review: macOS system aliases support artifact output', {skip:process.platform!=='darwin'}, async t => {
  for(const prefix of ['/tmp','/var/tmp']){
    const f=await fixture(t);const artifacts=path.join(prefix,'qsys-alias-'+path.basename(f.dir));
    t.after(()=>rm(artifacts,{recursive:true,force:true}));
    const result=await driver(t,{...f.options,artifacts}).done;
    assert.equal(result.code,0,result.stderr);await cleaned(f.dir);
  }
});

test('review: terminal journal failure warns without contradicting committed result', async t => {
  const f=await fixture(t,{terminalJournalCollision:true});
  const result=await driver(t,f.options).done;
  assert.equal(result.code,0,result.stderr);
  assert.match(result.stderr,/Warning: terminal journal snapshot failed/);
  assert.equal(JSON.parse(await readFile(path.join(f.options.artifacts,'result.json'))).status,'passed');
  assert.equal(JSON.parse(await readFile(path.join(f.options.artifacts,'runner.json'))).error,undefined);
  await cleaned(f.dir);
});

test('review: missing Python and nonempty artifact errors stay concise', async t => {
  const f=await fixture(t);const bin=path.join(f.dir,'empty-bin');await mkdir(bin);
  const missing=await driver(t,f.options,{env:{...process.env,PATH:bin}}).done;
  assert.equal(missing.code,1);assert.match(missing.stderr,/working host python3/);
  assert.equal(await readFile(path.join(f.dir,'calls.jsonl')).catch(e=>e.code),'ENOENT');
  await mkdir(f.options.artifacts);await writeFile(path.join(f.options.artifacts,'sentinel'),'stay');
  const nonempty=await driver(t,f.options).done;
  assert.equal(nonempty.code,1);assert.match(nonempty.stderr,/Artifacts directory must be empty/);
  assert.ok(nonempty.stderr.length<1000);assert.doesNotMatch(nonempty.stderr,/import os/);
});

test('review: CLI prints retained lease and namespace diagnostics when receipt writes fail', async t => {
  const f=await fixture(t,{namespaceRace:true,failRemove:true});
  const victim=path.join(f.dir,'foreign output');await mkdir(victim);await writeFile(path.join(victim,'sentinel'),'stay');
  const result=await driver(t,{...f.options,cacheVolume:'shared-cache'}).done;
  assert.equal(result.code,1);assert.match(result.stderr,/Cleanup: Retaining cache lease/);
  assert.match(result.stderr,/namespace changed/);assert.deepEqual(await readdir(victim),['sentinel']);
});
