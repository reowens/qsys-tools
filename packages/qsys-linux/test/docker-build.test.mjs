// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImage, CONTEXT_FILES, publicationOptions, validateContext, stageSource, packPackages, manifestExists, assertUnpublished } from '../scripts/docker-build.mjs';

const revision = 'a'.repeat(40);
const root = fileURLToPath(new URL('../../../', import.meta.url));
async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qsys-build-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('publication requires explicit authorization, full SHA, registry, receipt and immutable tag', () => {
  assert.equal(publicationOptions().push, false);
  assert.equal(publicationOptions().image, 'qsys-designer-test:local');
  for (const options of [
    { push: true }, { push: true, revision: 'HEAD' }, { push: true, revision, development: true },
    { push: true, revision }, { push: true, revision, receipt: '/tmp/unused' },
    { push: true, revision, receipt: '/tmp/unused', registry: 'registry.example', image: 'qsys:latest' },
    { revision, development: true }, { cache: 'registry.example/cache' }, { registry: 'https://registry.example' },
    { image: '../private' }, { push: 'false' },
    { push: true, revision, receipt: '/tmp/unused', registry: 'registry.example', cache: `registry.example/qsys-designer-test:${'b'.repeat(40)}` },
    { push: true, revision, receipt: '/tmp/unused', registry: 'registry.example', cache: 'registry.example/qsys-designer-test:cache' },
    { push: true, revision, receipt: '/tmp/unused', registry: 'registry.example', cache: `registry.example/separate:${'b'.repeat(40)}` },
  ]) assert.throws(() => publicationOptions(options));
  assert.equal(publicationOptions({ push: true, revision, receipt: '/tmp/unused', registry: 'registry.example:5000/team' }).image,
    `registry.example:5000/team/qsys-designer-test:${revision}`);
});
test('dedicated context refuses extra files, directories, symlinks and missing required files', async t => {
  const directory = await scratch(t);
  for (const name of CONTEXT_FILES) await writeFile(path.join(directory, name), name);
  assert.equal(Object.keys(await validateContext(directory)).length, CONTEXT_FILES.length);
  await writeFile(path.join(directory, 'installer.zip'), 'not an installer');
  await assert.rejects(validateContext(directory), /non-allowlisted/);
  await rm(path.join(directory, 'installer.zip'));
  await rm(path.join(directory, 'smoke.py'));
  await symlink('/etc/passwd', path.join(directory, 'smoke.py'));
  await assert.rejects(validateContext(directory), /regular file/);
  await rm(path.join(directory, 'smoke.py'));
  await mkdir(path.join(directory, 'smoke.py'));
  await assert.rejects(validateContext(directory), /regular file/);
  await rm(path.join(directory, 'smoke.py'), { recursive: true });
  await assert.rejects(validateContext(directory), /missing smoke.py/);
});
test('CLI rejects unknown options without building; help does not build', () => {
  const script = fileURLToPath(new URL('../scripts/docker-build.mjs', import.meta.url));
  assert.match(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }), /frozen HEAD/);
  assert.throws(() => execFileSync(process.execPath, [script, '--pussh'], { stdio: 'pipe' }), /Command failed/);
});
test('frozen archive is pinned to committed bytes despite concurrent integration changes', async t => {
  const directory = await scratch(t);
  const { source, sourceRevision } = await stageSource(directory, {});
  const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(sourceRevision, expected);
  const filename = 'packages/qsys-linux/scripts/build.mjs';
  assert.deepEqual(await readFile(path.join(source, filename)), execFileSync('git', ['show', `${expected}:${filename}`], { cwd: root }));
  assert.equal(await readFile(path.join(source, 'packages/qsys-mac-installer/README.md')).catch(e => e.code), 'ENOENT');
});
test('packages are built from staged real sources, independently of runtime helper availability', async t => {
  const directory = await scratch(t);
  const { source, sourceRevision } = await stageSource(directory, { development: true });
  assert.equal(sourceRevision, null);
  const context = path.join(directory, 'packed');
  await mkdir(context);
  assert.match(await packPackages(source, context), /Version /);
  const linux = execFileSync('tar', ['-tzf', path.join(context, 'qsys-linux.tgz')], { encoding: 'utf8' });
  const qrc = execFileSync('tar', ['-tzf', path.join(context, 'qsys-qrc.tgz')], { encoding: 'utf8' });
  assert.match(linux, /package\/lib\/support\/fonts\/selawk.ttf/);
  assert.match(linux, /package\/bin\/qsys-linux.mjs/);
  assert.match(qrc, /package\/dist\/index.js/);
  assert.doesNotMatch(linux + qrc, /docker\/|\.zip|\.qsys/);
});
test('registry probes treat only explicit manifest absence as cold, preserving auth/connectivity refusal', async t => {
  const directory = await scratch(t);
  const executable = path.join(directory, 'probe');
  for (const [message, expected] of [
    ['manifest unknown', false], ['name unknown', false], ['manifest not found', false],
    ['ERROR: example/image:cache: not found', false],
    ['ERROR: another/image:cache: not found', 'error'],
    ['ERROR: example/image:cache: not found (401 Unauthorized)', 'error'],
    ['unauthorized: manifest unknown', 'error'], ['connection refused', 'error'], ['denied', 'error'],
  ]) {
    await writeFile(executable, `#!/bin/sh\necho '${message}' >&2\nexit 1\n`, { mode: 0o755 });
    if (expected === 'error') await assert.rejects(manifestExists(executable, [], 'example/image:cache'));
    else assert.equal(await manifestExists(executable, [], 'example/image:cache'), expected);
  }
  await writeFile(executable, '#!/bin/sh\necho exists\n', { mode: 0o755 });
  assert.equal(await manifestExists(executable, [], 'example/image:sha'), true);
  await assert.rejects(assertUnpublished(executable, [], 'example/image:sha'), /Immutable tag already exists/);
});
test('development builds stage and pack actual packages, with local source labels and receipt', async t => {
  try { await access(path.join(root, 'packages/qsys-linux/docker/smoke.py')); }
  catch { t.skip('Application builder has not yet supplied smoke.py; full context simulation cannot run'); return; }
  const directory = await scratch(t);
  // Simulated Docker only: no daemon, registry, vendor payload or manufactured package metadata.
  const fake = path.join(directory, 'docker');
  const capture = path.join(directory, 'capture.json');
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const capture = ${JSON.stringify(capture)};
if (args.includes('build')) {
  const context = args.at(-1);
  const labels = Object.fromEntries(args.flatMap((v,i) => v === '--label' ? [args[i+1].split(/=(.*)/s).slice(0,2)] : []));
  const files = fs.readdirSync(context).sort();
  const packages = Object.fromEntries(['qsys-linux','qsys-qrc'].map(n => [n,cp.execFileSync('tar',['-tzf',context+'/'+n+'.tgz'],{encoding:'utf8'})]));
  fs.writeFileSync(capture, JSON.stringify({args, labels, files, packages}));
  if (args.includes('qsys-fail:local')) { console.error('simulated build failure'); process.exit(42); }
  fs.writeFileSync(args[args.indexOf('--metadata-file')+1], '{}');
} else if (args.includes('inspect')) {
  const {labels} = JSON.parse(fs.readFileSync(capture));
  console.log(JSON.stringify([{Id:'sha256:'+'1'.repeat(64),Os:'linux',Architecture:'amd64',Config:{Labels:labels}}]));
} else process.exit(91);
`, { mode: 0o755 });
  const receipt = path.join(directory, 'receipt.json');
  const result = await buildImage({ development: true, docker: fake, receipt });
  assert.equal(result.sourceRevision, null);
  assert.equal(result.sourceMode, 'development');
  assert.equal(result.published, false);
  assert.equal(result.digestKind, 'image-id');
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), result);
  const captured = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(captured.files, [...CONTEXT_FILES].sort());
  assert.ok(captured.args.includes('--load'));
  assert.ok(!captured.args.includes('--push'));
  assert.ok(captured.args.includes('linux/amd64'));
  assert.equal(captured.labels['org.opencontainers.image.revision'], 'local');
  assert.match(captured.packages['qsys-linux'], /package\/lib\/support\/fonts\/selawk.ttf/);
  assert.match(captured.packages['qsys-qrc'], /package\/dist\/index.js/);
  assert.doesNotMatch(captured.packages['qsys-linux'], /docker\/|\.zip|\.qsys/);
  await assert.rejects(buildImage({ development: true, docker: fake, receipt, image: 'qsys-fail:local' }), /simulated build failure/);
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), result, 'failed builds must not replace a successful receipt');
  const failed = JSON.parse(await readFile(capture, 'utf8'));
  await assert.rejects(access(failed.args.at(-1)), { code: 'ENOENT' }, 'temporary context must be removed even on failure');
});

test('a post-push verification failure preserves the published digest receipt', async t => {
  const directory = await scratch(t);
  // A separate disposable Git repository tests frozen publication without
  // committing, staging or changing a branch in the operator's checkout.
  const { source } = await stageSource(directory, { development: true });
  await copyFile(fileURLToPath(new URL('../scripts/docker-build.mjs', import.meta.url)), path.join(source, 'packages/qsys-linux/scripts/docker-build.mjs'));
  await writeFile(path.join(source, '.gitignore'), 'node_modules/\n');
  await symlink(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']); git(['add', '.']);
  git(['-c', 'user.name=Test Fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Disposable public build fixture']);
  const sha = git(['rev-parse', 'HEAD']).trim();
  const published = path.join(directory, 'published');
  const fake = path.join(directory, 'docker');
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const marker = ${JSON.stringify(published)};
if (args.includes('build')) {
  fs.writeFileSync(args[args.indexOf('--metadata-file')+1], JSON.stringify({'containerimage.digest':'sha256:'+'a'.repeat(64)}));
  fs.writeFileSync(marker, 'push complete');
  const cache = args[args.indexOf('--cache-to')+1];
  if (!cache || !cache.includes('ignore-error=true')) { console.error('simulated post-push cache-export failure'); process.exit(42); }
} else if (args.includes('imagetools')) {
  console.error(fs.existsSync(marker) ? 'denied: post-push verification test' : 'ERROR: '+args[args.indexOf('inspect')+1]+': not found');
  process.exit(1);
} else process.exit(91);
`, { mode: 0o755 });
  const receipt = path.join(directory, 'nested', 'publication.json');
  assert.throws(() => execFileSync(process.execPath, [path.join(source, 'packages/qsys-linux/scripts/docker-build.mjs'),
    '--push', '--revision', sha, '--registry', 'registry.example.invalid', '--cache', 'registry.example.invalid/qsys-cache:buildcache', '--docker', fake, '--receipt', receipt],
  { cwd: source, stdio: 'pipe' }), error => /Published .*@sha256:a{64}; verification pending/.test(String(error.stderr)));
  const result = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(result.verification, 'pending');
  assert.equal(result.published, true);
  assert.equal(result.digest, 'sha256:' + 'a'.repeat(64));
  assert.equal(result.sourceRevision, sha);
  assert.equal(result.imageId, null);
});

test('each script runs when started through a symlink, as a macOS temporary path is', async t => {
  const directory = await scratch(t);
  const start = async (name, args) => {
    const link = path.join(directory, name.replaceAll('/', '-'));
    await symlink(fileURLToPath(new URL(`../${name}`, import.meta.url)), link);
    return spawnSync(process.execPath, [link, ...args], { encoding: 'utf8' });
  };
  assert.match((await start('scripts/docker-build.mjs', ['--help'])).stdout, /docker-build\.mjs/);
  assert.notEqual((await start('scripts/docker-smoke.mjs', ['--help'])).stdout, '');
  assert.notEqual((await start('docker/qrc-smoke.mjs', ['--unknown-option'])).status, 0);
});
