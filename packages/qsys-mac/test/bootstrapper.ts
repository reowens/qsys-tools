import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cachePaths,
  ensureCachedDmg,
  hashFile,
  runCli,
  type CommandOptions,
  type CommandResult,
  type ReleaseInfo,
  type Runtime,
} from '../src/index.js';

let pass = 0;
const ok = (name: string) => { pass++; console.log(`  ok  ${name}`); };

async function tempHome(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'qsys-mac-test-'));
}

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function releaseFor(payload: Buffer): Promise<ReleaseInfo> {
  const home = await tempHome();
  const file = path.join(home, 'payload.dmg');
  await writeFile(file, payload);
  const sha256 = await hashFile(file);
  await rm(home, { recursive: true, force: true });
  return {
    version: '9.9.9',
    tag: 'qsys-mac-installer-v9.9.9',
    assetName: 'qsys-mac-installer.dmg',
    url: 'https://example.invalid/qsys-mac-installer.dmg',
    sha256,
    installerApp: 'Q-SYS Mac Installer.app',
  };
}

async function main(): Promise<void> {
  {
    const code = await runCli(['install'], { platform: 'darwin', err: () => undefined, out: () => undefined });
    assert.equal(code, 2);
    ok('missing install argument is usage error');
  }

  {
    const code = await runCli(['status'], { platform: 'linux', err: () => undefined, out: () => undefined });
    assert.equal(code, 1);
    ok('non-mac platform is rejected');
  }

  {
    const home = await tempHome();
    const payload = Buffer.from('fake dmg bytes');
    const release = await releaseFor(payload);
    const runtime: Runtime = {
      homeDir: home,
      fetch: async () => new Response(arrayBuffer(payload)),
      out: () => undefined,
      err: () => undefined,
    };

    const dmg = await ensureCachedDmg(release, runtime);
    assert.equal(await readFile(dmg, 'utf8'), 'fake dmg bytes');
    assert.equal(await ensureCachedDmg(release, runtime), dmg);
    await rm(home, { recursive: true, force: true });
    ok('downloaded DMG is cached after checksum verification');
  }

  {
    const home = await tempHome();
    const payload = Buffer.from('fresh dmg');
    const release = await releaseFor(payload);
    const paths = cachePaths(release, { homeDir: home });
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.dmg, 'stale dmg');
    let fetchCount = 0;

    const dmg = await ensureCachedDmg(release, {
      homeDir: home,
      fetch: async () => { fetchCount++; return new Response(arrayBuffer(payload)); },
      out: () => undefined,
      err: () => undefined,
    });

    assert.equal(fetchCount, 1);
    assert.equal(await readFile(dmg, 'utf8'), 'fresh dmg');
    await rm(home, { recursive: true, force: true });
    ok('checksum mismatch replaces stale cached DMG');
  }

  {
    const home = await tempHome();
    const installer = path.join(home, 'Q-SYS Designer Installer 10.4.0.exe');
    await writeFile(installer, 'installer');
    const localDmg = path.join(home, 'qsys-mac-installer.dmg');
    await writeFile(localDmg, 'local dmg');

    const commands: Array<{ command: string; args: string[]; options: CommandOptions }> = [];
    const runtime: Runtime = {
      platform: 'darwin',
      homeDir: home,
      out: () => undefined,
      err: () => undefined,
      runCommand: async (command: string, args: string[], options: CommandOptions): Promise<CommandResult> => {
        commands.push({ command, args, options });
        if (command === 'hdiutil' && args[0] === 'attach') {
          const mount = args[args.indexOf('-mountpoint') + 1];
          const helperDir = path.join(mount, 'Q-SYS Mac Installer.app', 'Contents', 'Resources');
          await mkdir(helperDir, { recursive: true });
          await writeFile(path.join(helperDir, 'qsys-mac'), '#!/bin/sh\n');
        }
        if (command.endsWith('/qsys-mac')) return { code: 7, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };

    const code = await runCli(['--dmg', localDmg, 'install', installer], runtime);
    assert.equal(code, 7);
    assert.deepEqual(commands.map((c) => c.command === 'hdiutil' ? `${c.command} ${c.args[0]}` : 'helper'), [
      'hdiutil attach',
      'helper',
      'hdiutil detach',
    ]);
    assert.deepEqual(commands[1].args, ['install', installer]);
    await rm(home, { recursive: true, force: true });
    ok('local DMG is mounted, delegated to helper, and detached');
  }

  {
    const home = await tempHome();
    const localDmg = path.join(home, 'qsys-mac-installer.dmg');
    await writeFile(localDmg, 'local dmg');

    const helperCalls: string[][] = [];
    const runtime: Runtime = {
      platform: 'darwin',
      homeDir: home,
      out: () => undefined,
      err: () => undefined,
      runCommand: async (command: string, args: string[], options: CommandOptions): Promise<CommandResult> => {
        if (command === 'hdiutil' && args[0] === 'attach') {
          const mount = args[args.indexOf('-mountpoint') + 1];
          const helperDir = path.join(mount, 'Q-SYS Mac Installer.app', 'Contents', 'Resources');
          await mkdir(helperDir, { recursive: true });
          await writeFile(path.join(helperDir, 'qsys-mac'), '#!/bin/sh\n');
        }
        if (command.endsWith('/qsys-mac')) {
          helperCalls.push(args);
          assert.equal(options.stdio, 'inherit');
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };

    const code = await runCli(['--dmg', localDmg, 'doctor'], runtime);
    assert.equal(code, 0);
    assert.deepEqual(helperCalls, [['doctor']]);
    await rm(home, { recursive: true, force: true });
    ok('doctor command delegates to bundled helper');
  }

  console.log(`\n${pass} qsys-mac bootstrapper assertions passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
