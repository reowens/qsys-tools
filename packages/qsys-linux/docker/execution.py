#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Two recorded phases: fresh packaged installation, then actual Designer UI.

hybrid-qemu uses the engine's existing amd64 translator for provisioning and a
separately supplied, checksum-pinned ARM64 QEMU for UI. No kernel registration.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import stat
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
DATA = Path('/work/qsys-designer')
CLI = ['/usr/local/bin/node', '/usr/local/lib/node_modules/qsys-linux/bin/qsys-linux.mjs']
QEMU = Path('/input/qemu-x86_64')
QEMU_ENV = {'QEMU_CPU': 'Nehalem', 'DOTNET_EnableHWIntrinsic': '0', 'DOTNET_ReadyToRun': '0',
            'DOTNET_EnableAVX': '0', 'DOTNET_EnableAVX2': '0', 'DOTNET_EnableWriteXorExecute': '0'}


def digest(filename):
    with open(filename, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def read_json(filename):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16 * 1024**2:
            raise ValueError('Expected a regular receipt of at most 16 MiB')
        return json.load(source)


def write_json(filename, value):
    temporary = filename.with_name(filename.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x') as output:
        json.dump(value, output, indent=2)
        output.write('\n')
    temporary.replace(filename)


def cache_state(recipe_path=Path('/usr/local/lib/node_modules/qsys-linux/lib/qsys_linux.py'), directory=Path('/cache'), removed=None):
    spec = importlib.util.spec_from_file_location('packaged_recipe', recipe_path)
    recipe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recipe)
    result = []
    expected = {url.rsplit('/', 1)[1] for url, _, _ in [recipe.WINE_ARTIFACT, *recipe.RUNTIMES]}
    for target in directory.iterdir():
        if target.name in expected and not target.is_symlink():
            continue
        if removed is not None and (target.name in {name + '.partial' for name in expected} or target.name.startswith('ubuntu-tools-')):
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()
            removed.append(target.name)
        else:
            raise ValueError(f'Unexpected download cache entry: {target.name}')
    for url, algorithm, expected in [recipe.WINE_ARTIFACT, *recipe.RUNTIMES]:
        target = directory / url.rsplit('/', 1)[1]
        present = target.is_file() and not target.is_symlink()
        verified = present and recipe.digest(target, algorithm) == expected
        result.append({'file': target.name, 'present': present, 'verified': verified})
        if target.exists() and not verified:
            raise ValueError(f'Unverified download cache entry: {target.name}')
    return result


def execution_policy(mode, helper_dir=HERE, emulator=QEMU):
    policy = {'mode': mode, 'provisioning': 'engine-amd64' if mode == 'native' else 'engine-amd64-translation',
              'application': 'native-amd64' if mode == 'native' else 'arm64-qemu-x86_64',
              'rosettaFree': mode == 'native'}
    if mode == 'hybrid-qemu':
        pin = read_json(helper_dir / 'qemu-pin.json')
        if digest(emulator) != pin['sha256']:
            raise ValueError('QEMU checksum does not match the qualified pin')
        compatibility = read_json(helper_dir / 'compatibility.json')
        if digest(helper_dir / 'wine-procmem.so') != compatibility['sha256']:
            raise ValueError('Process-memory helper checksum mismatch')
        policy.update(emulator=pin, compatibility=compatibility, environment=QEMU_ENV)
    return policy


class Execution:
    def __init__(self, args):
        self.args = args
        self.out = args.artifacts
        self.out.mkdir(parents=True, exist_ok=True)
        self.child = None
        self.interrupted = None
        self.phase = None
        self.receipt = {'schemaVersion': 1, 'runId': os.environ.get('QSYS_SMOKE_RUN_ID', str(uuid.uuid4())),
                        'status': 'incomplete', 'mode': args.execution, 'phases': []}

    def flush(self):
        write_json(self.out / 'phases.json', self.receipt)

    def interrupted_by(self, signum, _frame):
        if self.interrupted is None:
            self.interrupted = signum
            raise InterruptedError(f'Interrupted by signal {signum}')

    def run(self, argv, log=None, env=None, timeout=1800):
        output = log.open('w') if log else None
        self.child = subprocess.Popen(argv, env=env, stdout=output, stderr=subprocess.STDOUT if log else None,
                                      start_new_session=True)
        try:
            code = self.child.wait(timeout=timeout)
            if code:
                raise RuntimeError(f'{self.phase} process exited {code}')
        finally:
            if self.child.poll() is None:
                self.stop_child()
            self.child = None
            if output:
                output.close()

    def stop_child(self):
        try:
            os.killpg(self.child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            # UI owns Wine teardown and needs up to ~5s after an interruption.
            self.child.wait(timeout=18 if self.phase == 'application' else 3)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(self.child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.child.wait(timeout=1)

    def provision(self):
        if (DATA / 'prefix').exists():
            raise ValueError('Provisioning requires a fresh work volume, not an existing Wine prefix')
        record = {'schemaVersion': 1, 'runId': self.receipt['runId'], 'status': 'incomplete',
                  'execution': self.receipt['execution']['provisioning'],
                  'installerSha256': digest(self.args.installer), 'dataDir': str(DATA)}
        try:
            record['removedTemporaryDownloads'] = []
            record['cacheBefore'] = cache_state(removed=record['removedTemporaryDownloads'])
            self.run([*CLI, '--data-dir', str(DATA), 'install', str(self.args.installer),
                      '--no-integrate', '--downloads', '/cache'], log=self.out / 'install.log')
            record['manifestSha256'] = digest(DATA / 'prefix/.qsys-linux-prefix')
            record['cacheAfter'] = cache_state()
            record['status'] = 'passed'
        except BaseException as error:
            record.update(status='failed', reason=str(error))
            raise
        finally:
            write_json(self.out / 'provisioning.json', record)

    def application(self):
        env = dict(os.environ, QSYS_SMOKE_RUN_ID=self.receipt['runId'],
                   QSYS_PROVISIONING_EXECUTION=self.receipt['execution']['provisioning'])
        argv = ['/usr/bin/python3', str(HERE / 'smoke.py'), '--installer', str(self.args.installer),
                '--artifacts', str(self.out), '--profile', self.args.profile,
                '--provisioning-receipt', str(self.out / 'provisioning.json')]
        if self.args.design:
            argv += ['--design', str(self.args.design)]
        if self.args.execution == 'hybrid-qemu':
            env.update(QEMU_ENV, PATH=str(HERE / 'shims') + ':' + env['PATH'],
                       LD_PRELOAD=str(HERE / 'wine-procmem.so'))
            argv.insert(0, str(QEMU))
        self.run(argv, env=env, timeout=1200)
        if read_json(self.out / 'result.json').get('status') != 'passed':
            raise ValueError('Application receipt did not pass')
        self.receipt['cacheAfterApplication'] = cache_state()

    def execute(self):
        self.flush()
        try:
            self.receipt['execution'] = execution_policy(self.args.execution)
            self.flush()
            for name, action in [('provisioning', self.provision), ('application', self.application)]:
                self.phase = name
                record = {'name': name, 'status': 'incomplete'}
                self.receipt['phases'].append(record)
                self.flush()
                at = time.monotonic()
                try:
                    action()
                    record['status'] = 'passed'
                except BaseException as error:
                    record.update(status='failed', reason=str(error))
                    raise
                finally:
                    record['durationMs'] = round((time.monotonic() - at) * 1000)
                    self.flush()
            self.receipt['status'] = 'passed'
        except BaseException as error:
            self.receipt.update(status='failed', reason=str(error))
            # Preserve real UI failures. If UI was never started or interrupted
            # before writing, make the phase failure visible to the host runner.
            filename = self.out / 'result.json'
            result = read_json(filename) if filename.exists() else {
                'schemaVersion': 1, 'status': 'failed', 'cases': [], 'versions': {}, 'timings': {}, 'artifacts': {}}
            result['status'] = 'failed'
            result['cases'].append({'name': 'execution', 'status': 'failed', 'reason': str(error)})
            result['artifacts'].update(phases='phases.json', provisioning='provisioning.json', install='install.log')
            write_json(filename, result)
        finally:
            # Define an atomic completion boundary. Signals received before it
            # are recorded as interruption; later ones cannot strand a passed
            # receipt next to an exception raised during finalization.
            if getattr(self, 'manage_signals', False):
                signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP})
            self.flush()
        if self.interrupted:
            return 128 + self.interrupted
        return 0 if self.receipt['status'] == 'passed' else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execution', choices=('native', 'hybrid-qemu'), default='native')
    parser.add_argument('--installer', type=Path, default=Path('/input/installer.zip'))
    parser.add_argument('--design', type=Path)
    parser.add_argument('--profile', choices=('basic', 'full'), default='basic')
    parser.add_argument('--artifacts', type=Path, default=Path('/artifacts'))
    job = Execution(parser.parse_args(argv))
    job.manage_signals = True
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, job.interrupted_by)
    return job.execute()


if __name__ == '__main__':
    sys.exit(main())
