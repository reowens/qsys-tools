#!/usr/bin/env python3
"""Per-user Linux Wine recipe. Contains no QSC software or design fixtures."""
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Robert Owens
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import zipfile

SCHEMA = 1
WINE_VERSION = '11.20'
DOTNET_VERSION = '10.0.14'
WINE_ARTIFACT = (
    'https://dl.winehq.org/wine-builds/ubuntu/pool/main/w/wine-staging/wine-staging_11.20~resolute-1_amd64.deb',
    'sha256', '0429ca26cf940f78ae17bf5279779dffdc675878f07180c570bf9a34cdeb24c1')
RUNTIMES = [
    ('https://builds.dotnet.microsoft.com/dotnet/WindowsDesktop/10.0.14/windowsdesktop-runtime-10.0.14-win-x64.exe',
     'sha512', '337dacab1636219147b3fe75e451bf5b1c17bca2c86328266d40c4ad1ff0a1e8391c4746ca7a5b702b65b61e8bfe834566cfc1b548cc10aef90b441357b10b69'),
    ('https://builds.dotnet.microsoft.com/dotnet/aspnetcore/Runtime/10.0.14/aspnetcore-runtime-10.0.14-win-x64.exe',
     'sha512', '90045a7969d70453ac973ec3858105118e974f415c7cbd1a3cd7800b7442b291ea9f5b388a4ab79ab0d118e9fd330c9548a7e028d6d0e84daddec670a16bbb53'),
]
HELPER_PACKAGES = ['7zip', 'msitools', 'libmsi-1.0-0', 'libgcab-1.0-0', 'icoutils']
APP_REL = Path('drive_c/QSC/Q-Sys Designer')
EXE_NAME = 'Q-Sys Designer.exe'


def say(message):
    print(f'[qsys-linux] {message}', flush=True)


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def artifact(spec, downloads):
    url, algorithm, expected = spec
    target = downloads / url.rsplit('/', 1)[1]
    if not target.exists():
        say(f'Downloading {target.name}')
        temporary = target.with_name(target.name + '.partial')
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        if digest(temporary, algorithm) != expected:
            temporary.unlink()
            raise RuntimeError(f'Checksum mismatch: {target.name}')
        temporary.replace(target)
    if digest(target, algorithm) != expected:
        raise RuntimeError(f'Checksum mismatch: {target}; remove this cached file before retrying')
    return target


def safe_archive_listing(listing):
    """Validate 7zip's member section, never its archive-properties Path field."""
    separator = re.search(r'^----------\r?$', listing, re.M)
    if not separator:
        raise RuntimeError('7zip returned no archive member section')
    members = listing[separator.end():]
    if re.search(r'^(?:Attributes = .* l[rwxsStT-]{9}|Mode = l[rwxsStT-]{9}|Symbolic Link = .|Hard Link = .)', members, re.M):
        raise RuntimeError('Installer contains links; refusing extraction')
    for name in re.findall(r'^Path = (.+)$', members, re.M):
        if re.search(r'^(?:[/\\]|[A-Za-z]:)|(?:^|[/\\])\.\.(?:[/\\]|$)', name):
            raise RuntimeError(f'Installer contains an unsafe member path: {name}')


def select_installer(source, scratch):
    if not source.is_file():
        raise RuntimeError(f'Installer not found: {source}')
    if source.suffix.lower() != '.zip':
        if source.suffix.lower() != '.exe':
            raise RuntimeError('Supply the vendor ZIP or Designer installer EXE')
        return source
    with zipfile.ZipFile(source) as archive:
        matches = [i for i in archive.infolist()
                   if re.fullmatch(r'Q-SYS Designer Installer [0-9.]+\.exe', i.filename)]
        if len(matches) != 1:
            raise RuntimeError('ZIP must contain exactly one Designer installer at its root')
        entry = matches[0]
        if (entry.external_attr >> 16) & 0o170000 == 0o120000:
            raise RuntimeError('Designer installer in ZIP is a symbolic link')
        if entry.file_size > 10 * 1024**3:
            raise RuntimeError('Designer installer is unexpectedly large')
        destination = scratch / entry.filename
        with archive.open(entry) as src, destination.open('wb') as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        return destination


