"""Hermetic regression checks; no Wine, downloads, QSC installers, or designs."""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import struct
import zlib
import os
from pathlib import Path
import subprocess
import shutil
import signal
import tempfile
import time
import unittest
import unittest.mock
from unittest.mock import patch
import zipfile
import sys

RECIPE = Path(__file__).resolve().parents[1] / 'lib/qsys_linux.py'
spec = importlib.util.spec_from_file_location('qsys_linux', RECIPE)
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)

DESIGNER = 'C:\\QSC\\Q-Sys Designer\\Q-Sys Designer.exe'
HELPER = 'C:\\QSC\\Q-Sys Designer\\CefSharp.BrowserSubprocess.exe'
PRELOADER = 'toolchain/opt/wine-staging/bin/wine64-preloader'


def fake_png(width, height):
    """A valid PNG made here, so no QSC artwork enters the tests."""
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    rows = b''.join(b'\0' + b'\x10\x20\x30\xff' * width for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def icon_group(*entries):
    """entries: (width, height, bit depth, icon id); 256 is stored as 0, as Windows does."""
    return struct.pack('<HHH', 0, 1, len(entries)) + b''.join(
        struct.pack('<BBBBHHIH', w % 256, h % 256, 0, 0, 1, depth, 0, number) for w, h, depth, number in entries)


def fake_executable(icons, groups, magic=0x20b):
    """A minimal Windows executable whose resource section holds icons {id: bytes} and groups {id: bytes}."""
    rva, section = 0x1000, bytearray()

    def directory(node):
        start = len(section)
        section.extend(struct.pack('<IIHHHH', 0, 0, 0, 0, 0, len(node)))
        slots = []
        for key in sorted(node):
            slots.append((len(section), node[key]))
            section.extend(struct.pack('<II', key, 0))
        for slot, child in slots:
            if isinstance(child, dict):
                struct.pack_into('<I', section, slot + 4, 0x80000000 | directory(child))
            else:
                entry = len(section)
                section.extend(bytes(16))
                struct.pack_into('<I', section, slot + 4, entry)
                struct.pack_into('<II', section, entry, rva + len(section), len(child))
                section.extend(child)
        return start

    directory({3: {k: {0x409: v} for k, v in icons.items()}, 14: {k: {0x409: v} for k, v in groups.items()}})
    directories = 112 if magic == 0x20b else 96
    optional_size, pe = directories + 16 * 8, 0x40
    head = bytearray(0x200)
    head[:2] = b'MZ'
    struct.pack_into('<I', head, 0x3c, pe)
    head[pe:pe + 4] = b'PE\0\0'
    struct.pack_into('<HHIIIHH', head, pe + 4, 0x8664, 1, 0, 0, 0, optional_size, 0x22)
    struct.pack_into('<H', head, pe + 24, magic)
    struct.pack_into('<I', head, pe + 24 + directories - 4, 16)
    struct.pack_into('<II', head, pe + 24 + directories + 16, rva, len(section))
    table = pe + 24 + optional_size
    head[table:table + 8] = b'.rsrc\0\0\0'
    struct.pack_into('<IIII', head, table + 8, len(section), rva, len(section), len(head))
    return bytes(head) + bytes(section)


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

    def test_launch_names_a_missing_design(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            pass
        root = self.root.resolve()
        (root / 'not-a-folder').write_text('')
        for missing in [root / 'gone.qsys', root / 'gone-folder/a.qsys', root / 'not-a-folder/a.qsys']:
            with self.subTest(missing=missing), patch.object(recipe, 'manifest'), \
                    patch.object(recipe, 'display_check'), patch.object(recipe, 'environment', return_value={}), \
                    patch.object(recipe.subprocess, 'Popen') as start, patch.object(recipe, 'run') as winepath, \
                    patch('sys.stderr', new_callable=io.StringIO) as stderr:
                code = recipe.main(['--data-dir', str(target), 'launch', str(missing)])
                self.assertEqual(code, 1)
                self.assertEqual(stderr.getvalue(), f'[qsys-linux] ERROR: Design file not found: {missing}\n')
                start.assert_not_called()
                winepath.assert_not_called()

    def test_only_the_last_launch_stops_wine(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            pass
        with recipe.owned_lock(target, shared=True) as other, recipe.owned_lock(target, shared=True) as mine:
            self.assertFalse(recipe.last_launch(mine))
            self.assertTrue(recipe.last_launch(other))

    def start_process(self, path, name):
        process = subprocess.Popen([name, '-c', 'read -t 30'], executable=path, stdin=subprocess.PIPE)
        self.addCleanup(process.stdin.close)
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        return process

    def copy_preloader(self, root):
        binary = root / PRELOADER
        binary.parent.mkdir(parents=True, exist_ok=True)
        if not binary.exists():
            shutil.copy2(shutil.which('bash'), binary)
        return binary

    @unittest.skipUnless(Path('/proc/self/exe').exists(), 'needs /proc')
    def test_designer_running_matches_this_install_by_executable(self):
        root = self.root / 'managed'
        binary = self.copy_preloader(root)
        elsewhere = self.root / 'elsewhere/toolchain/preloader'
        elsewhere.parent.mkdir(parents=True)
        shutil.copy2(shutil.which('bash'), elsewhere)
        self.assertFalse(recipe.designer_running(root))
        other = self.start_process(elsewhere, DESIGNER)
        helper = self.start_process(binary, HELPER)
        self.assertFalse(recipe.designer_running(root))
        other.kill(), helper.kill(), other.wait(), helper.wait()
        designer = self.start_process(binary, DESIGNER)
        self.assertTrue(recipe.designer_running(root))
        designer.kill(), designer.wait()
        self.assertFalse(recipe.designer_running(root))

    def managed_install(self):
        target = self.root / 'managed'
        with recipe.owned_lock(target, create=True):
            self.seed_prefix(target)
        return target

    @unittest.skipUnless(Path('/proc/self/exe').exists(), 'needs /proc')
    def test_an_open_design_refuses_every_mutation_with_no_lock_held(self):
        target = self.managed_install()
        desktop = self.root / 'desktop'
        desktop.write_text(f'X-Qsys-Linux-Root={target}\n')
        designer = self.start_process(self.copy_preloader(target), DESIGNER)
        message = f'Q-SYS Designer is running from {target}; close every open design, then run this again'
        install_args = argparse.Namespace(data_dir=target, installer=str(self.root / 'vendor.zip'), downloads=None, no_integrate=True)
        with patch.object(recipe, 'integration_paths', return_value=(self.root / 'bin', desktop)), \
                patch.object(recipe, 'host_check'), patch.object(recipe, 'display_check'), \
                patch.object(recipe.shutil, 'disk_usage', return_value=unittest.mock.Mock(free=20 * 1024**3)), \
                patch.object(recipe, 'bootstrap', side_effect=RuntimeError('install went ahead')):
            for name, command in [('install', lambda: recipe.install(install_args)),
                                  ('scale', lambda: recipe.scale(argparse.Namespace(data_dir=target, percent=200))),
                                  ('remove', lambda: recipe.remove(argparse.Namespace(data_dir=target, purge=False))),
                                  ('purge', lambda: recipe.remove(argparse.Namespace(data_dir=target, purge=True)))]:
                with self.subTest(command=name):
                    with self.assertRaises(RuntimeError) as refused:
                        command()
                    self.assertEqual(str(refused.exception), message)
            self.assertTrue(desktop.exists())
            self.assertEqual((target / 'prefix/user design.qsys').read_text(), 'user design')
            designer.kill(), designer.wait()
            recipe.remove(argparse.Namespace(data_dir=target, purge=True))
        self.assertFalse(target.exists())

    @unittest.skipUnless(Path('/proc/self/exe').exists(), 'needs /proc')
    def test_an_open_design_is_named_when_a_launch_holds_the_lock(self):
        target = self.managed_install()
        self.start_process(self.copy_preloader(target), DESIGNER)
        with recipe.owned_lock(target, shared=True), self.assertRaisesRegex(RuntimeError, 'close every open design'):
            with recipe.owned_lock(target):
                pass

    @unittest.skipUnless(Path('/proc/self/exe').exists(), 'needs /proc')
    def test_a_crashed_designer_does_not_refuse_remove(self):
        target = self.managed_install()
        binary = self.copy_preloader(target)
        crashed = self.start_process(binary, DESIGNER)
        crashed.kill()
        # Left unreaped: a process table entry whose parent has not collected it is not a Designer.
        os.waitid(os.P_PID, crashed.pid, os.WEXITED | os.WNOWAIT)
        self.start_process(binary, HELPER)
        with patch.object(recipe, 'integration_paths', return_value=(self.root / 'bin', self.root / 'desktop')):
            recipe.remove(argparse.Namespace(data_dir=target, purge=True))
        self.assertFalse(target.exists())

    def test_mutations_run_on_a_system_with_no_proc(self):
        target = self.managed_install()
        with patch.object(recipe, 'PROC', self.root / 'no-proc'), \
                patch.object(recipe, 'integration_paths', return_value=(self.root / 'bin', self.root / 'desktop')):
            self.assertFalse(recipe.designer_running(target))
            recipe.remove(argparse.Namespace(data_dir=target, purge=True))
        self.assertFalse(target.exists())

    def ctrl_c_on_the_wait(self, detached):
        """Runs launch as a process and signals its process group as a terminal does. Bash stands in for Designer."""
        target = self.managed_install()
        preloader = self.copy_preloader(target)
        pid_file = self.root / 'designer.pid'
        wine = target / 'toolchain/opt/wine-staging/bin/wine'
        wine.write_text(f"""#!{sys.executable}
import pathlib, subprocess
design = subprocess.Popen([{DESIGNER!r}, '-c', 'for i in {{1..60}}; do sleep 1; done'], executable={str(preloader)!r},
                          stdin=subprocess.DEVNULL, start_new_session={detached})
pathlib.Path({str(pid_file)!r}).write_text(str(design.pid))
""")
        wine.chmod(0o755)
        tools = self.root / 'tools'
        tools.mkdir()
        (tools / 'xdpyinfo').write_text('#!/bin/sh\n')
        (tools / 'xdpyinfo').chmod(0o755)
        env = dict(os.environ, DISPLAY=':0', HOME=str(self.root), XDG_DATA_HOME=str(self.root / 'data'),
                   PATH=f'{tools}:{os.environ["PATH"]}')
        launch = subprocess.Popen([sys.executable, RECIPE, '--data-dir', target, 'launch'], env=env, text=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                  preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))
        self.addCleanup(launch.kill)
        for line in launch.stdout:
            if 'Waiting for the other open designs' in line:
                break
        else:
            self.fail(f'launch never reached the wait: {launch.stderr.read()}')
        design = int(pid_file.read_text())
        def end_design():
            with contextlib.suppress(ProcessLookupError):
                os.kill(design, signal.SIGKILL)
        self.addCleanup(end_design)
        os.killpg(launch.pid, signal.SIGINT)
        launch.communicate(timeout=30)
        self.assertEqual(launch.returncode, 130)
        remove = [sys.executable, RECIPE, '--data-dir', target, 'remove', '--purge']
        return target, end_design, lambda: subprocess.run([str(a) for a in remove], env=env, capture_output=True, text=True)

    def wait_until_closed(self, target):
        deadline = time.monotonic() + 10
        while recipe.designer_running(target):
            self.assertLess(time.monotonic(), deadline, 'the design did not end')
            time.sleep(0.05)

    @unittest.skipUnless(Path('/proc/self/exe').exists(), 'needs /proc')
    def test_remove_refuses_a_design_left_open_after_ctrl_c_on_the_wait(self):
        target, end_design, remove = self.ctrl_c_on_the_wait(detached=True)
        self.assertTrue(recipe.designer_running(target))
        refused = remove()
        self.assertEqual(refused.returncode, 1, refused.stdout)
        self.assertEqual(refused.stderr, f'[qsys-linux] ERROR: Q-SYS Designer is running from {target}; '
                                         'close every open design, then run this again\n')
        self.assertEqual((target / 'prefix/user design.qsys').read_text(), 'user design')
        end_design()
        self.wait_until_closed(target)
        removed = remove()
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertFalse(target.exists())

    @unittest.skipUnless(Path('/proc/self/exe').exists(), 'needs /proc')
    def test_remove_runs_when_ctrl_c_also_ended_the_design(self):
        target, _, remove = self.ctrl_c_on_the_wait(detached=False)
        self.wait_until_closed(target)
        removed = remove()
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertFalse(target.exists())

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

    def install_executable(self, target, data):
        exe = target / 'prefix' / recipe.APP_REL / recipe.EXE_NAME
        exe.parent.mkdir(parents=True)
        exe.write_bytes(data)

    def integrate(self, target):
        launcher, desktop = self.root / 'bin/qsys-linux', self.root / 'applications/qsys-designer.desktop'
        support, fonts = recipe.support_paths()
        output = io.StringIO()
        with patch.object(recipe, 'integration_paths', return_value=(launcher, desktop)), \
                contextlib.redirect_stdout(output):
            recipe.integration(target, support, fonts)
        return desktop, output.getvalue()

    def test_desktop_entry_uses_designer_icon_and_window_class(self):
        target = self.root / 'data spaces\\back'
        with recipe.owned_lock(target, create=True):
            pass
        largest = fake_png(48, 48)
        self.install_executable(target, fake_executable(
            {1: fake_png(32, 32), 2: struct.pack('<IiiHH', 40, 256, 512, 1, 32) + bytes(64), 3: largest},
            {1: icon_group((32, 32, 32, 1), (256, 256, 32, 2), (48, 48, 32, 3))}))
        desktop, output = self.integrate(target)
        entry = desktop.read_text()
        # The 256-pixel entry is a bitmap, so the largest PNG is used.
        self.assertEqual((target / recipe.ICON_FILE).read_bytes(), largest)
        self.assertIn('\nIcon=' + str(target / recipe.ICON_FILE).replace('\\', '\\\\') + '\n', entry)
        self.assertIn('\nStartupWMClass=q-sys designer.exe\n', entry)
        self.assertTrue(entry.endswith(f'X-Qsys-Linux-Root={target}\n'))
        self.assertNotIn('WARNING', output)
        with patch.object(recipe, 'integration_paths', return_value=(self.root / 'bin/qsys-linux', desktop)):
            recipe.remove(argparse.Namespace(data_dir=target, purge=False))
        self.assertFalse(desktop.exists())
        self.assertFalse((target / recipe.ICON_FILE).exists())
        self.assertTrue((target / 'prefix' / recipe.APP_REL / recipe.EXE_NAME).exists())

    def test_the_first_icon_group_is_the_program_icon(self):
        first, second = fake_png(16, 16), fake_png(64, 64)
        for magic in (0x20b, 0x10b):
            with self.subTest(magic=magic):
                data = fake_executable({1: first, 2: second},
                                       {7: icon_group((16, 16, 32, 1)), 9: icon_group((64, 64, 32, 2))}, magic)
                self.assertEqual(recipe.executable_icon(data), first)

    def test_a_damaged_executable_raises_only_value_errors(self):
        data = fake_executable({1: fake_png(16, 16)}, {1: icon_group((16, 16, 32, 1))})
        for length in range(len(data)):
            with self.subTest(length=length), self.assertRaises(ValueError):
                recipe.executable_icon(data[:length])
        for icons, groups in [({1: fake_png(16, 16)}, {1: icon_group((16, 16, 32, 2))}),
                              ({1: b'not an image'}, {1: icon_group((16, 16, 32, 1))}),
                              ({1: fake_png(16, 16)}, {1: b'\0\0\1\0\5\0'})]:
            with self.subTest(groups=groups), self.assertRaises(ValueError):
                recipe.executable_icon(fake_executable(icons, groups))

    def test_a_missing_icon_falls_back_to_a_generic_icon_and_installs(self):
        for name, data in [('missing', None), ('not windows', b'#!/bin/sh\n'),
                           ('no png', fake_executable({1: b'bitmap'}, {1: icon_group((16, 16, 32, 1))}))]:
            with self.subTest(name=name):
                target = self.root / name
                with recipe.owned_lock(target, create=True):
                    pass
                if data is not None:
                    self.install_executable(target, data)
                desktop, output = self.integrate(target)
                self.assertIn('\nIcon=applications-engineering\n', desktop.read_text())
                self.assertIn('WARNING: Could not read the Designer icon', output)
                self.assertFalse((target / recipe.ICON_FILE).exists())
                desktop.unlink()

    @unittest.skipUnless(shutil.which('desktop-file-validate'), 'desktop-file-utils not installed')
    def test_the_installed_desktop_entry_passes_the_freedesktop_validator(self):
        target = self.root / 'data spaces\\back%percent'
        with recipe.owned_lock(target, create=True):
            pass
        self.install_executable(target, fake_executable({1: fake_png(16, 16)}, {1: icon_group((16, 16, 32, 1))}))
        desktop, _ = self.integrate(target)
        result = subprocess.run(['desktop-file-validate', str(desktop)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(shutil.which('desktop-file-validate'), 'desktop-file-utils not installed')
    def test_desktop_exec_escaping_passes_the_freedesktop_validator(self):
        desktop = self.root / 'test.desktop'
        command = recipe.desktop_arg('/tmp/space dollar$ backtick` quote" slash\\percent%')
        desktop.write_text('[Desktop Entry]\nType=Application\nName=Test\nExec=' + command + ' launch %f\n')
        result = subprocess.run(['desktop-file-validate', str(desktop)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
