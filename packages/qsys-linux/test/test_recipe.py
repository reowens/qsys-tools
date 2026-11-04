"""Hermetic regression checks; no Wine, downloads, QSC installers, or designs."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
import unittest.mock
from unittest.mock import patch
import zipfile
import sys

RECIPE = Path(__file__).resolve().parents[1] / 'lib/qsys_linux.py'
spec = importlib.util.spec_from_file_location('qsys_linux', RECIPE)
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


class RecipeTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='qsys-linux-test-')
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)

    def test_archive_properties_are_not_member_paths(self):
        recipe.safe_archive_listing('Path = /home/user/installer.exe\n----------\nPath = OFFLINE/a/b.dll\n')

    def test_archive_refuses_posix_and_windows_traversal_and_links(self):
        for member in ['Path = /etc/passwd', 'Path = C:\\Windows\\bad.dll',
                       'Path = ../outside', 'Path = OFFLINE\\..\\bad',
                       'Symbolic Link = target', 'Hard Link = target',
                       'Mode = lrwxrwxrwx', 'Attributes = A_ lrwxr-xr-x']:
            with self.subTest(member=member), self.assertRaises(RuntimeError):
                recipe.safe_archive_listing('Path = /safe/archive.exe\n----------\n' + member + '\n')
        with self.assertRaises(RuntimeError):
            recipe.safe_archive_listing('no member listing')

    def test_zip_selects_only_the_designer_bootstrapper(self):
        archive = self.root / 'vendor.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('Q-SYS Designer Installer 10.5.1.exe', b'designer')
            output.writestr('Q-SYS Administrator Installer 10.5.1.exe', b'admin')
            output.writestr('../must-not-extract', b'hostile companion')
        out = self.root / 'extract'
        out.mkdir()
        installer = recipe.select_installer(archive, out)
        self.assertEqual(installer.read_bytes(), b'designer')
        self.assertEqual(list(out.iterdir()), [installer])
        self.assertFalse((self.root / 'must-not-extract').exists())

    def test_zip_rejects_duplicate_or_symlink_installers(self):
        archive = self.root / 'vendor.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('Q-SYS Designer Installer 10.5.1.exe', b'a')
            output.writestr('Q-SYS Designer Installer 10.5.0.exe', b'b')
        with self.assertRaises(RuntimeError):
            recipe.select_installer(archive, self.root)
        with zipfile.ZipFile(archive, 'w') as output:
            entry = zipfile.ZipInfo('Q-SYS Designer Installer 10.5.1.exe')
            entry.create_system = 3
            entry.external_attr = 0o120777 << 16
            output.writestr(entry, '/etc/passwd')
        with self.assertRaises(RuntimeError):
            recipe.select_installer(archive, self.root)

    def test_artifact_checks_fresh_and_reused_downloads(self):
        good = b'the pinned runtime'
        pin = ('https://example.invalid/runtime.exe', 'sha512', hashlib.sha512(good).hexdigest())
        with patch.object(recipe.urllib.request, 'urlopen', return_value=io.BytesIO(good)):
            downloaded = recipe.artifact(pin, self.root)
        with patch.object(recipe.urllib.request, 'urlopen', side_effect=AssertionError('should reuse verified bytes')):
            self.assertEqual(recipe.artifact(pin, self.root), downloaded)
        downloaded.write_bytes(b'tampered')
        with self.assertRaisesRegex(RuntimeError, 'Checksum mismatch'):
            recipe.artifact(pin, self.root)
        downloaded.unlink()
        with patch.object(recipe.urllib.request, 'urlopen', return_value=io.BytesIO(b'wrong')):
            with self.assertRaisesRegex(RuntimeError, 'Checksum mismatch'):
                recipe.artifact(pin, self.root)
        self.assertFalse(downloaded.exists())
        self.assertFalse((self.root / 'runtime.exe.partial').exists())

    def test_ownership_refuses_unrelated_directory_bad_marker_and_symlink(self):
        target = self.root / 'unrelated'
        target.mkdir()
        (target / 'keep').write_text('user data')
        with self.assertRaises(RuntimeError), recipe.owned_lock(target, create=True):
            pass
        (target / '.qsys-linux-owned').write_text('not ours')
        with self.assertRaises(RuntimeError), recipe.owned_lock(target, create=True):
            pass
        self.assertEqual((target / '.qsys-linux-owned').read_text(), 'not ours')
        link = self.root / 'link'
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(RuntimeError), recipe.owned_lock(link, create=True):
            pass
        self.assertEqual((target / 'keep').read_text(), 'user data')

    def test_runtime_zip_extracts_host_and_framework_and_rejects_unsafe_members(self):
        archive = self.root / 'runtime.zip'
        prefix = self.root / 'prefix'
        prefix.mkdir()
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('dotnet.exe', b'host')
            z.writestr('shared/Microsoft.NETCore.App/10.0.14/coreclr.dll', b'runtime')
        recipe.extract_runtime(archive, prefix)
        target = prefix / 'drive_c/Program Files/dotnet'
        self.assertEqual((target / 'dotnet.exe').read_bytes(), b'host')
        self.assertEqual((target / 'shared/Microsoft.NETCore.App/10.0.14/coreclr.dll').read_bytes(), b'runtime')
        for name in ['../escape', '/absolute', 'C:/drive', 'a\\escape', 'a/../escape', 'dotnet.exe:stream']:
            with self.subTest(name=name):
                with zipfile.ZipFile(archive, 'w') as z:
                    z.writestr('dotnet.exe', b'must not overwrite')
                    z.writestr(name, b'bad')
                with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
                    recipe.extract_runtime(archive, prefix)
                self.assertEqual((target / 'dotnet.exe').read_bytes(), b'host')

    def test_runtime_zip_refuses_archive_links_and_existing_prefix_links(self):
        archive = self.root / 'runtime.zip'
        prefix = self.root / 'prefix'
        prefix.mkdir()
        entry = zipfile.ZipInfo('linked')
        entry.create_system = 3
        entry.external_attr = 0o120777 << 16
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr(entry, 'outside')
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
            recipe.extract_runtime(archive, prefix)
        outside = self.root / 'outside'
        outside.mkdir()
        (prefix / 'drive_c').symlink_to(outside, target_is_directory=True)
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('dotnet.exe', b'host')
        with self.assertRaisesRegex(RuntimeError, 'symbolic link'):
            recipe.extract_runtime(archive, prefix)
        self.assertEqual(list(outside.iterdir()), [])

    def test_runtime_check_requires_every_framework_at_the_pinned_version(self):
        good = ''.join(f'{name} {recipe.DOTNET_VERSION} [C:\\dotnet]\n' for name in
                       ['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App', 'Microsoft.AspNetCore.App'])
        with patch.object(recipe, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=good)):
            self.assertEqual(recipe.runtime_check(self.root, self.root / 'prefix', {}), good)
        for output in [good.replace('Microsoft.WindowsDesktop.App', 'Wrong.Framework'), good.replace(recipe.DOTNET_VERSION, '10.0.0')]:
            with patch.object(recipe, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=output)):
                with self.assertRaisesRegex(RuntimeError, 'failed to install'):
                    recipe.runtime_check(self.root, self.root / 'prefix', {})

    def test_mutation_lock_protects_an_active_launch(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            with self.assertRaisesRegex(RuntimeError, 'running'), recipe.owned_lock(target):
                pass

    def test_launches_share_the_lock_and_still_block_mutation(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            pass
        with recipe.owned_lock(target, shared=True), recipe.owned_lock(target, shared=True):
            with self.assertRaisesRegex(RuntimeError, 'running'), recipe.owned_lock(target):
                pass
        with recipe.owned_lock(target):
            with self.assertRaisesRegex(RuntimeError, 'running'), recipe.owned_lock(target, shared=True):
                pass

    def run_launch(self, running, wait=None):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            pass
        child = unittest.mock.Mock()
        child.wait.side_effect = wait or [0, 0]
        args = argparse.Namespace(data_dir=target, design=None)
        with patch.object(recipe, 'manifest'), patch.object(recipe, 'display_check'), \
                patch.object(recipe, 'environment', return_value={}), \
                patch.object(recipe, 'designer_running', side_effect=running) as scan, \
                patch.object(recipe.time, 'sleep'), \
                patch.object(recipe.subprocess, 'Popen', return_value=child), \
                patch.object(recipe.subprocess, 'run') as stop:
            try:
                recipe.launch(args)
            except KeyboardInterrupt:
                pass
        return scan, [call for call in stop.call_args_list if '-k' in call.args[0]]

    def test_launch_keeps_wine_until_the_other_designs_close(self):
        order = []
        def running(_root):
            order.append('scan')
            return len(order) < 3
        scan, stops = self.run_launch(running)
        self.assertEqual(scan.call_count, 3)
        self.assertEqual(len(stops), 1)

    def test_launch_stops_wine_at_once_when_it_is_the_only_design(self):
        scan, stops = self.run_launch([False])
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(len(stops), 1)

    def test_interrupted_launch_stops_wine_without_waiting(self):
        scan, stops = self.run_launch([True], wait=[KeyboardInterrupt(), 0])
        self.assertEqual(scan.call_count, 0)
        self.assertEqual(len(stops), 1)

    def test_interrupting_the_wait_leaves_the_other_designs_running(self):
        scan, stops = self.run_launch([True, KeyboardInterrupt()])
        self.assertEqual(scan.call_count, 2)
        self.assertEqual(stops, [])

    def test_only_the_last_launch_stops_wine(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            pass
        with recipe.owned_lock(target, shared=True) as other, recipe.owned_lock(target, shared=True) as mine:
            self.assertFalse(recipe.last_launch(mine))
            self.assertTrue(recipe.last_launch(other))

    @unittest.skipUnless(Path('/proc/self/exe').exists(), 'needs /proc')
    def test_designer_running_matches_this_install_by_executable(self):
        root = self.root / 'managed'
        binary = root / 'toolchain/opt/wine-staging/bin/wine64-preloader'
        binary.parent.mkdir(parents=True)
        shutil.copy2(shutil.which('bash'), binary)
        elsewhere = self.root / 'elsewhere/toolchain/preloader'
        elsewhere.parent.mkdir(parents=True)
        shutil.copy2(shutil.which('bash'), elsewhere)
        def start(path, name):
            process = subprocess.Popen([name, '-c', 'read -t 30'], executable=path, stdin=subprocess.PIPE)
            self.addCleanup(process.stdin.close)
            self.addCleanup(process.wait)
            self.addCleanup(process.kill)
            return process
        windows_path = 'C:\\QSC\\Q-Sys Designer\\Q-Sys Designer.exe'
        self.assertFalse(recipe.designer_running(root))
        other = start(elsewhere, windows_path)
        helper = start(binary, 'C:\\QSC\\Q-Sys Designer\\CefSharp.BrowserSubprocess.exe')
        self.assertFalse(recipe.designer_running(root))
        other.kill(), helper.kill(), other.wait(), helper.wait()
        designer = start(binary, windows_path)
        self.assertTrue(recipe.designer_running(root))
        designer.kill(), designer.wait()
        self.assertFalse(recipe.designer_running(root))

    def test_scale_rejects_invalid_or_unusable_values(self):
        for value in ['0', '10000', 'not-a-number']:
            with self.assertRaises(argparse.ArgumentTypeError):
                recipe.scale_percent(value)
        self.assertEqual(recipe.scale_percent('200'), 200)

    def test_failed_install_preserves_prior_prefix(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            (target / 'prefix').mkdir()
            (target / 'prefix/keep.qsys').write_bytes(b'original design')
        args = argparse.Namespace(data_dir=target, installer=str(self.root / 'vendor.zip'), downloads=None, no_integrate=True)
        with patch.object(recipe, 'host_check'), patch.object(recipe, 'display_check'), \
             patch.object(recipe, 'bootstrap', side_effect=RuntimeError('network failed')):
            with self.assertRaisesRegex(RuntimeError, 'network failed'):
                recipe.install(args)
        self.assertEqual((target / 'prefix/keep.qsys').read_bytes(), b'original design')
        self.assertFalse(list(target.glob('prefix.staging-*')))

    def seed_prefix(self, root):
        prefix = root / 'prefix'
        app = prefix / recipe.APP_REL
        app.mkdir(parents=True)
        (app / recipe.EXE_NAME).write_text('vendor application')
        (prefix / '.qsys-linux-prefix').write_text(json.dumps({'schema': 1, 'scale_percent': 200}))
        (prefix / 'user.reg').write_text('user preferences')
        (prefix / 'user design.qsys').write_text('user design')
        return prefix

    @unittest.skipUnless(sys.platform == 'linux', 'GNU cp is the Linux installation backend')
    def test_reinstall_copies_user_files_and_settings_without_shared_writes(self):
        current = self.seed_prefix(self.root)
        stage = self.root / 'stage'
        with (self.root / 'log').open('w') as log:
            recipe.clone_prefix(self.root, stage, log)
        self.assertEqual((stage / 'user.reg').read_text(), 'user preferences')
        self.assertEqual((stage / 'user design.qsys').read_text(), 'user design')
        (stage / 'user design.qsys').write_text('changed copy')
        self.assertEqual((current / 'user design.qsys').read_text(), 'user design')

    def test_failed_launcher_handoff_restores_previous_prefix(self):
        current = self.seed_prefix(self.root)
        stage = self.root / 'stage'
        stage.mkdir()
        (stage / 'new').write_text('new install')
        def fail():
            raise OSError('desktop write failed')
        with self.assertRaisesRegex(OSError, 'desktop write failed'):
            recipe.commit_prefix(self.root, stage, fail)
        self.assertEqual((current / 'user design.qsys').read_text(), 'user design')
        self.assertTrue((stage / 'new').exists())
        self.assertFalse(list(self.root.glob('prefix.previous-*')))

    def test_successful_reinstall_retains_complete_previous_prefix(self):
        self.seed_prefix(self.root)
        stage = self.root / 'stage'
        stage.mkdir()
        (stage / 'new').write_text('new install')
        recipe.commit_prefix(self.root, stage, lambda: None)
        backup, = self.root.glob('prefix.previous-*')
        self.assertEqual((backup / 'user design.qsys').read_text(), 'user design')
        self.assertEqual((self.root / 'prefix/new').read_text(), 'new install')

    def test_payload_replacement_preserves_unmanaged_files_and_rejects_links(self):
        prefix = self.root / 'prefix'
        app = prefix / recipe.APP_REL
        app.mkdir(parents=True)
        (app / 'old.dll').write_text('old code')
        (app / 'mine.qsys').write_text('user data')
        recipe.prepare_payload(prefix, ['new.dll'], ['old.dll'])
        self.assertFalse((app / 'old.dll').exists())
        self.assertEqual((app / 'mine.qsys').read_text(), 'user data')
        outside = self.root / 'outside'
        outside.mkdir()
        (app / 'linked').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'symbolic link'):
            recipe.prepare_payload(prefix, ['linked/new.dll'], [])
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
            recipe.prepare_payload(prefix, [], ['../../user.reg'])

    def test_remove_preserves_data_unless_purge_is_explicit(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            self.seed_prefix(target)
        with patch.object(recipe, 'integration_paths', return_value=(self.root / 'bin', self.root / 'desktop')):
            recipe.remove(argparse.Namespace(data_dir=target, purge=False))
            self.assertEqual((target / 'prefix/user design.qsys').read_text(), 'user design')
            recipe.remove(argparse.Namespace(data_dir=target, purge=True))
        self.assertFalse(target.exists())

    def test_global_npm_symlink_is_preserved_during_desktop_integration(self):
        target = self.root / 'managed'
        target.mkdir()
        npm_bin = self.root / 'npm-entry'
        npm_bin.write_text('#!/usr/bin/env node\n')
        launcher = self.root / 'bin/qsys-linux'
        launcher.parent.mkdir()
        launcher.symlink_to(npm_bin)
        desktop = self.root / 'applications/test.desktop'
        support, fonts = recipe.support_paths()
        with patch.object(recipe, 'integration_paths', return_value=(launcher, desktop)):
            installed, _ = recipe.integration(target, support, fonts)
        self.assertTrue(launcher.is_symlink())
        self.assertEqual(launcher.resolve(), npm_bin.resolve())
        self.assertEqual(Path(installed), target / 'bin/qsys-linux')

    def test_remove_can_clean_an_owned_partial_install(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            (target / 'install.log').write_text('failed before prefix handoff')
        with patch.object(recipe, 'integration_paths', return_value=(self.root / 'bin', self.root / 'desktop')):
            recipe.remove(argparse.Namespace(data_dir=target, purge=True))
        self.assertFalse(target.exists())

    def test_installed_launcher_handles_spaces_and_shell_metacharacters(self):
        target = self.root / 'installed spaces $dollar;single\'quote'
        target.mkdir()
        launcher = self.root / 'bin/qsys-linux'
        desktop = self.root / 'applications/qsys-designer.desktop'
        support, fonts = recipe.support_paths()
        with patch.object(recipe, 'integration_paths', return_value=(launcher, desktop)):
            recipe.integration(target, support, fonts)
        result = subprocess.run([str(launcher), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('install', result.stdout)
        self.assertIn('launch %f', desktop.read_text())
        self.assertTrue((target / 'libexec/support/assemble-msi.py').is_file())

    def test_remove_cannot_delete_an_unmanaged_directory(self):
        (self.root / 'prefix').mkdir()
        (self.root / 'prefix/.qsys-linux-prefix').write_text(json.dumps({'schema': 1}))
        app = self.root / 'prefix' / recipe.APP_REL
        app.mkdir(parents=True)
        (app / recipe.EXE_NAME).write_text('fake exe')
        with self.assertRaises(RuntimeError):
            recipe.remove(argparse.Namespace(data_dir=self.root))
        self.assertTrue((app / recipe.EXE_NAME).exists())

    @unittest.skipUnless(shutil.which('desktop-file-validate'), 'desktop-file-utils not installed')
    def test_desktop_exec_escaping_passes_the_freedesktop_validator(self):
        desktop = self.root / 'test.desktop'
        command = recipe.desktop_arg('/tmp/space dollar$ backtick` quote" slash\\percent%')
        desktop.write_text('[Desktop Entry]\nType=Application\nName=Test\nExec=' + command + ' launch %f\n')
        result = subprocess.run(['desktop-file-validate', str(desktop)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