def host_check():
    release = platform.freedesktop_os_release()
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('This recipe currently supports x86-64 Linux only')
    if release.get('ID') != 'ubuntu' or release.get('VERSION_ID') != '26.04':
        raise RuntimeError('This Wine runtime currently targets Ubuntu 26.04; other distributions are untested')
    for executable in ['apt-get', 'dpkg-deb', 'python3', 'ldd', 'xdpyinfo']:
        if not shutil.which(executable):
            raise RuntimeError(f'Missing host dependency: {executable}')
    if os.geteuid() == 0:
        raise RuntimeError('Install and launch as your normal desktop user')


def display_check():
    if not os.environ.get('DISPLAY'):
        raise RuntimeError('An accessible X11/XWayland DISPLAY is required; run from a desktop terminal')
    try:
        run(['xdpyinfo'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
    except (subprocess.SubprocessError, OSError) as error:
        raise RuntimeError('Cannot access the X11 display; check DISPLAY and XAUTHORITY') from error


def support_paths():
    installed = Path(__file__).resolve().parent / 'support'
    if installed.is_dir():
        return installed, installed / 'fonts'
    mac = Path(__file__).resolve().parents[2] / 'qsys-mac-installer'
    return mac / 'lib', mac / 'assets/fonts/selawik'


def wine_paths(root):
    return root / 'toolchain/opt/wine-staging/bin/wine', root / 'toolchain/opt/wine-staging/bin/wineserver'


def environment(root, prefix):
    env = os.environ.copy()
    tools = root / 'toolchain'
    env['PATH'] = f'{tools}/usr/bin:{env.get("PATH", "")}'
    env['LD_LIBRARY_PATH'] = str(tools / 'usr/lib/x86_64-linux-gnu')
    env['WINEPREFIX'] = str(prefix)
    env['WINEARCH'] = 'win64'
    env['WINEDEBUG'] = os.environ.get('QSYS_WINEDEBUG', '-all')
    env['WINEDLLOVERRIDES'] = 'mshtml=d'
    env['LIBGL_ALWAYS_SOFTWARE'] = '1'
    # The tested driver is X11, including when the user's desktop runs Wayland.
    env.pop('WAYLAND_DISPLAY', None)
    return env


@contextlib.contextmanager
def owned_lock(root, create=False):
    if root.is_symlink() or root.resolve() in [Path('/'), Path.home().resolve()]:
        raise RuntimeError('Refusing an unsafe installation directory')
    marker = root / '.qsys-linux-owned'
    if root.exists() and not marker.is_file():
        if not create or any(root.iterdir()):
            raise RuntimeError(f'{root} is not a managed qsys-linux installation')
    if create:
        root.mkdir(parents=True, exist_ok=True)
        if not marker.exists():
            with marker.open('x') as output:
                output.write('qsys-linux v1\n')
    if not marker.is_file() or marker.read_text() != 'qsys-linux v1\n':
        raise RuntimeError('Missing installation ownership marker')
    with (root / '.operation.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Designer or another installation operation is running; close it first') from error
        yield


def bootstrap(root, downloads, log):
    target = root / 'toolchain'
    stamp = target / 'qsys-toolchain.json'
    if stamp.exists() and json.loads(stamp.read_text()).get('wine') == WINE_VERSION:
        if wine_paths(root)[0].is_file():
            return
    stage = root / f'toolchain.staging-{uuid.uuid4().hex}'
    stage.mkdir()
    try:
        wine_deb = artifact(WINE_ARTIFACT, downloads)
        run(['dpkg-deb', '-x', wine_deb, stage], stdout=log, stderr=log)
        # apt downloads verify packages against the host's signed Ubuntu indexes;
        # this downloads/extracts user-space tools, without running apt install.
        manifests = []
        # A fresh directory ensures unrelated .deb files in a supplied download
        # cache can never become part of the toolchain.
        with tempfile.TemporaryDirectory(prefix='ubuntu-tools-', dir=downloads) as directory:
            debs = Path(directory)
            run(['apt-get', 'download', *HELPER_PACKAGES], cwd=debs, stdout=log, stderr=log)
            for package in sorted(debs.glob('*.deb')):
                manifests.append({'file': package.name, 'sha256': digest(package)})
                run(['dpkg-deb', '-x', package, stage], stdout=log, stderr=log)
        (stage / 'qsys-toolchain.json').write_text(json.dumps({'wine': WINE_VERSION, 'packages': manifests}, indent=2) + '\n')
        if target.exists():
            raise RuntimeError('An incompatible toolchain exists; retain it for diagnosis before replacing it')
        stage.rename(target)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def load_assembler(support):
    spec = importlib.util.spec_from_file_location('qsys_msi_assembler', support / 'assemble-msi.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_tweaks(prefix, scratch, fonts, support, dpi=96):
    font_dir = prefix / 'drive_c/windows/Fonts'
    font_dir.mkdir(parents=True, exist_ok=True)
    lines = ['Windows Registry Editor Version 5.00', '',
             '[HKEY_CURRENT_USER\\Control Panel\\Desktop]', f'"LogPixels"=dword:{dpi:08x}', '',
             '[HKEY_CURRENT_USER\\Software\\Wine\\Drivers]', '"Graphics"="x11"', '',
             '[HKEY_CURRENT_USER\\Software\\Microsoft\\Avalon.Graphics]', '"DisableHWAcceleration"=dword:00000001', '',
             '[HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AeDebug]', '"Auto"="0"', '',
             '[HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\Microsoft\\Windows NT\\CurrentVersion\\AeDebug]', '"Auto"="0"', '',
             '[HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts]']
    for original, suffix, label in [('selawk', '', ''), ('selawkb', 'b', ' Bold'), ('selawkl', 'l', ' Light'),
                                    ('selawksb', 'sb', ' Semibold'), ('selawksl', 'sl', ' Semilight')]:
        dest = f'segoeui-shim{suffix}.ttf'
        run([sys.executable, support / 'rename-font-family.py', fonts / f'{original}.ttf', font_dir / dest, 'Selawik', 'Segoe UI'], stdout=subprocess.DEVNULL)
        lines.append(f'"Segoe UI{label} (TrueType)"="{dest}"')
    registry = scratch / 'tweaks.reg'
    registry.write_text('\r\n'.join(lines) + '\r\n', encoding='utf-16')
    return registry


def runtime_check(root, prefix, env):
    wine, _ = wine_paths(root)
    dotnet = prefix / 'drive_c/Program Files/dotnet/dotnet.exe'
    output = run([wine, dotnet, '--list-runtimes'], env=env, capture_output=True, text=True, timeout=30).stdout
    for name in ['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App', 'Microsoft.AspNetCore.App']:
        if not re.search(rf'^{re.escape(name)} {re.escape(DOTNET_VERSION)} ', output, re.M):
            raise RuntimeError(f'{name} {DOTNET_VERSION} failed to install')
    return output


def desktop_arg(value):
    if any(c in value for c in '\r\n\0'):
        raise RuntimeError('Desktop launcher paths cannot contain control characters')
    value = value.replace('%', '%%')
    for character in ['\\', '"', '`', '$']:
        value = value.replace(character, '\\' + character)
    # Desktop Entry string unescaping precedes Exec argument unquoting.
    value = value.replace('\\', '\\\\')
    return '"' + value + '"'


def integration_paths():
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
    return Path.home() / '.local/bin/qsys-linux', data / 'applications/qsys-designer.desktop'


def atomic_text(path, text, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.tmp-{uuid.uuid4().hex}')
    try:
        temporary.write_text(text)
        temporary.chmod(mode)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def check_integration(root):
    _, desktop = integration_paths()
    if desktop.exists() and f'X-Qsys-Linux-Root={root}\n' not in desktop.read_text():
        raise RuntimeError(f'Refusing to replace an unrelated desktop entry: {desktop}')


def integration(root, support, fonts):
    """Copy only our public recipe/support files, never the user's QSC payload."""
    check_integration(root)
    libexec = root / 'libexec'
    # Finish copying before replacing live support files. This also handles a
    # globally installed npm launcher without overwriting npm's bin symlink.
    if Path(__file__).resolve() != (libexec / 'qsys_linux.py').resolve():
        staged = root / f'libexec.staging-{uuid.uuid4().hex}'
        staged.mkdir()
        shutil.copy2(__file__, staged / 'qsys_linux.py')
        for name in ['assemble-msi.py', 'rename-font-family.py']:
            (staged / 'support').mkdir(exist_ok=True)
            shutil.copy2(support / name, staged / 'support' / name)
        shutil.copytree(fonts, staged / 'support/fonts')
        previous = root / f'libexec.previous-{uuid.uuid4().hex}'
        if libexec.exists():
            libexec.rename(previous)
        try:
            staged.rename(libexec)
        except BaseException:
            if previous.exists():
                previous.rename(libexec)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    convenience, desktop = integration_paths()
    launcher = root / 'bin/qsys-linux'
    script = '#!/bin/sh\n# qsys-linux managed launcher\nexec python3 ' + shlex.quote(str(libexec / 'qsys_linux.py')) + ' --data-dir ' + shlex.quote(str(root)) + ' "$@"\n'
    atomic_text(launcher, script, 0o755)
    if not convenience.exists() or (not convenience.is_symlink() and '# qsys-linux managed launcher' in convenience.read_text()):
        atomic_text(convenience, script, 0o755)
    atomic_text(desktop, '[Desktop Entry]\nType=Application\nName=Q-SYS Designer\n'
                       'Comment=Q-SYS Designer through Wine\n'
                       f'Exec={desktop_arg(str(launcher))} launch %f\n'
                       'Icon=applications-engineering\nTerminal=false\nCategories=AudioVideo;Engineering;\n'
                       f'X-Qsys-Linux-Root={root}\n')
    return str(launcher), str(desktop)


def clone_prefix(root, stage, log):
    """Copy-on-write when available; never hard-link mutable Windows state."""
    current = root / 'prefix'
    if current.exists():
        manifest(root)
        stage.mkdir()
        run(['cp', '--archive', '--reflink=auto', str(current) + '/.', stage], stdout=log, stderr=log)
        say('Preserving existing Windows files, settings, and UI scale')


def payload_files(assembler, msi):
    resolve = assembler.build_resolver(assembler.msi_export(str(msi), 'Directory'))
    components = {p['Component']: p['Directory_'] for p in assembler.msi_export(str(msi), 'Component')}
    result = set()
    for row in assembler.msi_export(str(msi), 'File'):
        directory = components.get(row['Component_'])
        if directory is not None:
            parent, _ = resolve(directory)
            result.add((parent.lstrip('/') + '/' + assembler.long_name(row['FileName'])).lstrip('/'))
    return sorted(result)


def prepare_payload(prefix, files, previous_files):
    app = prefix / APP_REL
    for relative in [*files, *previous_files]:
        path = Path(relative)
        if path.is_absolute() or '..' in path.parts:
            raise RuntimeError(f'Unsafe application manifest path: {relative}')
        target = app / path
        # A cloned user prefix may contain links, unlike the vendor archive.
        # Never follow one while replacing application-owned files.
        for parent in [target, *target.parents]:
            if parent == prefix:
                break
            if parent.is_symlink():
                raise RuntimeError(f'Application path contains a symbolic link: {parent}')
    for relative in previous_files:
        target = app / relative
        if target.is_file():
            target.unlink()


def commit_prefix(root, stage, integrate):
    """Retain the previous prefix, including user data, and roll back failed handoffs."""
    prefix = root / 'prefix'
    previous = root / f'prefix.previous-{time.strftime("%Y%m%dT%H%M%S")}-{uuid.uuid4().hex[:8]}'
    had_previous = prefix.exists()
    if had_previous:
        prefix.rename(previous)
    try:
        stage.rename(prefix)
        integrate()
    except BaseException:
        if prefix.exists():
            prefix.rename(stage)
        if had_previous:
            previous.rename(prefix)
        raise
    if had_previous:
        say(f'Previous prefix retained for recovery: {previous}')


def install(args):
    host_check()
    display_check()
    source = Path(args.installer).expanduser().resolve()
    root = args.data_dir
    support, fonts = support_paths()
    if not (support / 'assemble-msi.py').is_file() or not (fonts / 'selawk.ttf').is_file():
        raise RuntimeError('MSI/font support files are missing from this checkout/install')
    root.parent.mkdir(parents=True, exist_ok=True)
    if min(shutil.disk_usage(root.parent).free, shutil.disk_usage(tempfile.gettempdir()).free) < 12 * 1024**3:
        raise RuntimeError('Installation needs 12 GiB free in the data and temporary filesystems for peak extraction space')
    with owned_lock(root, create=True), tempfile.TemporaryDirectory(prefix='qsys-linux-install-') as temporary:
        if not args.no_integrate:
            check_integration(root)
        scratch = Path(temporary)
        downloads = Path(args.downloads).resolve() if args.downloads else scratch / 'downloads'
        downloads.mkdir(parents=True, exist_ok=True)
        log_path = root / 'install.log'
        stage = root / f'prefix.staging-{uuid.uuid4().hex}'
        prefix = root / 'prefix'
        env = environment(root, stage)
        wine, server = wine_paths(root)
        try:
            with log_path.open('a') as log:
                say(f'Install log: {log_path}')
                say('Preparing verified Wine and Ubuntu extraction tools')
                bootstrap(root, downloads, log)
                for elf in [wine, root / 'toolchain/usr/bin/msiinfo']:
                    result = run(['ldd', elf], env=env, capture_output=True, text=True)
                    if 'not found' in result.stdout:
                        raise RuntimeError(f'Missing host libraries for {elf}:\n{result.stdout}')
                installer = select_installer(source, scratch)
                seven = root / 'toolchain/usr/lib/7zip/7z'
                listing = run([seven, 'l', '-slt', installer], capture_output=True, text=True).stdout
                safe_archive_listing(listing)
                extract = scratch / 'extract'
                say('Extracting the supplied Designer installer')
                run([seven, 'x', '-y', f'-o{extract}', installer], stdout=log, stderr=log)
                msis = list(extract.glob('*.msi'))
                if len(msis) != 1:
                    raise RuntimeError('Expected one MSI layout in the Designer installer')
                assembler = load_assembler(support)
                old_path = os.environ.get('PATH', '')
                old_library = os.environ.get('LD_LIBRARY_PATH')
                try:
                    os.environ['PATH'] = env['PATH']
                    os.environ['LD_LIBRARY_PATH'] = env['LD_LIBRARY_PATH']
                    properties = {p['Property']: p['Value'] for p in assembler.msi_export(str(msis[0]), 'Property')}
                    app_files = payload_files(assembler, msis[0])
                finally:
                    os.environ['PATH'] = old_path
                    if old_library is None:
                        os.environ.pop('LD_LIBRARY_PATH', None)
                    else:
                        os.environ['LD_LIBRARY_PATH'] = old_library
                say('Initializing the private Windows prefix')
                previous = root / 'prefix/.qsys-linux-prefix'
                old_record = json.loads(previous.read_text()) if previous.exists() else {}
                clone_prefix(root, stage, log)
                init_env = dict(env, WINEDLLOVERRIDES='mscoree,mshtml=;winemenubuilder.exe=d')
                # Keep Windows profile folders local to the prefix.
                profile = stage / 'drive_c/users' / os.environ.get('USER', str(os.getuid()))
                for directory in ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos']:
                    (profile / directory).mkdir(parents=True, exist_ok=True)
                run([wine, 'wineboot', '--init'], env=init_env, timeout=120, stdout=log, stderr=log)
                say('Installing Windows .NET 10 Desktop and ASP.NET runtimes')
                for spec in RUNTIMES:
                    runtime = artifact(spec, downloads)
                    # Runtime presence is the final gate; some Wine builds return
                    # a nonzero installer result despite laying down the runtime.
                    result = subprocess.run([str(wine), str(runtime), '/install', '/quiet', '/norestart'],
                                            env=init_env, timeout=180, stdout=log, stderr=log)
                    log.write(f'Runtime installer exit: {result.returncode}\n')
                log.write(runtime_check(root, stage, env))
                say('Assembling the full MSI layout')
                prepare_payload(stage, app_files, old_record.get('app_files', []))
                run([sys.executable, support / 'assemble-msi.py', msis[0], extract, stage / APP_REL], env=env, stdout=log, stderr=log)
                configuration = json.loads((stage / APP_REL / 'Q-Sys Designer.runtimeconfig.json').read_text())
                frameworks = configuration['runtimeOptions']['frameworks']
                if any(not f['version'].startswith('10.') for f in frameworks):
                    raise RuntimeError('This Designer version requires a different .NET runtime recipe')
                percent = args.scale if args.scale is not None else (
                    old_record.get('scale_percent', 100))
                registry = write_tweaks(stage, scratch, fonts, support, round(96 * percent / 100))
                run([wine, 'regedit', '/S', registry], env=env, timeout=30, stdout=log, stderr=log)
                manifest = {'schema': SCHEMA, 'designer': properties.get('ProductVersion', 'unknown'),
                            'wine': WINE_VERSION, 'dotnet': DOTNET_VERSION, 'scale_percent': percent,
                            'installer_sha256': digest(installer), 'source_sha256': digest(source),
                            'app_files': app_files,
                            'installed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
                (stage / '.qsys-linux-prefix').write_text(json.dumps(manifest, indent=2) + '\n')
                # wineserver -k returns 1 when its clients have already exited.
                # The wait below is the handoff gate, including that idle case.
                subprocess.run([str(server), '-k'], env=env, timeout=30, stdout=log, stderr=log)
                run([server, '-w'], env=env, timeout=30, stdout=log, stderr=log)
            commit_prefix(root, stage, (lambda: None) if args.no_integrate else lambda: integration(root, support, fonts))
            say(f'Designer {manifest["designer"]} installed at {root}')
        finally:
            if stage.exists():
                if server.exists():
                    subprocess.run([str(server), '-k'], env=env, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    run([server, '-w'], env=env, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                shutil.rmtree(stage)


def manifest(root):
    path = root / 'prefix/.qsys-linux-prefix'
    if not path.is_file():
        raise RuntimeError(f'Designer is not installed in {root}; run install <installer.zip>')
    record = json.loads(path.read_text())
    if record.get('schema') != SCHEMA or not (root / 'prefix' / APP_REL / EXE_NAME).is_file():
        raise RuntimeError('The installation is incomplete or uses an incompatible recipe; reinstall')
    return record


def launch(args):
    root = args.data_dir
    manifest(root)
    display_check()
    with owned_lock(root):
        wine, server = wine_paths(root)
        env = environment(root, root / 'prefix')
        argv = [wine, root / 'prefix' / APP_REL / EXE_NAME]
        if args.design:
            design = Path(args.design).expanduser().resolve(strict=True)
            argv.append(run([wine.parent / 'winepath', '-w', design], env=env,
                            capture_output=True, text=True, timeout=20).stdout.strip())
        with (root / 'designer.log').open('a') as log:
            say(f'Launching Designer; log: {root / "designer.log"}')
            child = subprocess.Popen([str(a) for a in argv], env=env, stdout=log, stderr=log)
            try:
                result = child.wait()
            finally:
                subprocess.run([str(server), '-k'], env=env, timeout=30, stdout=log, stderr=log)
                child.wait(timeout=30)
            if result:
                raise RuntimeError(f'Designer exited with status {result}; see {root / "designer.log"}')


def status(args):
    record = manifest(args.data_dir)
    print(json.dumps({'data_dir': str(args.data_dir), **record}, indent=2))


def doctor(args):
    root = args.data_dir
    status(args)
    display_check()
    say('X11 display: accessible')
    wine, _ = wine_paths(root)
    say('Wine: ' + run([wine, '--version'], capture_output=True, text=True).stdout.strip())
    say(f'UI scale: {manifest(root).get("scale_percent", 100)}%')
    say(f'Free space: {shutil.disk_usage(root).free / 1024**3:.1f} GiB')
    say(f'Logs: {root / "install.log"}, {root / "designer.log"}')
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        with socket.create_connection(listener.getsockname(), timeout=2):
            connection, _ = listener.accept()
            connection.close()
    say('TCP loopback: working')
    for framework in ['Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App', 'Microsoft.AspNetCore.App']:
        path = root / 'prefix/drive_c/Program Files/dotnet/shared' / framework / DOTNET_VERSION
        if not path.is_dir():
            raise RuntimeError(f'Missing {framework} {DOTNET_VERSION}')
        say(f'{framework}: {DOTNET_VERSION}')


def scale(args):
    root = args.data_dir
    with owned_lock(root):
        record = manifest(root)
        env = environment(root, root / 'prefix')
        wine, server = wine_paths(root)
        try:
            run([wine, 'reg', 'add', 'HKCU\\Control Panel\\Desktop', '/v', 'LogPixels',
                 '/t', 'REG_DWORD', '/d', str(round(96 * args.percent / 100)), '/f'],
                env=env, stdout=subprocess.DEVNULL, timeout=30)
        finally:
            subprocess.run([str(server), '-k'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            run([server, '-w'], env=env, timeout=30, stdout=subprocess.DEVNULL)
        record['scale_percent'] = args.percent
        temporary = root / 'prefix/.qsys-linux-prefix.tmp'
        temporary.write_text(json.dumps(record, indent=2) + '\n')
        temporary.replace(root / 'prefix/.qsys-linux-prefix')
    say(f'UI scale set to {args.percent}%; launch Designer to use it')


def scale_percent(value):
    try:
        percent = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError('Scale must be a percentage such as 150 or 200') from error
    if not 75 <= percent <= 400:
        raise argparse.ArgumentTypeError('Scale must be between 75 and 400 percent')
    return percent


def remove(args):
    root = args.data_dir
    manifest(root)
    with owned_lock(root):
        launcher, desktop = integration_paths()
        if launcher.exists() and shlex.quote(str(root / 'libexec/qsys_linux.py')) in launcher.read_text():
            launcher.unlink()
        if desktop.exists() and f'X-Qsys-Linux-Root={root}\n' in desktop.read_text():
            desktop.unlink()
        if args.purge:
            shutil.rmtree(root)
    say(f'Removed managed installation data: {root}' if args.purge else
        f'Removed launchers; kept files and settings at {root}. Use remove --purge to delete them.')


def cancelled(*_):
    raise KeyboardInterrupt


def main(argv=None):
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGHUP, cancelled)
    parser = argparse.ArgumentParser(description=__doc__)
    default_data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'qsys-designer'
    parser.add_argument('--data-dir', type=Path, default=default_data)
    commands = parser.add_subparsers(dest='command', required=True)
    setup = commands.add_parser('install', help='Install from your vendor ZIP/EXE, without sudo')
    setup.add_argument('installer')
    setup.add_argument('--downloads', help='Reuse an explicit scratch download directory (checksums verified)')
    setup.add_argument('--no-integrate', action='store_true', help='Skip desktop and ~/.local/bin launchers')
    setup.add_argument('--scale', type=scale_percent, help='UI scale percentage; defaults to the previous setting or 100')
    start = commands.add_parser('launch', help='Launch Designer, optionally opening a design')
    start.add_argument('design', nargs='?')
    zoom = commands.add_parser('scale', help='Set UI scale for HiDPI screens (close Designer first)')
    zoom.add_argument('percent', type=scale_percent)
    commands.add_parser('remove').add_argument('--purge', action='store_true', help='Also delete all installed data, user files, and retained prefixes')
    for name in ['status', 'doctor']:
        commands.add_parser(name)
    args = parser.parse_args(argv)
    args.data_dir = args.data_dir.expanduser().absolute()
    try:
        globals()[args.command](args)
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError, zipfile.BadZipFile) as error:
        print(f'[qsys-linux] ERROR: {error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('[qsys-linux] Cancelled', file=sys.stderr)
        return 130
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
