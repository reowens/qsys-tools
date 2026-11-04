// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const CONTEXT_FILES = Object.freeze(['Dockerfile', '.dockerignore', 'entrypoint.sh', 'dpkg-deb.py', 'smoke.py', 'qrc-smoke.mjs', 'execution.py', 'qemu-shim.py', 'qemu-pin.json', 'wine-procmem.c', 'image-receipt.schema.json', 'qsys-linux.tgz', 'qsys-qrc.tgz']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fullRevision = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const sourceFiles = [
  'LICENSE', 'tsconfig.json',
  'packages/qsys-linux/package.json', 'packages/qsys-linux/README.md', 'packages/qsys-linux/CHANGELOG.md',
  'packages/qsys-linux/bin/qsys-linux.mjs', 'packages/qsys-linux/lib/launcher.mjs',
  'packages/qsys-linux/lib/qsys_linux.py', 'packages/qsys-linux/scripts/build.mjs',
  'packages/qsys-qrc/package.json', 'packages/qsys-qrc/README.md', 'packages/qsys-qrc/CHANGELOG.md',
  'packages/qsys-qrc/LICENSE', 'packages/qsys-qrc/tsconfig.build.json',
  'packages/qsys-mac-installer/lib/assemble-msi.py', 'packages/qsys-mac-installer/lib/rename-font-family.py',
];
const sourceAllowed = name => sourceFiles.includes(name)
  || /^packages\/qsys-qrc\/src\/[\w./-]+\.ts$/.test(name)
  || /^packages\/qsys-mac-installer\/assets\/fonts\/selawik\/(?:LICENSE.txt|selawk[bls]*\.ttf)$/.test(name)
  || (name.startsWith('packages/qsys-linux/docker/') && CONTEXT_FILES.includes(name.slice('packages/qsys-linux/docker/'.length)) && !name.endsWith('.tgz'));

