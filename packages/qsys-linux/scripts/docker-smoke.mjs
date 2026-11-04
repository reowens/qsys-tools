#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
import { spawn } from 'node:child_process';
import { constants, createReadStream, realpathSync } from 'node:fs';
import { access, chmod, link, lstat, mkdir, open, readFile, readdir, realpath, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GiB = 1024 ** 3;
const label = 'io.qsys.docker-smoke.run';
const platform = 'linux/amd64';
const cacheLabel = 'io.qsys.docker-smoke.cache';
export const QEMU_PIN = JSON.parse(await readFile(new URL('../docker/qemu-pin.json', import.meta.url), 'utf8'));
const help = `Usage: node docker-smoke.mjs --installer <file.zip|file.exe> [options]
  --image <ref>       Existing local image (default qsys-designer-test:local)
  --docker <exe>      Existing Docker CLI (default docker, Docker.app fallback on Mac)
  --context <name>    Existing Docker context (default current context)
  --design <file>     Optional private .qsys fixture
  --artifacts <dir>   Empty output directory (default private system temp directory)
  --profile <name>    basic (default) or full
  --execution <mode> native (default, amd64 engine) or hybrid-qemu (ARM64 engine)
  --emulator <file>   Qualified ARM64 QEMU binary for hybrid-qemu (checksum pinned)
  --cache-volume <name>  Retain verified runtime downloads in a labeled volume
  --memory <size>     Container memory budget (default 8g)
  --cpus <number>     Container CPU budget (default 4)
  --shm-size <size>   Private shared memory (default 1g)
  --docker-data-dir <dir>  Actual Docker disk-image filesystem on a local Mac
  --host-free-floor <size> Mac Docker disk host free-space floor (default 40g)
No image pull/build/push, context creation, or daemon settings changes are performed.
Artifacts may contain private inputs. Remote-context execution is not local Mac parity.
`;

export function parseArgs(argv) {
  const result = {};
  const names = new Set(['image', 'docker', 'context', 'installer', 'design', 'artifacts', 'profile', 'execution', 'emulator', 'cache-volume', 'memory', 'cpus', 'shm-size', 'docker-data-dir', 'host-free-floor']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { help: true };
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !names.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${argv[i]}`);
    const key = { 'shm-size': 'shmSize', 'docker-data-dir': 'dockerDataDir', 'host-free-floor': 'hostFreeFloor', 'cache-volume': 'cacheVolume' }[name] || name;
    if (Object.hasOwn(result, key)) throw new Error(`Repeated option: ${argv[i]}`);
    result[key] = argv[++i];
  }
  return result;
}

export function bytes(value) {
  const match = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec(String(value));
  if (!match) throw new Error(`Invalid byte size: ${value} (use b, k, m, or g)`);
  const result = Number(match[1]) * 1024 ** Math.max(0, 'bkmg'.indexOf((match[2] || 'b').toLowerCase()));
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid byte size: ${value}`);
  return result;
}

async function hostJson(filename, value) {
  // Container exports never share this namespace. Refuse pre-existing files
  // and symlinks even if another local process races the initial empty check.
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); }
  finally { await handle.close(); }
}

async function checkDirectoryPath(directory) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe artifacts directory path component: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Python's dir_fd operations supply portable openat semantics on macOS, where
// /dev/fd/N cannot be traversed as a directory. No host path from the container
// is accepted here. All names are private runner-owned relative paths.
const artifactScript = String.raw`
import os,sys,json,stat,uuid
r=json.load(sys.stdin);action=r['action'];root=3
def child(fd,name):return os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
def write(fd,name,value):
 f=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 with os.fdopen(f,'w',encoding='utf-8',errors='replace') as o:o.write(value);o.flush();os.fsync(o.fileno())
if action=='init':
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for name in r['path'].split('/'):
   if not name:continue
   try:following=child(fd,name)
   except FileNotFoundError:
    try:os.mkdir(name,0o700,dir_fd=fd)
    except FileExistsError:pass
    following=child(fd,name)
   os.close(fd);fd=following
  if os.listdir(fd):raise ValueError('Artifacts directory must be empty')
  if os.fstat(fd).st_uid!=os.geteuid():raise PermissionError('Artifacts directory must be owned by the current user')
  os.fchmod(fd,0o700)
  info=os.fstat(fd);print(json.dumps({'dev':info.st_dev,'ino':info.st_ino}))
 finally:os.close(fd)
elif action=='append':
 fd=4;temporary='.snapshot-'+uuid.uuid4().hex
 try:
  write(fd,temporary,json.dumps(r['value'],indent=2)+'\n')
  os.link(temporary,r['name'],src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False);os.fsync(fd)
 finally:
  try:os.unlink(temporary,dir_fd=fd)
  except FileNotFoundError:pass
elif action=='write':write(root,r['name'],r['value'])
elif action=='mkdir':
 os.mkdir(r['name'],0o700,dir_fd=root)
 fd=child(root,r['name'])
 try:
  info=os.fstat(fd);print(json.dumps({'dev':info.st_dev,'ino':info.st_ino}))
 finally:os.close(fd)
elif action=='read':
 fd=os.dup(root)
 try:
  parts=r['name'].split('/')
  for part in parts[:-1]:
   following=child(fd,part);os.close(fd);fd=following
  f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
  with os.fdopen(f,encoding='utf-8') as source:
   info=os.fstat(source.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_size>16*1024**2:raise ValueError('Invalid receipt file')
   print(json.dumps(json.load(source)))
 finally:os.close(fd)
elif action=='validate':
 def walk(fd):
  for name in os.listdir(fd):
   info=os.stat(name,dir_fd=fd,follow_symlinks=False)
   if stat.S_ISDIR(info.st_mode):
    f=child(fd,name)
    try:walk(f)
    finally:os.close(f)
   elif not stat.S_ISREG(info.st_mode):raise ValueError('Unsafe exported artifact: '+name)
 fd=child(root,'container')
 try:walk(fd)
 finally:os.close(fd)
else:raise ValueError('Unknown artifact operation')
`;

