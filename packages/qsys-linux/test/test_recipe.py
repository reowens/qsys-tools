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

    def test_mutation_lock_protects_an_active_launch(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            with self.assertRaisesRegex(RuntimeError, 'running'), recipe.owned_lock(target):
                pass

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
