#!/usr/bin/env python3
"""Packaged Designer acceptance. No vendor payload or fixture is bundled.

Full remains incomplete until Lua editor, UCI and schematic content assertions
are implemented. Screenshots prove rendering only, never those missing checks.
"""
import argparse
import ctypes as C
import ctypes.util
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
import zlib

DATA = Path('/work/qsys-designer')
REQUIRED_BASIC = ('cli-help', 'install', 'doctor', 'launch', 'render', 'resize')
FIXTURE_CASES = ('save-dialog', 'dialog-clipboard', 'save', 'open-dialog', 'reopen', 'emulate', 'qrc')
FULL_GAPS = {
    'lua-edit': 'No stable Lua editor locator and persisted script content assertion implemented',
    'lua-clipboard': 'Dialog clipboard check does not establish clipboard operation inside the Lua editor',
    'uci-render': 'No stable UCI selection locator or UCI-specific content assertion implemented',
    'schematic-edit': 'No deterministic schematic placement/wiring and persisted-result assertion implemented',
}


class Skip(Exception):
    pass


def overall(cases, profile, has_design):
    required = set(REQUIRED_BASIC)
    if has_design or profile == 'full':
        required.update(FIXTURE_CASES)
    if profile == 'full':
        required.update(FULL_GAPS)
    states = {c['name']: c['status'] for c in cases}
    if any(c['status'] == 'failed' for c in cases):
        return 'failed'
    return 'passed' if all(states.get(n) == 'passed' for n in required) else 'incomplete'


def wait_for(fn, timeout, message):
    deadline = time.monotonic() + timeout
    while True:
        value = fn()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise RuntimeError(message)
        time.sleep(0.2)  # polling interval, not evidence of readiness


