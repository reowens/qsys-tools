"""Phase provenance and real subprocess interruption tests; no vendor substitutes."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import execution
import smoke


class ExecutionTests(unittest.TestCase):
    def test_cache_rejects_unknown_links_and_bad_hashes_and_cleans_only_known_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            recipe = root / 'recipe.py'
            recipe.write_text("import hashlib\nWINE_ARTIFACT=('https://example.invalid/wine.deb','sha256',hashlib.sha256(b'verified').hexdigest())\nRUNTIMES=[]\ndef digest(p,a):return hashlib.new(a,p.read_bytes()).hexdigest()\n")
            cache = root / 'cache'; cache.mkdir()
            archive = cache / 'wine.deb'; archive.write_bytes(b'verified')
            self.assertTrue(execution.cache_state(recipe, cache)[0]['verified'])
            temporary = cache / 'wine.deb.partial'; temporary.write_bytes(b'incomplete')
            scratch = cache / 'ubuntu-tools-interrupted'; scratch.mkdir()
            removed = []
            execution.cache_state(recipe, cache, removed)
            self.assertEqual(set(removed), {'wine.deb.partial', 'ubuntu-tools-interrupted'})
            unknown = cache / 'unexpected'; unknown.write_bytes(b'untrusted')
            with self.assertRaisesRegex(ValueError, 'Unexpected'): execution.cache_state(recipe, cache)
            unknown.unlink(); archive.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'Unverified'): execution.cache_state(recipe, cache)
            archive.unlink(); archive.symlink_to(recipe)
            with self.assertRaisesRegex(ValueError, 'Unexpected'): execution.cache_state(recipe, cache)

    def test_existing_prefix_is_refused_before_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'prefix').mkdir()
            job = execution.Execution(argparse.Namespace(artifacts=root, execution='native'))
            with patch.object(execution, 'DATA', root), self.assertRaisesRegex(ValueError, 'fresh work'):
                job.provision()

    def test_failed_provisioning_never_starts_application(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(artifacts=Path(directory), execution='native')
            job = execution.Execution(args)
            def failed():
                raise RuntimeError('actual provisioning failed')
            job.provision = failed
            job.application = lambda: self.fail('UI must not start')
            self.assertEqual(job.execute(), 1)
            phases = execution.read_json(Path(directory) / 'phases.json')
            self.assertEqual([(p['name'], p['status']) for p in phases['phases']], [('provisioning', 'failed')])
            self.assertEqual(execution.read_json(Path(directory) / 'result.json')['status'], 'failed')

    def test_emulator_and_helper_are_verified_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            emulator = root / 'emulator'
            emulator.write_bytes(b'selected test bytes, not a real emulator')
            execution.write_json(root / 'qemu-pin.json', {'sha256': '0' * 64})
            with self.assertRaisesRegex(ValueError, 'QEMU checksum'):
                execution.execution_policy('hybrid-qemu', root, emulator)
            execution.write_json(root / 'qemu-pin.json', {'sha256': execution.digest(emulator)})
            (root / 'wine-procmem.so').write_bytes(b'not a shared library')
            execution.write_json(root / 'compatibility.json', {'sha256': '0' * 64})
            with self.assertRaisesRegex(ValueError, 'helper checksum'):
                execution.execution_policy('hybrid-qemu', root, emulator)

    def test_provisioning_credit_is_bound_to_run_installer_and_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installer = root / 'installer.zip'
            installer.write_bytes(b'input fixture bytes')
            data = root / 'data'
            (data / 'prefix').mkdir(parents=True)
            manifest = data / 'prefix/.qsys-linux-prefix'
            manifest.write_text('fresh-prefix-identity')
            receipt = root / 'provisioning.json'
            record = {'schemaVersion': 1, 'runId': 'this-run', 'status': 'passed', 'dataDir': str(data),
                      'installerSha256': execution.digest(installer), 'manifestSha256': execution.digest(manifest),
                      'execution': 'engine-amd64', 'cacheBefore': [], 'cacheAfter': []}
            app = smoke.Smoke(argparse.Namespace(artifacts=root, profile='basic', design=None,
                                                 installer=installer, provisioning_receipt=receipt))
            with patch.object(smoke, 'DATA', data), patch.dict(os.environ, QSYS_SMOKE_RUN_ID='this-run'):
                execution.write_json(receipt, record)
                self.assertEqual(app.install()['phase'], 'provisioning')
                for field in ('runId', 'installerSha256', 'manifestSha256', 'dataDir', 'status'):
                    execution.write_json(receipt, {**record, field: 'foreign'})
                    with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, 'does not match'):
                        app.install()

    @unittest.skipUnless(sys.platform == 'linux', 'POSIX process groups required')
    def test_signal_allows_ui_child_cleanup_and_never_reports_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'driver.py'
            child_code = ("import signal,time,pathlib,os; p=pathlib.Path(" + repr(directory) + "); "
                          "signal.signal(signal.SIGTERM,lambda *_:(time.sleep(.2),(p/'child-cleaned').write_text('yes'),exit(0))); "
                          "(p/'child-pid').write_text(str(os.getpid())); time.sleep(60)")
            script.write_text('import sys,signal,argparse,pathlib\n'
                              f'sys.path.insert(0,{str(execution.HERE)!r})\n'
                              'import execution\n'
                              f'j=execution.Execution(argparse.Namespace(artifacts=pathlib.Path({directory!r}),execution="native"))\n'
                              'j.provision=lambda:None\n'
                              f'j.application=lambda:j.run([sys.executable,"-c",{child_code!r}],timeout=60)\n'
                              'signal.signal(signal.SIGTERM,j.interrupted_by)\n'
                              'sys.exit(j.execute())\n')
            child = subprocess.Popen([sys.executable, script], start_new_session=True)
            try:
                deadline = time.monotonic() + 5
                while not (root / 'child-pid').exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue((root / 'child-pid').exists())
                child.send_signal(signal.SIGTERM)
                self.assertEqual(child.wait(timeout=9), 143)
                self.assertTrue((root / 'child-cleaned').exists())
                self.assertFalse(Path('/proc', (root / 'child-pid').read_text()).exists())
                self.assertEqual(execution.read_json(root / 'result.json')['status'], 'failed')
                self.assertEqual(execution.read_json(root / 'phases.json')['phases'][-1]['status'], 'failed')
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()


if __name__ == '__main__':
    unittest.main()
