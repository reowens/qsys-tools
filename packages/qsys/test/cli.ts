/**
 * e2e: runCli driving qsys-mock-core over an actual TCP socket — every command,
 * plus arg-parsing edge cases (negative positionals, usage errors) and a live
 * watch stream. Run: npx tsx test/cli.ts
 */
import assert from 'node:assert/strict';
import { QrcClient } from 'qsys-qrc';
import { parseDesign, startMockCore } from 'qsys-mock-core';
import { parseCliArgs, runCli, UsageError, type CliIo } from '../src/index.js';

const design = parseDesign({
  design: { name: 'CliTest', code: 'ct', platform: 'Core 110f' },
  namedControls: [{ name: 'MainGain', type: 'gain', min: -100, max: 20, units: 'dB', value: -10 }],
  components: [
    { name: 'Gain1', type: 'gain', controls: [
      { name: 'gain', type: 'gain', min: -100, max: 20, units: 'dB', value: -6 },
      { name: 'mute', type: 'mute' },
    ] },
    { name: 'Mixer1', type: 'mixer', controls: [
      { name: 'crosspoint.1.1', type: 'gain', min: -100, max: 20, units: 'dB', value: 0 },
    ] },
  ],
});

let pass = 0;
const ok = (name: string) => { pass++; console.log(`  ok  ${name}`); };

function makeIo(signal?: AbortSignal): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l), signal }, out, err };
}

function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (cond()) { clearInterval(timer); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error(`timeout: ${what}`)); }
    }, 20);
  });
}

async function main(): Promise<void> {
  // -- arg parsing (no emulator needed) --
  const parsed = parseCliArgs(['set', 'MainGain', '-6', '--ramp', '2']);
  assert.deepEqual(parsed.positionals, ['set', 'MainGain', '-6']);
  assert.equal(parsed.flags.ramp, '2');
  ok('negative value stays positional');

  assert.throws(() => parseCliArgs(['--bogus']), UsageError);
  ok('unknown option rejected');

  const emu = await startMockCore(design, { port: 0, tickMs: 25 });
  const conn = ['--host', '127.0.0.1', '--port', String(emu.port)];
  const run = async (args: string[], signal?: AbortSignal) => {
    const { io, out, err } = makeIo(signal);
    const code = await runCli([...args, ...conn], io);
    return { code, out, err, text: out.join('\n') };
  };

  // -- usage / exit codes --
  {
    const { io, err } = makeIo();
    assert.equal(await runCli(['status'], io), 2); // no --host, no QSYS_HOST
    assert.match(err[0], /--host/);
    ok('missing host → exit 2');
  }
  {
    const { code, err } = await run(['frobnicate']);
    assert.equal(code, 2);
    assert.match(err[0], /unknown command/);
    ok('unknown command → exit 2');
  }

  // -- status --
  {
    const { code, text } = await run(['status']);
    assert.equal(code, 0);
    assert.match(text, /CliTest/);
    assert.match(text, /emulator/);
    ok('status renders design + platform');
  }
  {
    const { text } = await run(['status', '--json']);
    assert.equal(JSON.parse(text).DesignName, 'CliTest');
    ok('status --json is valid JSON');
  }

  // -- ls --
  {
    const { text } = await run(['ls']);
    assert.match(text, /Gain1\s+gain/);
    assert.match(text, /Mixer1\s+mixer/);
    ok('ls lists components');
  }
  {
    const { text } = await run(['ls', '--type', 'mixer']);
    assert.match(text, /Mixer1/);
    assert.doesNotMatch(text, /Gain1/);
    ok('ls --type filters');
  }
  {
    const parsedLs = JSON.parse((await run(['ls', '--filter', 'gain', '--json'])).text);
    assert.equal(parsedLs.length, 1);
    assert.equal(parsedLs[0].Name, 'Gain1');
    ok('ls --filter --json');
  }

  // -- get / set (incl. clamp + negative positional over the wire) --
  {
    const { text } = await run(['get', 'MainGain']);
    assert.match(text, /MainGain\s+-10\s+-10\.0dB/);
    ok('get renders value + string');
  }
  {
    const { code, text } = await run(['set', 'MainGain', '-6']);
    assert.equal(code, 0);
    assert.match(text, /-6\s+-6\.0dB/);
    ok('set negative value + readback');
  }
  {
    const { text } = await run(['set', 'MainGain', '999']);
    assert.match(text, /MainGain\s+20/); // emulator clamps to max
    ok('set clamps to range');
  }

  // -- component get / set --
  {
    const { text } = await run(['get-component', 'Gain1']);
    assert.match(text, /gain\s+-6/);
    assert.match(text, /mute/);
    ok('get-component lists all controls');
  }
  {
    const { text } = await run(['set-component', 'Gain1', 'mute', 'true']);
    assert.match(text, /mute\s+1\s+true/); // QRC reports booleans as Value 1 / String "true"
    ok('set-component coerces boolean + readback');
  }
  {
    const { text } = await run(['get-component', 'Gain1', 'gain']);
    assert.doesNotMatch(text.split('\n').slice(1).join('\n'), /mute/);
    ok('get-component with explicit control');
  }

  // -- snapshot --
  {
    await run(['set', 'MainGain', '-20']);
    assert.equal((await run(['snapshot', 'save', 'Bank', '1'])).code, 0);
    await run(['set', 'MainGain', '0']);
    assert.equal((await run(['snapshot', 'load', 'Bank', '1'])).code, 0);
    const { text } = await run(['get', 'MainGain']);
    assert.match(text, /-20/);
    ok('snapshot save/load round-trip');
  }

  // -- watch: baseline + pushed change, abort ends the stream --
  {
    const abort = new AbortController();
    const { io, out } = makeIo(abort.signal);
    const watchP = runCli(['watch', 'MainGain', '--interval', '0.05', ...conn], io);
    await waitFor(() => out.some((l) => l.includes('MainGain')), 'watch baseline');

    const driver = new QrcClient({ host: '127.0.0.1', port: emu.port, reconnect: false });
    await driver.connect();
    await driver.setControl('MainGain', -42);
    await waitFor(() => out.some((l) => l.includes('-42')), 'watch pushed change');
    driver.close();

    abort.abort();
    assert.equal(await watchP, 0);
    ok('watch streams pushes and stops on abort');
  }
  {
    const abort = new AbortController();
    const { io, out } = makeIo(abort.signal);
    const watchP = runCli(['watch', '--component', 'Gain1', 'gain', '--json', '--interval', '0.05', ...conn], io);
    await waitFor(() => out.length > 0, 'component watch baseline');
    assert.equal(JSON.parse(out[0]).Name, 'gain');
    abort.abort();
    assert.equal(await watchP, 0);
    ok('watch --component --json emits JSON lines');
  }

  await emu.close();
  console.log(`\n${pass} cli assertions passed.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