def xcapture(window, target):
    """Direct XGetImage, not xwd. Save PNG and reject uniform/near-blank clients."""
    x = C.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
    x.XOpenDisplay.argtypes = [C.c_char_p]
    x.XOpenDisplay.restype = C.c_void_p
    x.XCloseDisplay.argtypes = [C.c_void_p]
    x.XGetGeometry.argtypes = [C.c_void_p, C.c_ulong] + [C.c_void_p] * 7
    x.XGetImage.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_ulong, C.c_int]
    x.XGetImage.restype = C.c_void_p
    x.XGetPixel.argtypes = [C.c_void_p, C.c_int, C.c_int]
    x.XGetPixel.restype = C.c_ulong
    x.XDestroyImage.argtypes = [C.c_void_p]
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError('XOpenDisplay failed')
    image = None
    try:
        root, left, top = C.c_ulong(), C.c_int(), C.c_int()
        width, height, border, depth = (C.c_uint() for _ in range(4))
        if not x.XGetGeometry(display, int(window), C.byref(root), C.byref(left), C.byref(top),
                              C.byref(width), C.byref(height), C.byref(border), C.byref(depth)):
            raise RuntimeError('XGetGeometry failed')
        w, h = width.value, height.value
        if w < 640 or h < 400 or depth.value != 24:
            raise RuntimeError(f'Expected usable 24-bit Designer client, got {w}x{h} depth {depth.value}')
        image = x.XGetImage(display, int(window), 0, 0, w, h, C.c_ulong(-1).value, 2)
        if not image:
            raise RuntimeError('XGetImage failed')
        # Standard 24-bit TrueColor Xvfb visual; do not silently decode other visuals.
        samples = [x.XGetPixel(image, col, row) for row in range(h // 10, h * 9 // 10, max(1, h // 80))
                   for col in range(w // 10, w * 9 // 10, max(1, w // 100))]
        colors = len(set(samples))
        dominant = max(Counter(samples).values()) / len(samples)
        if colors < 16 or dominant > 0.99:
            raise RuntimeError(f'Blank/near-uniform render: {colors} colors, dominant fraction {dominant:.3f}')
        rows = bytearray()
        for row in range(h):
            rows.append(0)  # PNG filter None
            for col in range(w):
                pixel = x.XGetPixel(image, col, row)
                rows.extend(((pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255))
        def chunk(kind, value):
            return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', zlib.crc32(kind + value))
        png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', w, h, 8, 2, 0, 0, 0))
               + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
        target.write_bytes(png)
        return {'width': w, 'height': h, 'sampleColors': colors, 'dominantFraction': dominant,
                'sha256': hashlib.sha256(png).hexdigest()}
    finally:
        if image:
            x.XDestroyImage(image)
        x.XCloseDisplay(display)


class Smoke:
    def __init__(self, args):
        self.args = args
        self.out = args.artifacts
        self.out.mkdir(parents=True, exist_ok=True)
        self.result = {'schemaVersion': 1, 'status': 'incomplete', 'profile': args.profile,
                       'cases': [], 'versions': {'python': sys.version.split()[0]}, 'timings': {}, 'artifacts': {}}
        self.started = time.monotonic()
        self.child = None
        self.log = None
        self.window = None
        self.command_child = None
        self.clipboard_owner = None
        self.emulated = False
        self.saved = Path('/work/smoke design with spaces.qsys')

    def flush(self):
        self.result['status'] = overall(self.result['cases'], self.args.profile, bool(self.args.design))
        self.result['timings']['totalMs'] = round((time.monotonic() - self.started) * 1000)
        tmp = self.out / 'result.json.tmp'
        tmp.write_text(json.dumps(self.result, indent=2) + '\n')
        tmp.replace(self.out / 'result.json')

    def case(self, name, fn):
        at = time.monotonic()
        record = {'name': name}
        try:
            evidence = fn()
            record['status'] = 'passed'
            if evidence is not None:
                record['evidence'] = evidence
        except Skip as error:
            record.update(status='skipped', reason=str(error))
        except Exception as error:
            record.update(status='failed', reason=str(error))
            if self.window:
                try:
                    record['visibleWindows'] = []
                    for window in self.clients():
                        try:
                            record['visibleWindows'].append({'window': window, 'title': self.title(window)})
                        except Exception:
                            pass
                    filename = name + '-failure.png'
                    self.run(['import', '-window', 'root', self.out / filename], check=False)
                    self.result['artifacts'][name + '-failure'] = filename
                except Exception:
                    pass  # Diagnostic failures must not replace the assertion failure.
        record['durationMs'] = round((time.monotonic() - at) * 1000)
        self.result['cases'].append(record)
        self.flush()
        if getattr(self, 'interrupted', False) and name != 'cleanup':
            raise InterruptedError('Smoke interrupted; no further acceptance operations attempted')
        return record['status'] == 'passed'

    def skip(self, name, reason):
        self.result['cases'].append({'name': name, 'status': 'skipped', 'reason': reason})
        self.flush()

    def run(self, argv, timeout=30, input=None, check=True):
        if getattr(self, 'interrupted', False):
            timeout = min(timeout, 1)
        self.command_child = subprocess.Popen([str(a) for a in argv], stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        child = self.command_child
        try:
            stdout, stderr = child.communicate(input=input, timeout=timeout)
            if check and child.returncode:
                raise RuntimeError(f'{argv[0]} exited {child.returncode}: {stderr[-3000:]} {stdout[-3000:]}')
            return stdout
        finally:
            if child.poll() is None:
                self.stop_process(child, grace=3 if getattr(self, 'interrupted', False) else 35)
            self.command_child = None

    @staticmethod
    def stop_process(child, grace=35):
        if not child:
            return
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            pass
        # The CLI may have exited before Wine/CEF descendants; reap our whole
        # session even then. Never target an ambient Wine process or server.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=1)

    def cli(self, *argv, timeout=60):
        return self.run(['qsys-linux', '--data-dir', DATA, *argv], timeout=timeout)

    def logged_cli(self, name, *argv, timeout=60):
        # Persist command output on both success and failure, without pipe buffering large install logs.
        path = self.out / f'{name}.log'
        self.result['artifacts'][name] = path.name
        with path.open('w') as log:
            self.command_child = subprocess.Popen(['qsys-linux', '--data-dir', str(DATA), *map(str, argv)],
                                                  stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            child = self.command_child
            try:
                code = child.wait(timeout=timeout)
                if code:
                    raise RuntimeError(f'Packaged CLI exited {code}; see {path.name}')
            finally:
                if child.poll() is None:
                    self.stop_process(child, grace=3 if getattr(self, 'interrupted', False) else 35)
                self.command_child = None

    def windows(self, pattern):
        output = self.run(['xdotool', 'search', '--onlyvisible', '--name', pattern], check=False)
        return [line for line in output.splitlines() if line.isdigit()]

    def title(self, window):
        return self.run(['xdotool', 'getwindowname', window]).strip()

    def activate(self, window):
        self.run(['xdotool', 'windowactivate', '--sync', window])
        self.run(['xdotool', 'windowfocus', '--sync', window])

    def key(self, keys):
        self.run(['xdotool', 'key', '--clearmodifiers', keys])

    def launch(self, design=None):
        self.log = (self.out / 'launch.log').open('a')
        self.result['artifacts']['launch'] = 'launch.log'
        argv = ['qsys-linux', '--data-dir', str(DATA), 'launch']
        if design:
            argv.append(str(design))
        self.child = subprocess.Popen(argv, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        def ready():
            if self.child.poll() is not None:
                raise RuntimeError(f'Packaged launch exited {self.child.returncode}; see launch.log')
            candidates = self.windows(r'Q-SYS Designer|Q-Sys Designer')
            for window in candidates:
                title = self.title(window)
                if (not design or design.stem.casefold() in title.casefold()) and self.geometry(window)[0] >= 640:
                    return window
        self.window = wait_for(ready, 180, 'Designer document window did not become ready; modal/startup UI may block it')
        self.activate(self.window)
        return {'window': self.window, 'title': self.title(self.window)}

    def geometry(self, window):
        values = dict(line.split('=', 1) for line in self.run(['xdotool', 'getwindowgeometry', '--shell', window]).splitlines() if '=' in line)
        return int(values['WIDTH']), int(values['HEIGHT'])

    def render(self, name='render'):
        path = self.out / f'{name}.png'
        previous, since = None, None
        def stable():
            nonlocal previous, since
            capture = self.capture_if_ready(path)
            if not capture:
                previous, since = None, None
                return None
            now = time.monotonic()
            if capture['sha256'] != previous:
                previous, since = capture['sha256'], now
                return None
            if now - since < 1:
                return None
            return {**capture, 'stableMs': round((now - since) * 1000),
                    'assertion': 'stable nonblank Designer frame; no fixture-content assertion'}
        result = wait_for(stable, 45, 'Designer did not produce a stable nonblank frame')
        self.result['artifacts'][name] = path.name
        return result

    def capture_if_ready(self, path):
        try:
            return xcapture(self.window, path)
        except RuntimeError:
            return None

    def resize(self):
        self.activate(self.window)
        state = self.run(['xprop', '-id', self.window, '_NET_WM_STATE'])
        if '_NET_WM_STATE_MAXIMIZED' in state:
            self.key('alt+F10')  # Openbox unmaximize; state is checked, never blindly toggled.
            wait_for(lambda: '_NET_WM_STATE_MAXIMIZED' not in self.run(
                ['xprop', '-id', self.window, '_NET_WM_STATE']), 10, 'Window remained maximized')
        before = self.geometry(self.window)
        target = (1100, 760) if before != (1100, 760) else (1200, 800)
        self.run(['xdotool', 'windowsize', self.window, *map(str, target)])
        wait_for(lambda: self.geometry(self.window) == target, 15, 'Window did not reach requested client dimensions')
        evidence = self.render('resized')
        return {'before': before, 'after': target, 'render': evidence}

    def clients(self):
        # File dialogs in Wine may have an empty title. Enumerate managed clients
        # rather than using a title regex that omits those dialogs entirely.
        output = self.run(['xprop', '-root', '_NET_CLIENT_LIST'], check=False)
        return [str(int(value, 16)) for value in re.findall(r'0x[0-9a-fA-F]+', output)]

    def dialog(self, key, pattern):
        before = set(self.clients())
        self.activate(self.window)
        self.key(key)
        def find():
            named = self.windows(pattern)
            if named:
                return named[-1]
            for window in self.clients():
                if window in before:
                    continue
                transient = self.run(['xprop', '-id', window, 'WM_TRANSIENT_FOR'], check=False)
                parents = re.findall(r'0x[0-9a-fA-F]+', transient)
                if any(int(parent, 16) == int(self.window) for parent in parents):
                    return window
        try:
            window = wait_for(find, 20, f'{pattern} dialog did not open')
        except RuntimeError as error:
            # Preserve all visible window titles and the desktop on locator failures;
            # a modal can block a command while the main client still renders.
            visible = []
            for w in self.clients():
                try:
                    visible.append({'window': w, 'title': self.title(w),
                                    'properties': self.run(['xprop', '-id', w, 'WM_TRANSIENT_FOR', 'WM_CLASS'], check=False)})
                except Exception:
                    visible.append({'window': w, 'title': '<closed during diagnostics>'})
            try:
                self.run(['import', '-window', 'root', self.out / 'dialog-failure.png'], check=False)
                self.result['artifacts']['dialog-failure'] = 'dialog-failure.png'
            except Exception:
                pass  # Keep the original locator failure even if capture also fails.
            raise RuntimeError(f'{error}; visible windows: {visible}') from error
        self.dialog_window = window
        self.activate(window)
        return window

    def put_clipboard(self, text):
        if self.clipboard_owner:
            self.clipboard_owner.terminate()
            self.clipboard_owner.wait(timeout=5)
        # Remain alive as selection owner; no xclip daemon outlives the smoke process.
        self.clipboard_owner = subprocess.Popen(['xclip', '-selection', 'clipboard', '-in', '-quiet'],
                                                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.clipboard_owner.stdin.write(text.encode())
        self.clipboard_owner.stdin.close()
        wait_for(lambda: self.run(['xclip', '-selection', 'clipboard', '-out'], check=False) == text,
                 5, 'X clipboard ownership failed')

    def filename(self, text):
        self.key('alt+n')
        self.key('ctrl+a')
        self.put_clipboard(text)
        self.key('ctrl+v')
        self.key('ctrl+a')
        # Replace the selection source before copy, so a no-op Ctrl+C cannot pass.
        self.put_clipboard('qsys-smoke-copy-must-replace-this-sentinel')
        self.key('ctrl+c')
        wait_for(lambda: self.run(['xclip', '-selection', 'clipboard', '-out'], check=False) == text,
                 10, 'Dialog filename did not roundtrip through Designer and X clipboard')

    def save(self):
        if self.saved.exists():
            raise RuntimeError('Refusing to overwrite an existing smoke output; use a fresh work volume')
        self.key('Return')
        wait_for(lambda: self.saved.is_file() and self.saved.stat().st_size > 64, 30, 'Save dialog did not create a nonempty .qsys')
        wait_for(lambda: self.saved.stem.casefold() in self.title(self.window).casefold(), 20, 'Document title did not reflect saved path')
        return {'bytes': self.saved.stat().st_size, 'sha256': hashlib.sha256(self.saved.read_bytes()).hexdigest()}

    def reopen(self):
        self.key('Return')
        wait_for(lambda: self.dialog_window not in self.clients(), 30, 'Open dialog remained visible')
        def opened_document():
            # Designer can create another top-level document window for Open.
            # Save As already changed the original window's title, so finding
            # this different source title establishes an in-app open.
            for window in self.windows(r'Q-SYS Designer|Q-Sys Designer'):
                if self.source_design.stem.casefold() in self.title(window).casefold() and self.geometry(window)[0] >= 640:
                    self.window = window
                    self.activate(window)
                    return True
        # Open starts another Designer instance; allow the same startup budget
        # as launch(), while still requiring the different document's title.
        wait_for(opened_document, 180, 'Open dialog did not load the selected different document')
        opened = {'title': self.title(self.window), 'frame': self.render('opened')}
        # Fresh process also verifies that loading is from the persisted file, not only memory.
        self.stop_designer()
        relaunched = self.launch(self.saved)
        return {'inAppOpen': opened, 'freshProcess': relaunched, 'frame': self.render('reopened')}

    def emulate(self):
        # No pre-existing QRC listener is permitted: the observed endpoint must be our instance.
        def listening():
            try:
                with socket.create_connection(('127.0.0.1', 1710), timeout=0.5):
                    return True
            except OSError:
                return False
        if listening():
            raise RuntimeError('QRC port already listening before Emulate; refusing an ambiguous target')
        installation = self.result['versions'].get('installation', {})
        if installation.get('designer') != '10.5.1' or installation.get('scale_percent') != 100:
            raise RuntimeError('File-menu automation requires Designer 10.5.1 at 100% scale')
        self.activate(self.window)
        # Function keys are not reliably routed through this Wine/WPF desktop.
        # Open the pinned layout's File menu and use its Emulate access key.
        # A click/key sequence is not a pass: the actual listener and the QRC
        # helper's IsEmulator/read/write assertions remain the acceptance gates.
        self.run(['xdotool', 'mousemove', '--window', self.window, '18', '41', 'click', '1'])
        self.key('e')
        try:
            wait_for(listening, 90, 'File > Emulate did not start local QRC')
        except RuntimeError:
            try:
                # Capture Check Design separately instead of diagnosing every
                # failure as input focus. Do not dismiss unknown modals.
                before = set(self.clients())
                self.run(['xdotool', 'mousemove', '--window', self.window, '18', '41', 'click', '1'])
                self.run(['xdotool', 'mousemove', '--window', self.window, '70', '196', 'click', '1'])
                wait_for(lambda: set(self.clients()) - before, 10, 'Check Design did not show a report')
                self.run(['import', '-window', 'root', self.out / 'check-design-failure.png'])
                self.result['artifacts']['check-design-failure'] = 'check-design-failure.png'
            except Exception:
                pass
            raise
        self.emulated = True
        return {'host': '127.0.0.1', 'port': 1710, 'inputMethod': 'File > Emulate access key',
                'guard': 'QRC case must additionally verify IsEmulator'}

    def qrc(self):
        helper = Path(__file__).with_name('qrc-smoke.mjs')
        output = self.out / 'qrc.json'
        try:
            self.run(['node', helper, '--host', '127.0.0.1', '--port', '1710', '--output', output], timeout=90)
        finally:
            if output.is_file():
                self.result['artifacts']['qrc'] = output.name
                self.result['qrc'] = json.loads(output.read_text())
        if self.result.get('qrc', {}).get('status') != 'passed':
            raise RuntimeError('QRC receipt absent or not passed')

    def stop_designer(self):
        previous = set(self.windows(r'Q-SYS Designer|Q-Sys Designer')) if self.child else set()
        if self.child:
            self.stop_process(self.child, grace=3 if getattr(self, 'interrupted', False) else 35)
            self.child = None
        if self.log:
            self.log.close()
            self.log = None
        recipe_path = Path('/usr/local/lib/node_modules/qsys-linux/lib/qsys_linux.py')
        if (DATA / '.qsys-linux-owned').is_file() and (DATA / 'prefix/.qsys-linux-prefix').is_file() and recipe_path.is_file():
            spec = importlib.util.spec_from_file_location('installed_qsys_recipe', recipe_path)
            recipe = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(recipe)
            _, server = recipe.wine_paths(DATA)
            env = recipe.environment(DATA, DATA / 'prefix')
            timeout = 1 if getattr(self, 'interrupted', False) else 30
            if server.is_file():
                subprocess.run([str(server), '-k'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
                subprocess.run([str(server), '-w'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout, check=True)
            remaining = previous.intersection(self.windows(r'Q-SYS Designer|Q-Sys Designer'))
            if remaining:
                raise RuntimeError(f'Designer clients survived prefix shutdown: {sorted(remaining)}')
            prefix_processes = []
            for proc in Path('/proc').iterdir():
                if not proc.name.isdigit() or int(proc.name) == os.getpid():
                    continue
                try:
                    environment = (proc / 'environ').read_bytes().split(b'\0')
                    if b'WINEPREFIX=' + str(DATA / 'prefix').encode() in environment:
                        state = (proc / 'stat').read_text().split(') ', 1)[1].split()[0]
                        if state != 'Z':
                            prefix_processes.append(proc.name)
                except (OSError, ValueError, IndexError):
                    continue
            if prefix_processes:
                raise RuntimeError(f'Processes survived prefix shutdown: {prefix_processes}')

    def execute(self):
        self.flush()
        try:
            if not self.case('cli-help', lambda: self.logged_cli('cli-help', '--help')):
                return
            if not self.args.installer.is_file():
                self.case('install', lambda: (_ for _ in ()).throw(RuntimeError('Installer input is missing')))
                return
            if not self.case('install', self.install):
                return
            if not self.case('doctor', lambda: self.logged_cli('doctor', 'doctor')):
                return
            self.case('versions', lambda: self.record_versions())
            design = None
            if self.args.design:
                design = Path('/work/input design with spaces.qsys')
                self.source_design = design
                def stage():
                    if design.exists():
                        raise RuntimeError('Use a fresh work volume: staged design already exists')
                    shutil.copyfile(self.args.design, design)
                if not self.case('stage-design', stage):
                    return
            if not self.case('launch', lambda: self.launch(design)):
                return
            self.case('render', self.render)
            self.case('resize', self.resize)
            if design:
                if not self.case('save-dialog', lambda: {'window': self.dialog('ctrl+shift+s', r'^Save As$|^Save (Design|File)')}):
                    return
                if not self.case('dialog-clipboard', lambda: self.filename('Z:' + str(self.saved).replace('/', '\\'))):
                    return
                if not self.case('save', self.save):
                    return
                if not self.case('open-dialog', lambda: {'window': self.dialog('ctrl+o', r'^Open$|^Open (Design|File)')}):
                    return
                if not self.case('open-path', lambda: self.filename('Z:' + str(self.source_design).replace('/', '\\'))):
                    return
                if not self.case('reopen', self.reopen):
                    return
                if self.case('emulate', self.emulate):
                    self.case('qrc', self.qrc)
        finally:
            # Cleanup itself is a case: leaked Designer processes must not be reported green.
            self.case('cleanup', self.cleanup)
            present = {c['name'] for c in self.result['cases']}
            for name in (*REQUIRED_BASIC, *FIXTURE_CASES, *FULL_GAPS):
                if name not in present:
                    reason = FULL_GAPS.get(name, 'Prerequisite failed or no --design supplied; operation not attempted')
                    self.skip(name, reason)
            for name in ('install.log', 'designer.log'):
                source = DATA / name
                if source.is_file():
                    try:
                        shutil.copyfile(source, self.out / f'recipe-{name}')
                    except OSError as error:
                        self.result['cases'].append({'name': 'collect-' + name, 'status': 'failed', 'reason': str(error)})
                        continue
                    self.result['artifacts'][f'recipe-{name}'] = f'recipe-{name}'
            self.flush()

    def install(self):
        receipt = getattr(self.args, 'provisioning_receipt', None)
        if not receipt:
            return self.logged_cli('install', 'install', self.args.installer,
                                   '--no-integrate', '--downloads', '/cache', timeout=1800)
        # Credit a real preceding install only when it belongs to this run,
        # input and fresh prefix. This is not a skip/preinstalled shortcut.
        from execution import digest, read_json
        record = read_json(receipt)
        if (record.get('schemaVersion') != 1 or record.get('status') != 'passed'
                or record.get('runId') != os.environ.get('QSYS_SMOKE_RUN_ID')
                or record.get('execution') != os.environ.get('QSYS_PROVISIONING_EXECUTION', record.get('execution'))
                or record.get('dataDir') != str(DATA)
                or record.get('installerSha256') != digest(self.args.installer)
                or record.get('manifestSha256') != digest(DATA / 'prefix/.qsys-linux-prefix')):
            raise RuntimeError('Provisioning receipt does not match this run, installer and prefix')
        self.result['artifacts'].update(phases='phases.json', provisioning='provisioning.json', install='install.log')
        return {'phase': 'provisioning', 'execution': record['execution'],
                'receiptSha256': digest(receipt), 'cacheBefore': record['cacheBefore'], 'cacheAfter': record['cacheAfter']}

    def record_versions(self):
        installation = json.loads(self.cli('status'))
        files = installation.pop('app_files', [])
        installation['appFileCount'] = len(files)
        installation['luaxFileCount'] = sum(name.endswith('.luax') for name in files)
        self.result['versions']['installation'] = installation
        self.result['versions']['node'] = self.run(['node', '--version']).strip()
        display = self.run(['xdpyinfo'])
        self.result['versions']['display'] = {'name': os.environ.get('DISPLAY'),
                                              'dimensions': re.findall(r'dimensions:\s+(\d+x\d+)', display)}

    def record_resources(self):
        evidence = {}
        for name in ('memory.peak', 'memory.swap.peak', 'memory.events', 'memory.stat', 'pids.peak'):
            try:
                evidence[name] = (Path('/sys/fs/cgroup') / name).read_text().strip()
            except OSError:
                evidence[name] = None
        for name in ('/work', '/dev/shm'):
            usage = shutil.disk_usage(name)
            evidence[name] = {'totalBytes': usage.total, 'usedBytes': usage.used, 'freeBytes': usage.free}
        if DATA.is_dir() and not getattr(self, 'interrupted', False):
            try:
                evidence['installationBytes'] = int(self.run(['du', '-sb', DATA]).split()[0])
            except Exception as error:
                evidence['installationSizeError'] = str(error)
        self.result['resources'] = evidence

    def cleanup(self):
        try:
            try:
                self.stop_designer()
            finally:
                self.record_resources()
        finally:
            if self.command_child:
                self.stop_process(self.command_child, grace=3 if getattr(self, 'interrupted', False) else 35)
            if self.clipboard_owner:
                self.clipboard_owner.terminate()
                self.clipboard_owner.wait(timeout=1)
        if self.emulated:
            try:
                with socket.create_connection(('127.0.0.1', 1710), timeout=0.5):
                    raise RuntimeError('Local QRC still listening after Designer teardown')
            except OSError:
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installer', type=Path, default=Path('/input/installer.zip'))
    parser.add_argument('--design', type=Path)
    parser.add_argument('--artifacts', type=Path, default=Path('/artifacts'))
    parser.add_argument('--profile', choices=('basic', 'full'), default='basic')
    parser.add_argument('--provisioning-receipt', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    smoke = Smoke(args)
    def interrupted(signum, _frame):
        smoke.interrupted = True
        raise InterruptedError(f'Interrupted by signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        smoke.execute()
    except Exception as error:
        smoke.result['cases'].append({'name': 'harness', 'status': 'failed', 'reason': str(error)})
        smoke.flush()
    return 0 if smoke.result['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