async function artifactOperation(action, data = {}, rootFd, journalFd) {
  const input = (async function* () { yield Buffer.from(JSON.stringify({ action, ...data })); })();
  try {
    const result = await command('python3', ['-I', '-X', 'utf8', '-c', artifactScript], { input, artifactFd: rootFd, journalFd, timeout: 30000, outputLimit: 64 * 1024 * 1024, strictOutput: true });
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  } catch (error) {
    const detail = (error.stderr || error.message).trim().split('\n').filter(Boolean).at(-1);
    throw new Error(`Artifact ${action} failed: ${detail}`, { cause: error });
  }
}

// Private host-only snapshots. Publish a fully synced inode with an exclusive
// hard link: readers see complete JSON, and an existing sequence is never replaced.
export async function journalWriter(artifacts, initialized) {
  const directories = [];
  for (let current = path.parse(artifacts).root, parts = artifacts.slice(current.length).split(path.sep), i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe artifacts directory path component: ${current}`);
    directories.push({ filename: current, dev: info.dev, ino: info.ino });
  }
  const check = async () => {
    for (const directory of directories) {
      const info = await lstat(directory.filename);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== directory.dev || info.ino !== directory.ino) throw new Error('Artifacts namespace changed');
    }
  };
  await check();
  const root = await open(artifacts, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const rootInfo = await root.stat();
  if (rootInfo.dev !== initialized.dev || rootInfo.ino !== initialized.ino || rootInfo.dev !== directories.at(-1).dev || rootInfo.ino !== directories.at(-1).ino) { await root.close(); throw new Error('Artifacts namespace changed'); }
  const portable = process.platform !== 'linux';
  const output = portable ? artifacts : `/proc/${process.pid}/fd/${root.fd}`;
  const directory = path.join(artifacts, 'journal');
  try {
    const created = portable ? await artifactOperation('mkdir', { name: 'journal' }, root.fd) : undefined;
    if (!portable) await mkdir(path.join(output, 'journal'), { mode: 0o700 }); // Exclusive claim, including concurrent callers.
    await root.sync();
    const handle = await open(path.join(output, 'journal'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (created && (info.dev !== created.dev || info.ino !== created.ino)) { await handle.close(); throw new Error('Artifacts namespace changed'); }
    directories.push({ filename: directory, dev: info.dev, ino: info.ino });
    // Anchor publication to the opened directory even during a path replacement.
    const anchor = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : `/dev/fd/${handle.fd}`;
    let sequence = 0;
    return {
      output, rootFd: root.fd, check,
      async write(name, value) {
        await check();
        if (portable) await artifactOperation('write', { name, value }, root.fd);
        else await writeFile(path.join(output, name), value, { mode: 0o600, flag: 'wx' });
      },
      async json(name, value) {
        await check();
        if (portable) await artifactOperation('write', { name, value: JSON.stringify(value, null, 2) + '\n' }, root.fd);
        else await hostJson(path.join(output, name), value);
      },
      async read(name) {
        await check();
        return portable ? artifactOperation('read', { name }, root.fd) : readJson(path.join(output, name));
      },
      async mkdir(name) {
        await check();
        if (portable) await artifactOperation('mkdir', { name }, root.fd);
        else await mkdir(path.join(output, name), { mode: 0o700 });
      },
      async validate() {
        await check();
        if (portable) await artifactOperation('validate', {}, root.fd);
        else await validateExport(path.join(output, 'container'));
      },
      close: async () => { try { await handle.close(); } finally { await root.close(); } },
      async append(value) {
        await check();
        const next = ++sequence;
        if (portable) {
          await artifactOperation('append', { name: `${String(next).padStart(6, '0')}.json`, value: { ...value, sequence: next } }, root.fd, handle.fd);
          await check();
          return;
        }
        const temporary = path.join(anchor, `.snapshot-${randomUUID()}`);
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          if (!(await file.stat()).isFile()) throw new Error('Journal snapshot must be a regular file');
          await file.writeFile(JSON.stringify({ ...value, sequence: next }, null, 2) + '\n');
          await file.sync();
        } finally { await file.close(); }
        try {
          await check();
          await link(temporary, path.join(anchor, `${String(next).padStart(6, '0')}.json`));
          await handle.sync();
        } finally { await unlink(temporary); }
        await check();
      },
    };
  } catch (error) { await root.close(); throw error; }
}

async function validateExport(directory) {
  for (const name of await readdir(directory)) {
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Unsafe exported artifact: ${filename}`);
    if (info.isDirectory()) await validateExport(filename);
  }
}

