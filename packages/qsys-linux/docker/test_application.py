"""Focused receipt/CLI failure tests; does not claim real Designer acceptance."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('application_smoke', Path(__file__).with_name('smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class ReceiptTests(unittest.TestCase):
    def test_blank_title_dialog_is_recognized_by_its_parent(self):
        import argparse
        with tempfile.TemporaryDirectory() as tmp:
            app = smoke.Smoke(argparse.Namespace(artifacts=Path(tmp), profile='basic', design=None))
            app.window = '100'
            app.clients = Mock(side_effect=[['100'], ['100', '200']])
            app.windows = Mock(return_value=[])
            app.run = Mock(return_value='WM_TRANSIENT_FOR(WINDOW): window id # 0x64')
            app.activate = Mock()
            app.key = Mock()
            self.assertEqual(app.dialog('ctrl+shift+s', '^Save As$'), '200')
            self.assertEqual(app.dialog_window, '200')
            app.activate.assert_called_with('200')

    def test_basic_launch_is_explicitly_reduced(self):
        cases = [{'name': name, 'status': 'passed'} for name in smoke.REQUIRED_BASIC]
        cases += [{'name': name, 'status': 'skipped'} for name in (*smoke.FIXTURE_CASES, *smoke.FULL_GAPS)]
        self.assertEqual(smoke.overall(cases, 'basic', False), 'passed')
        self.assertEqual(smoke.overall(cases, 'basic', True), 'incomplete')
        self.assertEqual(smoke.overall(cases, 'full', False), 'incomplete')

    def test_full_cannot_pass_without_content_assertions(self):
        cases = [{'name': name, 'status': 'passed'} for name in (*smoke.REQUIRED_BASIC, *smoke.FIXTURE_CASES)]
        self.assertEqual(smoke.overall(cases, 'full', True), 'incomplete')
        cases += [{'name': name, 'status': 'skipped'} for name in smoke.FULL_GAPS]
        self.assertEqual(smoke.overall(cases, 'full', True), 'incomplete')
        cases.append({'name': 'cleanup', 'status': 'failed'})
        self.assertEqual(smoke.overall(cases, 'full', True), 'failed')

    def test_missing_packaged_cli_writes_failure_and_all_missing_cases(self):
        with tempfile.TemporaryDirectory() as tmp:
            # PATH has no CLI. No substitute package or installer is manufactured.
            with patch.dict('os.environ', {'PATH': tmp}):
                code = smoke.main(['--artifacts', tmp, '--installer', str(Path(tmp) / 'missing.zip'), '--profile', 'full'])
            result = json.loads((Path(tmp) / 'result.json').read_text())
            self.assertEqual(code, 1)
            self.assertEqual(result['schemaVersion'], 1)
            self.assertEqual(result['status'], 'failed')
            cases = {c['name']: c for c in result['cases']}
            self.assertEqual(cases['cli-help']['status'], 'failed')
            self.assertEqual(cases['lua-edit']['status'], 'skipped')
            self.assertEqual(cases['qrc']['status'], 'skipped')
            self.assertIn('Lua', cases['lua-edit']['reason'])

    def test_cleanup_terminates_only_its_process_group(self):
        import subprocess
        import sys
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        try:
            smoke.Smoke.stop_process(child)
            self.assertIsNotNone(child.poll())
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_interruption_stops_further_case_work(self):
        import argparse
        with tempfile.TemporaryDirectory() as tmp:
            app = smoke.Smoke(argparse.Namespace(artifacts=Path(tmp), profile='full', design=None))
            def interrupted():
                app.interrupted = True
                raise InterruptedError('test interruption')
            with self.assertRaises(InterruptedError):
                app.case('launch', interrupted)
            result = json.loads((Path(tmp) / 'result.json').read_text())
            self.assertEqual(result['cases'][0]['status'], 'failed')

    def test_timeout_is_a_failure_not_skip(self):
        with tempfile.TemporaryDirectory() as tmp:
            import argparse
            app = smoke.Smoke(argparse.Namespace(artifacts=Path(tmp), profile='basic', design=None))
            def timeout():
                smoke.wait_for(lambda: False, 0, 'not ready')
            self.assertFalse(app.case('launch', timeout))
            receipt = json.loads((Path(tmp) / 'result.json').read_text())
            self.assertEqual(receipt['status'], 'failed')
            self.assertEqual(receipt['cases'][0]['reason'], 'not ready')


if __name__ == '__main__':
    unittest.main()
