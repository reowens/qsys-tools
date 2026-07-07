import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const CLI_VERSION = '0.1.2';

export interface ReleaseInfo {
  version: string;
  tag: string;
  assetName: string;
  url: string;
  sha256: string;
  installerApp: string;
}

export const DEFAULT_RELEASE: ReleaseInfo = {
  version: '0.1.2',
  tag: 'qsys-mac-installer-v0.1.2',
  assetName: 'qsys-mac-installer.dmg',
  url: 'https://github.com/reowens/qsys-tools/releases/download/qsys-mac-installer-v0.1.2/qsys-mac-installer.dmg',
  sha256: 'f81c3130b482ccebf04d0b51899ac7b6263ae6073605253b9a17e5cdb6756330',
  installerApp: 'Q-SYS Mac Installer.app',
};

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  stdio?: 'inherit' | 'pipe';
  allowNonZero?: boolean;
}

export interface Runtime {
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  fetch?: typeof fetch;
  runCommand?: (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
}

interface ParsedArgs {
  command?: string;
  positionals: string[];
  dmg?: string;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

const usage = `qsys-mac ${CLI_VERSION}

Usage:
  qsys-mac install <Q-SYS Designer Installer*.exe> [--dmg <path>]
  qsys-mac status [--dmg <path>]
  qsys-mac remove [--dmg <path>]

This npm package is a bootstrapper. It downloads and verifies the signed
Q-SYS Mac Installer DMG, mounts it, runs the bundled qsys-mac helper, and
detaches the DMG when the helper exits.`;

function runtimePlatform(runtime: Runtime): NodeJS.Platform {
  return runtime.platform ?? process.platform;
}

function runtimeHome(runtime: Runtime): string {
  return runtime.homeDir ?? homedir();
}

function say(runtime: Runtime, message: string): void {
  (runtime.out ?? console.log)(message);
}

function warn(runtime: Runtime, message: string): void {
  (runtime.err ?? console.error)(message);
}

export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  let dmg: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--dmg') {
      const next = args[++i];
      if (!next) throw new UsageError('--dmg requires a path');
      dmg = next;
    } else if (arg.startsWith('--dmg=')) {
      dmg = arg.slice('--dmg='.length);
      if (!dmg) throw new UsageError('--dmg requires a path');
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { command: positionals[0], positionals: positionals.slice(1), dmg, help, version };
}

export async function runCli(args: string[], runtime: Runtime = {}): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed.version) {
      say(runtime, CLI_VERSION);
      return 0;
    }
    if (parsed.help || !parsed.command) {
      say(runtime, usage);
      return parsed.help ? 0 : 2;
    }

    return await runBootstrapper(parsed, runtime);
  } catch (err) {
    const prefix = err instanceof UsageError ? '' : 'error: ';
    warn(runtime, `${prefix}${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof UsageError) warn(runtime, 'Run `qsys-mac --help` for usage.');
    return err instanceof UsageError ? 2 : 1;
  }
}

export async function runBootstrapper(
  parsed: ParsedArgs,
  runtime: Runtime = {},
  release: ReleaseInfo = DEFAULT_RELEASE,
): Promise<number> {
  if (runtimePlatform(runtime) !== 'darwin') {
    throw new Error('qsys-mac only runs on macOS.');
  }

  const command = parsed.command;
  const helperArgs: string[] = [];
  if (command === 'install') {
    const installer = parsed.positionals[0];
    if (!installer || parsed.positionals.length !== 1) {
      throw new UsageError('usage: qsys-mac install <Q-SYS Designer Installer*.exe>');
    }
    await access(installer);
    helperArgs.push('install', installer);
  } else if (command === 'status') {
    if (parsed.positionals.length !== 0) throw new UsageError('usage: qsys-mac status');
    helperArgs.push('status');
  } else if (command === 'remove' || command === 'uninstall') {
    if (parsed.positionals.length !== 0) throw new UsageError('usage: qsys-mac remove');
    helperArgs.push('remove');
  } else {
    throw new UsageError(`unknown command: ${command}`);
  }

  const dmg = parsed.dmg ? await resolveLocalDmg(parsed.dmg) : await ensureCachedDmg(release, runtime);
  return await runHelperFromDmg(dmg, helperArgs, release, runtime);
}

async function resolveLocalDmg(dmg: string): Promise<string> {
  const resolved = path.resolve(dmg);
  await access(resolved);
  return resolved;
}

export function cachePaths(release: ReleaseInfo, runtime: Runtime = {}): { dir: string; dmg: string; tmp: string; mount: string } {
  const dir = path.join(runtimeHome(runtime), 'Library', 'Caches', 'qsys-mac');
  const base = `qsys-mac-installer-${release.version}`;
  return {
    dir,
    dmg: path.join(dir, `${base}.dmg`),
    tmp: path.join(dir, `${base}.dmg.tmp`),
    mount: path.join(dir, `${base}.mount`),
  };
}

export async function ensureCachedDmg(release: ReleaseInfo, runtime: Runtime = {}): Promise<string> {
  validateReleaseSha(release);
  const paths = cachePaths(release, runtime);
  await mkdir(paths.dir, { recursive: true });

  if (await fileExists(paths.dmg)) {
    const actual = await hashFile(paths.dmg);
    if (actual === release.sha256) return paths.dmg;
    await rm(paths.dmg, { force: true });
    warn(runtime, `cached DMG checksum mismatch; downloading ${release.assetName} again`);
  }

  say(runtime, `Downloading ${release.assetName}...`);
  await downloadFile(release.url, paths.tmp, runtime);
  const actual = await hashFile(paths.tmp);
  if (actual !== release.sha256) {
    await rm(paths.tmp, { force: true });
    throw new Error(`downloaded DMG checksum mismatch: expected ${release.sha256}, got ${actual}`);
  }
  await rename(paths.tmp, paths.dmg);
  return paths.dmg;
}

function validateReleaseSha(release: ReleaseInfo): void {
  if (!/^[a-f0-9]{64}$/i.test(release.sha256)) {
    throw new Error(`release checksum is not set for ${release.tag}`);
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, dest: string, runtime: Runtime): Promise<void> {
  const fetcher = runtime.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error('global fetch is unavailable; use Node.js 18.17 or newer');
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);

  if (response.body) {
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(dest));
  } else {
    await writeFile(dest, Buffer.from(await response.arrayBuffer()));
  }
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function runHelperFromDmg(
  dmg: string,
  helperArgs: string[],
  release: ReleaseInfo = DEFAULT_RELEASE,
  runtime: Runtime = {},
): Promise<number> {
  const paths = cachePaths(release, runtime);
  await rm(paths.mount, { recursive: true, force: true });
  await mkdir(paths.mount, { recursive: true });

  let mounted = false;
  try {
    await runCommand('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', paths.mount, dmg], runtime, { stdio: 'pipe' });
    mounted = true;

    const helper = path.join(paths.mount, release.installerApp, 'Contents', 'Resources', 'qsys-mac');
    await access(helper);
    const result = await runCommand(helper, helperArgs, runtime, { stdio: 'inherit', allowNonZero: true });
    return result.code;
  } finally {
    if (mounted) {
      try {
        await runCommand('hdiutil', ['detach', paths.mount], runtime, { stdio: 'pipe' });
      } catch (err) {
        warn(runtime, `warning: could not detach DMG: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await rm(paths.mount, { recursive: true, force: true });
  }
}

async function runCommand(
  command: string,
  args: string[],
  runtime: Runtime,
  options: CommandOptions,
): Promise<CommandResult> {
  if (runtime.runCommand) return await runtime.runCommand(command, args, options);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    if (child.stdout) child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    if (child.stderr) child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (result.code !== 0 && !options.allowNonZero) {
        reject(new Error(`${command} failed with exit ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ''}`));
      } else {
        resolve(result);
      }
    });
  });
}