async function readJson(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Result must be a regular JSON file of at most 16 MiB');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function readResult(filename, reader = readJson) {
    const result = await reader(filename);
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(result) || result.schemaVersion !== 1 || !['passed', 'failed', 'incomplete'].includes(result.status)
      || !Array.isArray(result.cases) || result.cases.some(item => !object(item) || typeof item.name !== 'string' || !['passed', 'failed', 'skipped'].includes(item.status))
      || !object(result.versions) || !object(result.timings) || !object(result.artifacts)) throw new Error('Invalid result.json schema');
    return result;
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function dockerBinary(explicit) {
  const name = explicit || 'docker';
  if (name.includes('/') || path.isAbsolute(name)) { const resolved = path.resolve(name); await access(resolved, constants.X_OK); return resolved; }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.resolve(dir || '.', name);
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  const fallback = '/Applications/Docker.app/Contents/Resources/bin/docker';
  if (process.platform === 'darwin' && name === 'docker') {
    try { await access(fallback, constants.X_OK); return fallback; } catch {}
  }
  throw new Error('Docker CLI not found. Supply --docker <existing executable>.');
}

// A small USTAR stream with fixed destination names: no shell, host tar, directory
// recursion, or host paths reach the daemon. Ownership matches the image's qsys user.
export async function* inputTar(files) {
  for (const file of files) {
    const handle = await open(file.source, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`Not a regular input file: ${file.source}`);
      if (info.size > 0o77777777777) throw new Error('Input exceeds USTAR size limit');
      const header = Buffer.alloc(512);
      const octal = (value, offset, width) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
      header.write(file.name, 0, 100, 'utf8');
      octal(file.mode || 0o400, 100, 8); octal(1000, 108, 8); octal(1000, 116, 8);
      octal(info.size, 124, 12); octal(Math.floor(info.mtimeMs / 1000), 136, 12);
      header.fill(32, 148, 156); header[156] = 48;
      header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2);
      const sum = header.reduce((total, byte) => total + byte, 0);
      header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      yield header;
      let copied = 0;
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) { copied += chunk.length; hash.update(chunk); yield chunk; }
      if (copied !== info.size) throw new Error(`Input changed while staging: ${file.source}`);
      if (file.sha256 && hash.digest('hex') !== file.sha256) throw new Error(`Input checksum changed while staging: ${file.source}`);
      if (info.size % 512) yield Buffer.alloc(512 - info.size % 512);
    } finally { await handle.close(); }
  }
  yield Buffer.alloc(1024);
}

export function command(executable, args, { input, signal, timeout = 60000, allowFailure = false, artifactFd, journalFd, outputLimit = 4 * 1024 * 1024, strictOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    // Keep foreground Ctrl-C away from Docker's signal proxy. Cancellation kills
    // this CLI group without forwarding; finally sends the one container stop.
    const description = path.basename(executable).startsWith('python') && args.includes('-c') ? 'Python artifact helper' : `Docker ${args.join(' ')}`;
    const child = spawn(executable, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe', ...(artifactFd === undefined ? [] : [artifactFd]), ...(journalFd === undefined ? [] : [journalFd])] });
    let stdout = '', stderr = '', inputError, outputBytes = 0;
    const outputChunks = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (strictOutput) {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > outputLimit) { inputError ||= new Error(`${description} output exceeds ${outputLimit} bytes`); stop(); }
        else outputChunks.push(chunk);
      } else stdout = (stdout + chunk).slice(-outputLimit);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    let killedByTimeout = false;
    const stop = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const timer = timeout ? setTimeout(() => { killedByTimeout = true; stop(); }, timeout) : undefined;
    signal?.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', error => { inputError ??= error; });
    (async () => {
      try {
        if (input) for await (const chunk of input) {
          if (child.stdin.destroyed) throw new Error('Docker closed the staging stream');
          if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
        }
        child.stdin.end();
      } catch (error) { inputError = error; stop(); }
    })();
    child.once('error', finish);
    child.once('close', (code, sig) => finish(null, code, sig));
    let finished = false;
    function finish(error, code, sig) {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(signal.reason);
      if (error || inputError || killedByTimeout || (code !== 0 && !allowFailure)) {
        const failure = error || inputError || new Error(`${description} ${killedByTimeout ? 'timed out' : `failed (${code ?? sig})`}: ${stderr.trim()}`);
        failure.stderr = stderr;
        return reject(failure);
      }
      resolve({ stdout: strictOutput ? outputChunks.join('') : stdout, stderr, code });
    }
  });
}