async function command(executable, args, options = {}) {
  try { return await exec(executable, args, { maxBuffer: 16 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(`${executable} ${args[0]} failed: ${error.stderr || error.message}`, { cause: error }); }
}
async function regularFile(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular file, refusing symlink/directory: ${filename}`);
}
export async function validateContext(directory) {
  const entries = await readdir(directory);
  for (const name of entries) {
    if (!CONTEXT_FILES.includes(name)) throw new Error(`Build context contains non-allowlisted entry: ${name}`);
    await regularFile(path.join(directory, name));
  }
  for (const name of CONTEXT_FILES.filter(n => n !== 'image-receipt.schema.json')) {
    if (!entries.includes(name)) throw new Error(`Build context missing ${name}`);
  }
  return Object.fromEntries(await Promise.all(entries.sort().map(async name => [name, sha256(await readFile(path.join(directory, name)))])));
}
export function publicationOptions(options = {}) {
  const { push = false, development = false, revision, registry, cache } = options;
  if (typeof push !== 'boolean' || typeof development !== 'boolean') throw new Error('push and development must be booleans');
  if (development && revision) throw new Error('Development mode cannot claim a source revision');
  if (push && (development || !fullRevision.test(revision || ''))) throw new Error('Publication requires an explicit full committed revision; development is local-only');
  if (push && !options.receipt) throw new Error('Publication requires a receipt output path');
  if (cache && (!push || development)) throw new Error('Registry cache is available only for explicit frozen publication');
  if (registry && (!/^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*$/.test(registry))) throw new Error('Invalid registry/repository prefix');
  let image = options.image || (push ? 'qsys-designer-test' : 'qsys-designer-test:local');
  if (registry) image = `${registry}/${image}`;
  if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(image) || image.includes('@') || image.startsWith('-') || image.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid image name');
  if (push) {
    if (!registry && !/^(?:[^/]*[.:][^/]*|localhost)\//.test(image)) throw new Error('Publication requires an explicit registry');
    const last = image.split('/').at(-1);
    if (last.includes(':')) {
      if (!image.endsWith(`:${revision}`)) throw new Error('Published image tag must equal the full revision');
    } else image += `:${revision}`;
  }
  if (cache && (!/^[a-z0-9][a-z0-9._:/-]*$/.test(cache) || cache === image)) throw new Error('Invalid or conflicting registry cache reference');
  const repository = reference => reference.replace(/:[^/:]+$/, '');
  if (cache && (repository(cache) === repository(image) || /:[0-9a-f]{40}$/i.test(cache))) throw new Error('Cache must use a separate repository and cannot use a revision tag');
  return { ...options, push, development, image };
}

// Missing is cold; connectivity/auth/permission errors must not authorize overwrites.
export async function manifestExists(docker, args, reference) {
  try { await command(docker, [...args, 'buildx', 'imagetools', 'inspect', reference, '--raw']); return true; }
  catch (error) {
    const missingReference = (error.cause?.stderr || '').split('\n').some(line => line.trim() === `ERROR: ${reference}: not found` || line.trim() === `${reference}: not found`);
    if ((missingReference || /manifest unknown|name unknown|manifest[^\n]*not found|not found[^\n]*manifest/i.test(error.message))
      && !/unauthorized|denied|forbidden|authentication|\b40[13]\b/i.test(error.message)) return false;
    throw error;
  }
}

async function writeReceipt(filename, result) {
  if (!filename) return;
  const output = path.resolve(filename);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
}

export async function assertUnpublished(docker, args, image) {
  if (await manifestExists(docker, args, image)) throw new Error(`Immutable tag already exists; refusing publication: ${image}`);
}

export async function stageSource(scratch, options) {
  const source = path.join(scratch, 'source');
  await mkdir(source);
  let sourceRevision = null;
  if (!options.development) {
    sourceRevision = (await command('git', ['rev-parse', '--verify', `${options.revision || 'HEAD'}^{commit}`], { cwd: repo })).stdout.trim();
    if (!fullRevision.test(sourceRevision)) throw new Error('Expected full Git commit SHA');
    if (options.push && sourceRevision !== options.revision) throw new Error('Publication revision must be the exact commit SHA');
    const names = (await command('git', ['ls-tree', '-r', '--name-only', sourceRevision], { cwd: repo })).stdout.trim().split('\n').filter(sourceAllowed);
    const archive = path.join(scratch, 'source.tar');
    await command('git', ['archive', '--format=tar', `--output=${archive}`, sourceRevision, '--', ...names], { cwd: repo });
    await command('tar', ['-xf', archive, '-C', source]);
  } else {
    const names = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repo })).stdout.trim().split('\n').filter(sourceAllowed);
    for (const name of names) {
      await regularFile(path.join(repo, name));
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await copyFile(path.join(repo, name), path.join(source, name));
    }
  }
  return { source, sourceRevision };
}

export async function packPackages(source, context) {
  // Compiler/dependencies come from the operator's installed, lockfile-managed checkout.
  // No dependency installation, registry login, or lifecycle hook runs implicitly.
  await symlink(path.join(repo, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  await command(process.execPath, ['scripts/build.mjs'], { cwd: path.join(source, 'packages/qsys-linux') });
  await command(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: path.join(source, 'packages/qsys-qrc') });
  for (const name of ['qsys-linux', 'qsys-qrc']) {
    const directory = path.join(source, 'packages', name);
    const { stdout } = await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', context], { cwd: directory });
    const [packed] = JSON.parse(stdout);
    const required = name === 'qsys-linux'
      ? ['bin/qsys-linux.mjs', 'lib/qsys_linux.py', 'lib/support/assemble-msi.py', 'lib/support/fonts/LICENSE.txt']
      : ['dist/index.js', 'dist/qrc.js', 'dist/index.d.ts'];
    for (const file of required) if (!packed.files.some(entry => entry.path === file)) throw new Error(`${name} package missing ${file}`);
    await rename(path.join(context, packed.filename), path.join(context, `${name}.tgz`));
  }
  return (await command(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '--version'])).stdout.trim();
}

/** Build only on explicit invocation. context is a Docker context NAME, never a source directory.
 * development:true opts into working-tree inputs; otherwise archive revision (default HEAD).
 * push:true is operator authorization, requires full revision + receipt, and uses no Depot route.
 */
export async function buildImage(input = {}) {
  const options = publicationOptions(input);
  const { image, development, push, docker = 'docker', context, cache } = options;
  const dockerArgs = context ? ['--context', context] : [];
  const scratch = await mkdtemp(path.join(tmpdir(), 'qsys-image-build-'));
  try {
    const { source, sourceRevision } = await stageSource(scratch, options);
    const directory = path.join(scratch, 'context');
    await mkdir(directory);
    for (const name of CONTEXT_FILES.filter(n => !n.endsWith('.tgz'))) {
      const filename = path.join(source, 'packages/qsys-linux/docker', name);
      try { await regularFile(filename); await copyFile(filename, path.join(directory, name)); }
      catch (error) { if (name === 'image-receipt.schema.json' && error.code === 'ENOENT') continue; throw error; }
    }
    // Reject symlinks from committed archives before executing source build helpers.
    async function checkTree(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const filename = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Source symlink refused: ${filename}`);
        if (entry.isDirectory()) await checkTree(filename);
        else await regularFile(filename);
      }
    }
    await checkTree(source);
    const compiler = await packPackages(source, directory);
    const inputs = await validateContext(directory);
    const dockerfile = await readFile(path.join(directory, 'Dockerfile'), 'utf8');
    const bases = [...dockerfile.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gmi)].map(m => m[1]);
    if (!bases.length || bases.some(base => !/@sha256:[a-f0-9]{64}$/.test(base))) throw new Error('Every Dockerfile base must be digest-pinned');
    const contextSha256 = sha256(JSON.stringify(inputs));
    if (push) await assertUnpublished(docker, dockerArgs, image);
    const metadataPath = path.join(scratch, 'metadata.json');
    const args = [...dockerArgs, 'buildx', 'build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '--metadata-file', metadataPath,
      '--label', `org.opencontainers.image.revision=${sourceRevision || 'local'}`,
      '--label', 'org.opencontainers.image.source=https://github.com/reowens/qsys-tools',
      '--label', `io.qsys.source.mode=${development ? 'development' : 'committed'}`,
      '--label', `io.qsys.source.context-sha256=${contextSha256}`,
      '--label', `io.qsys.base.references=${bases.join(',')}`,
      '--label', `io.qsys.package.linux-sha256=${inputs['qsys-linux.tgz']}`,
      '--label', `io.qsys.package.qrc-sha256=${inputs['qsys-qrc.tgz']}`,
      '--build-arg', `SOURCE_REVISION=${sourceRevision || 'local'}`,
      '--tag', image];
    if (cache) {
      if (await manifestExists(docker, dockerArgs, cache)) args.push('--cache-from', `type=registry,ref=${cache}`);
      args.push('--cache-to', `type=registry,ref=${cache},mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true`);
    }
    args.push(push ? '--push' : '--load', directory);
    // Recheck immediately before publication; registry-side immutable tags are still required
    // to close races between independent publishers (Docker offers no conditional push).
    if (push) await assertUnpublished(docker, dockerArgs, image);
    await command(docker, args, { env: { ...process.env, BUILDX_NO_DEFAULT_ATTESTATIONS: '1' } });
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    let digest = metadata['containerimage.digest'];
    let reference = image;
    if (push) {
      if (!digestPattern.test(digest || '')) throw new Error('Build returned no valid publication digest');
      reference = `${image.slice(0, image.lastIndexOf(':'))}@${digest}`;
      // Publication has happened. Preserve its identity even if a later registry
      // read/pull fails; retries must not overwrite the immutable revision tag.
      console.error(`Published ${reference}; verification pending`);
      await writeReceipt(options.receipt, {
        schemaVersion: 1, image, reference, digest, digestKind: 'manifest',
        imageId: null, verification: 'pending', sourceRevision, sourceMode: 'committed',
        published: true, platform: 'linux/amd64', contextSha256, inputs, bases,
        compiler, createdAt: new Date().toISOString(),
      });
      const manifest = JSON.parse((await command(docker, [...dockerArgs, 'buildx', 'imagetools', 'inspect', reference, '--raw'])).stdout);
      if (!['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(manifest.mediaType) || manifest.manifests) throw new Error('Publication did not produce a plain single-platform manifest');
      await command(docker, [...dockerArgs, 'pull', '--platform', 'linux/amd64', reference]);
    }
    const [inspection] = JSON.parse((await command(docker, [...dockerArgs, 'image', 'inspect', reference])).stdout);
    if (inspection.Os !== 'linux' || inspection.Architecture !== 'amd64') throw new Error('Built image is not linux/amd64');
    const labels = inspection.Config?.Labels || {};
    if (labels['org.opencontainers.image.revision'] !== (sourceRevision || 'local') || labels['io.qsys.source.context-sha256'] !== contextSha256) throw new Error('Built image source labels do not match inputs');
    if (!digestPattern.test(inspection.Id || '')) throw new Error('Invalid image ID');
    if (!push) digest = inspection.Id;
    const result = { schemaVersion: 1, image, reference, digest, digestKind: push ? 'manifest' : 'image-id', imageId: inspection.Id,
      sourceRevision, sourceMode: development ? 'development' : 'committed', published: push, verification: 'verified', platform: 'linux/amd64',
      contextSha256, inputs, bases, compiler, createdAt: new Date().toISOString() };
    await writeReceipt(options.receipt, result);
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function main() {
  const options = {};
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === '--push') options.push = true;
    else if (flag === '--development') options.development = true;
    else if (['--revision', '--image', '--registry', '--cache', '--docker', '--context', '--receipt'].includes(flag)) {
      if (!args.length || args[0].startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = args.shift();
    } else if (flag === '--help') {
      console.log('docker-build.mjs [--development | --revision SHA] [--image NAME] [--docker EXE] [--context NAME] [--receipt FILE]\nPublish: --push --revision FULL_SHA --registry HOST[/PREFIX] --receipt FILE [--cache REFERENCE]\nDefault: frozen HEAD, local qsys-designer-test:local; builds require installed TypeScript dependencies.');
      return;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  console.log(JSON.stringify(await buildImage(options), null, 2));
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