// Only the daemon's tar bytes reach the extractor. Docker never receives a host
// destination pathname; every extraction open is relative to the inherited fd.
export async function streamArtifacts(docker, prefix, container, rootFd, { timeout = 60000 } = {}) {
  const helper = fileURLToPath(new URL('./artifact-extract.py', import.meta.url));
  const children = [];
  let timedOut = false;
  let spawnError;
  const kill = (targets = children) => {
    for (const child of targets) if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    }
  };
  const launch = (executable, args, stdio) => {
    const child = spawn(executable, args, { detached: true, stdio });
    children.push(child);
    let stderr = '', stdout = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-16384); });
    const done = new Promise((resolve, reject) => {
      child.once('error', error => { spawnError ||= error; kill(); reject(error); });
      child.once('close', (code, signal) => {
        if (code !== 0) {
          const error = new Error(`${path.basename(executable)} artifact stream failed (${code ?? signal}): ${stderr.trim()}`);
          error.signal = signal;
          reject(error);
        }
        else resolve(stdout);
      });
    });
    done.catch(() => {}); // A later synchronous spawn failure still reaps this child.
    return { child, done, capture() { child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout = (stdout + value).slice(-4096); }); } };
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
  try {
    const consumer = launch('python3', ['-I', '-X', 'utf8', helper], ['pipe', 'pipe', 'pipe', rootFd]);
    consumer.capture();
    const producer = launch(docker, [...prefix, 'cp', `${container}:/artifacts/.`, '-'], ['ignore', 'pipe', 'pipe']);
    // A rejected extractor closes stdin before its close event. Kill only the
    // producer on EPIPE so the extractor can finish reporting its real error.
    consumer.done.catch(() => kill([producer.child]));
    const transfer = pipeline(producer.child.stdout, consumer.child.stdin).catch(error => { kill([producer.child]); throw error; });
    const results = await Promise.allSettled([producer.done, consumer.done, transfer]);
    if (timedOut) throw new Error('Artifact stream export timed out');
    if (spawnError) throw spawnError;
    // Natural exits precede secondary kills, with the extractor first. A
    // producer's real nonzero exit still fails an otherwise valid archive.
    const rejected = [results[1], results[0]].filter(result => result.status === 'rejected');
    for (const result of [...rejected.filter(result => !result.reason.signal), ...rejected, results[2]]) {
      if (result.status === 'rejected') throw result.reason;
    }
    return JSON.parse(results[1].value);
  } finally { clearTimeout(timer); kill(); }
}

export async function runSmoke(options = {}) {
  const id = randomUUID();
  const opts = { image: 'qsys-designer-test:local', profile: 'basic', execution: 'native', memory: '8g', cpus: '4', shmSize: '1g', ...options };
  if (typeof opts.image !== 'string' || !opts.image || opts.image.startsWith('-')) throw new Error('Invalid --image reference');
  if (!['basic', 'full'].includes(opts.profile)) throw new Error('--profile must be basic or full');
  if (!['native', 'hybrid-qemu'].includes(opts.execution)) throw new Error('--execution must be native or hybrid-qemu');
  if ((opts.execution === 'hybrid-qemu') !== Boolean(opts.emulator)) throw new Error('hybrid-qemu requires --emulator; native execution does not use an emulator');
  if (opts.cacheVolume && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(opts.cacheVolume)) throw new Error('Invalid --cache-volume name');
  const memory = bytes(opts.memory), shm = bytes(opts.shmSize), cpus = Number(opts.cpus);
  if (!Number.isFinite(cpus) || cpus <= 0) throw new Error('--cpus must be positive');
  if (shm >= memory) throw new Error('--shm-size must be smaller than --memory');
  if (!opts.installer || !/\.(zip|exe)$/i.test(opts.installer)) throw new Error('--installer requires a local .zip or .exe file');
  const files = [{ source: path.resolve(opts.installer), name: /\.exe$/i.test(opts.installer) ? 'installer.exe' : 'installer.zip' }];
  if (opts.design) files.push({ source: path.resolve(opts.design), name: 'design.qsys' });
  if (opts.emulator) files.push({ source: path.resolve(opts.emulator), name: 'qemu-x86_64', mode: 0o500 });
  let inputBytes = 0;
  for (const file of files) {
    const info = await stat(file.source);
    if (!info.isFile()) throw new Error(`Not a regular file: ${file.source}`);
    inputBytes += info.size;
    file.sha256 = await hashFile(file.source);
    if (file.name === 'qemu-x86_64' && file.sha256 !== QEMU_PIN.sha256) throw new Error('QEMU checksum does not match the qualified pin');
  }
  let artifacts = path.resolve(opts.artifacts || path.join(tmpdir(), `qsys-docker-artifacts-${id}`));
  // The caller-configured temp root may itself be a system/user alias (e.g.
  // an external temporary disk). Resolve that root once, while still refusing
  // arbitrary symlinks beneath it or elsewhere in an explicit output path.
  const tempRoot = path.resolve(tmpdir());
  if (artifacts.startsWith(tempRoot + path.sep)) artifacts = path.join(await realpath(tempRoot), path.relative(tempRoot, artifacts));
  // Resolve only Apple's system aliases, not arbitrary caller-owned symlinks.
  if (process.platform === 'darwin') for (const alias of ['/var', '/tmp']) {
    if (artifacts === alias || artifacts.startsWith(alias + '/')) {
      const canonical = await realpath(alias);
      if (canonical !== '/private' + alias) throw new Error('Unexpected macOS system path alias');
      artifacts = canonical + artifacts.slice(alias.length);
    }
  }
  await checkDirectoryPath(artifacts);
  try { await command('python3', ['-I', '-X', 'utf8', '-c', 'import os,json,uuid; assert hasattr(os,"O_NOFOLLOW"); print("ready")'], { timeout: 15000 }); }
  catch (error) { throw new Error(`A working host python3 with isolated-mode support is required; install/configure Python 3 (including command-line tools if needed). ${error.code || (error.stderr || error.message).trim().split('\n').at(-1)}`, { cause: error }); }
  const initialized = await artifactOperation('init', { path: artifacts });
  await checkDirectoryPath(artifacts);
  const hostDisk = await statfs(artifacts);
  if (hostDisk.bavail * hostDisk.bsize < GiB) throw new Error('Artifact filesystem requires at least 1 GiB free');
  const docker = await dockerBinary(opts.docker);
  const journal = await journalWriter(artifacts, initialized);
  try {
    // FileHandle.chmod anchors permissions on every platform.
    const permissions = await open(artifacts, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { const info = await permissions.stat(); if (info.dev !== initialized.dev || info.ino !== initialized.ino) throw new Error('Artifacts namespace changed'); await permissions.chmod(0o700); }
    finally { await permissions.close(); }
    const controller = new AbortController();
    let signalName;
    const onSignal = name => { signalName = name; controller.abort(new Error(`Interrupted by ${name}`)); };
    const sigint = () => onSignal('SIGINT'), sigterm = () => onSignal('SIGTERM'), sighup = () => onSignal('SIGHUP');
    process.on('SIGINT', sigint); process.on('SIGTERM', sigterm); process.on('SIGHUP', sighup);
    let context, testContainer, cacheLease, mainError, result, exported = false;
    const owned = [];
    const cleanupErrors = [];
    const receipt = { schemaVersion: 1, runId: id, invokingPlatform: process.platform, invokingArch: process.arch, image: opts.image, platform, artifacts, execution: { mode: opts.execution }, inputs: Object.fromEntries(files.map(file => [file.name, file.sha256])), startedAt: new Date().toISOString(), budget: { memory, cpus, shm }, localMacParity: 'limited to recorded container cases; no native macOS or host desktop acceptance' };
    const call = (args, settings = {}) => command(docker, [...(context ? ['--context', context] : []), ...args], { signal: controller.signal, ...settings });
    const resources = [];
    const snapshot = (phase, state = 'incomplete') => journal.append({
      schemaVersion: 1, runId: id, state, phase, context: context || opts.context || null,
      dockerEndpoint: receipt.dockerEndpoint || null, image: opts.image, imageId: receipt.imageId || null,
      inputs: receipt.inputs, resources, errors: [...(mainError ? [mainError.message] : []), ...cleanupErrors],
    });
    async function createContainer(role, argv, fixedName) {
      const name = fixedName || `qsys-smoke-${id}-${role}`;
      // Track before creation: an interrupted CLI can leave an accepted daemon resource.
      owned.push({ type: 'container', name });
      let resource = resources.find(item => item.type === 'container' && item.name === name);
      if (!resource) { resource = { type: 'container', role, name, state: 'intended' }; resources.push(resource); }
      await snapshot(`allocate-${role}`);
      await call(['create', '--name', name, '--label', `${label}=${id}`, '--platform', platform, '--pull', 'never', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '2048', '--memory', String(memory), '--cpus', String(cpus), '--shm-size', String(shm), ...argv]);
      resource.state = 'acquired';
      await snapshot(`acquired-${role}`);
      return name;
    }
    try {
      await snapshot('starting');
      context = opts.context || (await call(['context', 'show'])).stdout.trim();
      if (!context) throw new Error('No current Docker context; supply --context <existing context>');
      const contextData = JSON.parse((await call(['context', 'inspect', context])).stdout)[0];
      receipt.context = context;
      receipt.dockerEndpoint = contextData.Endpoints?.docker?.Host;
      await snapshot('context-known');
      const info = JSON.parse((await call(['info', '--format', '{{json .}}'])).stdout);
      receipt.engine = { name: info.Name, os: info.OSType, arch: info.Architecture, memory: info.MemTotal, cpus: info.NCPU, version: info.ServerVersion };
      if (process.platform === 'darwin' && receipt.dockerEndpoint?.startsWith('unix:')) {
        if (!opts.dockerDataDir) throw new Error('Local Mac runs require --docker-data-dir pointing to the actual Docker disk-image directory; VM free space alone is insufficient.');
        const disk = await statfs(path.resolve(opts.dockerDataDir));
        const available = disk.bavail * disk.bsize;
        const required = Math.max(bytes(opts.hostFreeFloor || '40g'), 12 * GiB + inputBytes * 2 + GiB);
        receipt.hostDockerDisk = { directory: path.resolve(opts.dockerDataDir), available, required };
        if (available < required) throw new Error(`Mac Docker disk host filesystem requires ${required} free bytes; found ${available}`);
      }
      if (info.OSType !== 'linux') throw new Error('A Linux Docker engine is required');
      if (!['amd64', 'x86_64', 'arm64', 'aarch64'].includes(info.Architecture)) throw new Error(`Unsupported engine architecture: ${info.Architecture}`);
      const arm = ['arm64', 'aarch64'].includes(info.Architecture);
      if (arm !== (opts.execution === 'hybrid-qemu')) throw new Error(arm ? 'ARM64 engines require explicit --execution hybrid-qemu --emulator <qualified binary>; provisioning still uses the engine amd64 translator.' : 'hybrid-qemu requires an ARM64 engine; use native on amd64.');
      if (!(info.MemTotal >= memory) || !(info.NCPU >= cpus)) throw new Error(`Engine cannot admit ${opts.memory}/${cpus} CPUs; available ${info.MemTotal} bytes/${info.NCPU} CPUs. Ask the operator to assess resources.`);
      let image;
      try { image = JSON.parse((await call(['image', 'inspect', opts.image])).stdout)[0]; }
      catch (error) { throw new Error(`Image unavailable locally. Run the Docker build command or explicitly load/pull the image first. ${error.message}`); }
      if (image.Os !== 'linux' || image.Architecture !== 'amd64') throw new Error(`Image must be ${platform}; found ${image.Os}/${image.Architecture}`);
      if (!['qsys', '1000', '1000:1000', 'qsys:qsys'].includes(image.Config?.User)) throw new Error('Image must declare the fixed non-root qsys/1000 user');
      receipt.imageId = image.Id; receipt.repoDigests = image.RepoDigests;
      // Pin to the inspected immutable local image ID even if a tag changes mid-run.
      const imageId = image.Id;
      await snapshot('image-known');
      const volumes = {};
      if (opts.cacheVolume) {
        const cache = { type: 'volume', role: 'retained-cache', name: opts.cacheVolume, state: 'intended' };
        resources.push(cache);
        cacheLease = `qsys-smoke-cache-lock-${createHash('sha256').update(opts.cacheVolume).digest('hex').slice(0, 24)}`;
        resources.push({ type: 'container', role: 'cache-lock', name: cacheLease, state: 'intended' });
        await snapshot('cache-intent');
        let cached = await call(['volume', 'inspect', opts.cacheVolume], { allowFailure: true });
        if (cached.code !== 0) {
          if (!/no such volume/i.test(cached.stderr)) throw new Error(`Cannot inspect download cache: ${cached.stderr}`);
          await call(['volume', 'create', '--label', `${cacheLabel}=v1`, opts.cacheVolume]);
          cached = await call(['volume', 'inspect', opts.cacheVolume]);
        }
        if (JSON.parse(cached.stdout)[0]?.Labels?.[cacheLabel] !== 'v1') throw new Error('Refusing a foreign/unlabeled download cache volume');
        cache.state = 'acquired';
        await snapshot('cache-verified');
        // Atomic Docker name reservation prevents two installers sharing a cache.
        // A conflicting lease is never stopped or removed by this run.
        const lockName = cacheLease;
        receipt.downloadCache = { volume: opts.cacheVolume, retained: true, lease: lockName };
        cacheLease = lockName;
        await createContainer('cache-lock', ['--network', 'none', '--entrypoint', '/bin/true', imageId], lockName);
        volumes.cache = opts.cacheVolume;
      }
      for (const role of ['input', 'work', 'cache', 'artifacts', 'home']) {
        if (volumes[role]) continue;
        const name = `qsys-smoke-${id}-${role}`;
        owned.push({ type: 'volume', name });
        const resource = { type: 'volume', role, name, state: 'intended' };
        resources.push(resource);
        await snapshot(`allocate-${role}`);
        await call(['volume', 'create', '--label', `${label}=${id}`, name]);
        resource.state = 'acquired';
        await snapshot(`acquired-${role}`);
        volumes[role] = name;
      }
      const mount = (role, target, readonly = false) => ['--mount', `type=volume,source=${volumes[role]},target=${target}${readonly ? ',readonly' : ''}`];
      const writable = [...mount('work', '/work'), ...mount('cache', '/cache'), ...mount('artifacts', '/artifacts'), ...mount('home', '/home/qsys')];
      const probe = await createContainer('preflight', ['--network', 'none', ...writable, ...mount('input', '/input'), '--entrypoint', '/bin/sh', imageId, '-c', 'id -u; df -Pk /input /work /cache /artifacts /home/qsys']);
      const probeOutput = (await call(['start', '--attach', probe])).stdout;
      if (probeOutput.split('\n')[0].trim() !== '1000') throw new Error('Preflight did not execute as UID 1000');
      const rows = probeOutput.trim().split('\n').slice(2);
      const available = rows.map(row => Number(row.trim().split(/\s+/)[3]) * 1024);
      const required = 12 * GiB + inputBytes * 2 + GiB;
      receipt.disk = { required, available };
      if (available.length !== 5 || available.some(free => !Number.isFinite(free) || free < required)) throw new Error(`Docker volume filesystems require ${required} free bytes (12 GiB plus input/backup headroom); found ${available.join(', ')}`);
      const stage = await createContainer('stage', ['--interactive', '--network', 'none', ...mount('input', '/input'), '--entrypoint', '/bin/tar', imageId, '--extract', '--file=-', '--directory=/input', '--no-same-owner']);
      await snapshot('staging-input');
      await call(['start', '--attach', '--interactive', stage], { input: inputTar(files), timeout: 0 });
      const args = ['smoke', '--execution', opts.execution, '--installer', `/input/${files[0].name}`, '--artifacts', '/artifacts', '--profile', opts.profile];
      if (opts.design) args.push('--design', '/input/design.qsys');
      testContainer = `qsys-smoke-${id}-test`;
      await createContainer('test', ['--init', '--env', `QSYS_SMOKE_RUN_ID=${id}`, ...mount('input', '/input', true), ...writable, imageId, ...args]);
      console.error(`Running ${imageId} via context ${context} (${receipt.engine.name}/${receipt.engine.arch}); artifacts: ${artifacts}`);
      await snapshot('attached-test');
      const execution = await call(['start', '--attach', testContainer], { timeout: 0, allowFailure: true });
      if (execution.code !== 0) throw new Error(`Smoke container exited ${execution.code}`);
    } catch (error) { mainError = error; }
    finally {
      try { await snapshot('cleanup'); } catch (error) { cleanupErrors.push(`Journal: ${error.message}`); }
      // Stop the process before export; do not let a signal prevent diagnostic export.
      let testOwned = false;
      if (testContainer) {
        try {
          const data = JSON.parse((await call(['inspect', testContainer], { signal: undefined, timeout: 15000 })).stdout)[0];
          if (data.Config?.Labels?.[label] !== id) throw new Error(`Refusing stop/export: ownership label mismatch on ${testContainer}`);
          testOwned = true;
        } catch (error) { if (!/no such (?:container|object)/i.test(error.message)) cleanupErrors.push(error.message); }
      }
      if (testOwned) {
        let stopped = false;
        try {
          await call(['stop', '--time', '30', testContainer], { signal: undefined, timeout: 40000 });
          stopped = true;
        } catch (error) { cleanupErrors.push(error.message); }
        try {
          const logs = await call(['logs', testContainer], { signal: undefined, timeout: 15000 });
          await journal.check();
          await journal.write('container.stdout.log', logs.stdout);
          await journal.write('container.stderr.log', logs.stderr);
        } catch (error) { cleanupErrors.push(`Container log collection failed: ${error.message}`); }
        try {
          if (!stopped) throw new Error('Refusing artifact snapshot because container stop was not confirmed');
          await journal.check();
          receipt.artifactExport = await streamArtifacts(docker, context ? ['--context', context] : [], testContainer, journal.rootFd);
          await journal.check();
          await journal.validate();
          receipt.containerArtifacts = 'container';
          exported = true;
        } catch (error) { cleanupErrors.push(`Artifact export failed: ${error.message}`); }
      }
      const cleanupSnapshot = async phase => {
        try { await snapshot(phase); } catch (error) { cleanupErrors.push(`Journal: ${error.message}`); }
      };
      let containersRemoved = true;
      for (const resource of [...owned].reverse()) {
        if (resource.name === cacheLease && !containersRemoved) {
          cleanupErrors.push(`Retaining cache lease ${cacheLease}: container removal was not confirmed; inspect its run label and remaining containers before manually removing the lease`);
          continue;
        }
        try {
          const inspection = await call([resource.type === 'container' ? 'inspect' : 'volume', ...(resource.type === 'container' ? [] : ['inspect']), resource.name], { signal: undefined, allowFailure: true, timeout: 15000 });
          if (inspection.code !== 0) {
            if (/no such (?:container|volume|object)/i.test(inspection.stderr)) {
              resources.find(item => item.name === resource.name).state = 'absent';
              continue;
            }
            if (resource.type === 'container') containersRemoved = false;
            cleanupErrors.push(`Could not verify cleanup of ${resource.name}: ${inspection.stderr.trim()}`); continue;
          }
          const data = JSON.parse(inspection.stdout)[0];
          const labels = resource.type === 'container' ? data.Config?.Labels : data.Labels;
          if (labels?.[label] !== id) throw new Error(`Refusing removal: ownership label mismatch on ${resource.name}`);
          await cleanupSnapshot(`remove-${resource.name}`);
          await call(resource.type === 'container' ? ['rm', '--force', resource.name] : ['volume', 'rm', resource.name], { signal: undefined, timeout: 20000 });
          resources.find(item => item.name === resource.name).state = 'removed';
          await cleanupSnapshot(`removed-${resource.name}`);
        } catch (error) { if (resource.type === 'container') containersRemoved = false; cleanupErrors.push(error.message); }
      }
      process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); process.off('SIGHUP', sighup);
      receipt.finishedAt = new Date().toISOString(); receipt.artifactsExported = exported; receipt.cleanupErrors = cleanupErrors;
      if (exported) {
        try {
          result = await readResult('container/result.json', journal.read);
          const phases = await journal.read('container/phases.json');
          receipt.execution = phases.execution || receipt.execution;
          receipt.phases = phases.phases;
          if (phases.schemaVersion !== 1 || phases.runId !== id || phases.mode !== opts.execution || phases.status !== 'passed'
            || !Array.isArray(phases.phases) || phases.phases.length !== 2
            || phases.phases[0].name !== 'provisioning' || phases.phases[1].name !== 'application'
            || phases.phases.some(phase => phase.status !== 'passed')) throw new Error('Provisioning/application phase receipts did not pass for this run');
          const provisioning = await journal.read('container/provisioning.json');
          if (provisioning.schemaVersion !== 1 || provisioning.runId !== id || provisioning.status !== 'passed'
            || !/^[a-f0-9]{64}$/.test(provisioning.manifestSha256 || '')
            || provisioning.installerSha256 !== receipt.inputs[files[0].name]) throw new Error('Provisioning receipt does not match the selected installer/run');
          if (opts.execution === 'hybrid-qemu' && phases.execution?.emulator?.sha256 !== QEMU_PIN.sha256) throw new Error('Application QEMU identity does not match the qualified pin');
        }
        catch (error) { mainError ??= new Error(`Smoke did not produce readable result.json and valid phase receipts: ${error.message}; original export preserved under container/`); }
      } else mainError ??= new Error('Smoke did not export a safe readable result.json');
      if (!mainError && (result?.schemaVersion !== 1 || result.status !== 'passed' || !Array.isArray(result.cases) || !result.cases.some(item => item.status === 'passed') || result.cases.some(item => !['passed', 'skipped'].includes(item.status)))) mainError = new Error('Smoke result is failed, incomplete, or invalid');
      if (cleanupErrors.length) mainError ??= new Error('Artifact export or owned-resource cleanup failed; see runner.json');
      if (mainError) receipt.error = mainError.message;
      try {
      await snapshot('receipts', mainError ? 'failed' : 'incomplete');
      await journal.json('runner.json', receipt);
      const summary = result ? { ...result, artifacts: Object.fromEntries(Object.entries(result.artifacts || {}).map(([key, value]) => [key, typeof value === 'string' ? `container/${value}` : value])) }
        : { schemaVersion: 1, status: 'failed', cases: [{ name: 'runner', status: 'failed', reason: mainError?.message || 'No smoke result' }], versions: {}, timings: {}, artifacts: { runner: 'runner.json' } };
      if (mainError && summary.status === 'passed') {
        summary.status = 'failed';
        summary.cases = [...summary.cases, { name: 'runner', status: 'failed', reason: mainError.message }];
      }
      await journal.json('result.json', summary);
      // After authoritative receipts commit, diagnostic journal failure cannot
      // turn a passed result into a failing CLI exit. Warn, never relabel it.
      try { await snapshot('finished', mainError ? 'failed' : 'completed'); }
      catch (error) { console.error(`Warning: terminal journal snapshot failed: ${error.message.slice(0, 2000)}`); }
      } catch (error) {
        mainError ??= error;
        try { await snapshot('receipt-error', 'failed'); } catch {}
      }
    }
    if (mainError) { mainError.cleanupErrors = [...cleanupErrors]; mainError.exitCode = signalName === 'SIGINT' ? 130 : signalName === 'SIGTERM' ? 143 : signalName === 'SIGHUP' ? 129 : 1; throw mainError; }
    return { ...receipt, result };
  } finally {
    try { await journal.close(); }
    catch (error) { console.error(`Warning: artifact handle close failed: ${error.message.slice(0, 2000)}`); }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(help);
    else await runSmoke(options);
  } catch (error) {
    console.error(error.message);
    for (const message of (error.cleanupErrors || []).slice(0, 20)) console.error(`Cleanup: ${message.slice(0, 2000)}`);
    process.exitCode = error.exitCode || 1;
  }
}
