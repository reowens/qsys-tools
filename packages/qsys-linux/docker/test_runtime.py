#!/usr/bin/env python3
"""Opt-in, vendor-free runtime qualification. Uses only its own containers.

python3 docker/test_runtime.py --image qsys-runtime-a:qualification --wine-deb /tmp/wine.deb
The Wine package is checked and extracted in a disposable container, never baked
into the image. This suite does not assert application/installer acceptance.
"""
import argparse
import json
import pathlib
import subprocess
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--wine-deb', required=True, type=pathlib.Path)
    args = parser.parse_args()
    prefix = 'qsys-runtime-a-' + uuid.uuid4().hex[:12]
    results = []

    def docker(*arguments, expected=0, timeout=120, stdin=None):
        result = subprocess.run(['docker', *arguments], input=stdin, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        if result.returncode != expected:
            raise AssertionError(f'docker {arguments}: expected {expected}, got {result.returncode}\n{result.stdout}')
        return result.stdout

    def run(*arguments, expected=0, timeout=120):
        return docker('run', '--rm', '--init', '--platform', 'linux/amd64',
                      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=2048',
                      '--memory=4g', '--cpus=4', '--shm-size=1g',
                      '--label', f'qsys.runtime-test={prefix}', args.image,
                      *arguments, expected=expected, timeout=timeout)

    output = run('check')
    assert 'runtime check passed' in output, output
    assert 'Selawik' in output, output
    results.append('non-root check, authenticated X, packaged CLI/QRC, helpers/fonts')

    script = r'''
import os, pathlib, subprocess
assert os.getuid() == os.getgid() == 1000
assert os.environ['HOME'] == '/home/qsys'
assert os.environ['TMPDIR'] == '/work/tmp'
assert os.environ['XDG_DATA_HOME'] == '/work'
import shutil
assert shutil.which('wine') is None, 'system Wine must not replace pinned recipe'
assert shutil.which('dpkg-deb') == '/usr/local/bin/dpkg-deb', 'container extraction wrapper must be selected'
for folder in ['/usr/local', '/usr/local/bin', '/usr/local/lib', '/usr/local/lib/node_modules', '/opt/qsys-test']:
    assert pathlib.Path(folder).stat().st_uid == 0, folder
    assert not os.access(folder, os.W_OK), folder
    for directory, subdirectories, files in os.walk(folder):
        for name in subdirectories + files:
            file = pathlib.Path(directory, name)
            assert file.lstat().st_uid == 0, file
            assert not os.access(file, os.W_OK), file
assert pathlib.Path('/opt/qsys-test/dpkg-inventory.tsv').is_file()
assert pathlib.Path('/opt/qsys-test/package-sha256.txt').is_file()
assert subprocess.check_output(['xdpyinfo'], text=True).find('1920x1200 pixels') >= 0
assert subprocess.run(['xdpyinfo'], env=dict(os.environ, XAUTHORITY='/dev/null'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0
for folder in ['/input', '/work', '/cache', '/artifacts', '/home/qsys']:
    assert pathlib.Path(folder).stat().st_uid == 1000, folder
assert subprocess.run(['bash', '-c', "exec 3<>/dev/tcp/127.0.0.1/6099"], stderr=subprocess.DEVNULL).returncode != 0
# Literal argv, including shell metacharacters, must survive the entrypoint.
import sys
assert sys.argv[1] == 'a space; $(no shell) *'
print('private desktop and literal arguments passed')
'''
    run('exec', 'python3', '-c', script, 'a space; $(no shell) *')
    run('exec', 'bash', '-c', 'exit 37', expected=37)
    run('exec', expected=1)
    run('unknown-mode', expected=1)
    results.append('literal exec arguments, child exit status, invalid mode/arguments')

    # Exercise actual dpkg decoding and libarchive safety, without a vendor file
    # or GNU tar. Build a tiny ar/deb with Python so it also works under Rosetta.
    script = r'''
import io, pathlib, subprocess, tarfile
root = pathlib.Path('/work/wrapper-test')
root.mkdir()
bad = root / 'invalid.deb'
bad.write_text('invalid archive')
assert subprocess.run(['dpkg-deb', '-x', str(bad), str(root / 'invalid')]).returncode != 0
def tar_bytes(members):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w:gz') as archive:
        for name, data, link in members:
            entry = tarfile.TarInfo(name)
            if link:
                entry.type = tarfile.SYMTYPE
                entry.linkname = link
                archive.addfile(entry)
            else:
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
    return result.getvalue()
def deb(name, members):
    control = b'Package: qsys-wrapper-test\nVersion: 1\nArchitecture: all\nMaintainer: Runtime Test\nDescription: extraction test\n'
    content = bytearray(b'!<arch>\n')
    for filename, data in [('debian-binary', b'2.0\n'), ('control.tar.gz', tar_bytes([('control', control, None)])), ('data.tar.gz', tar_bytes(members))]:
        header = f'{filename + "/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode()
        assert len(header) == 60
        content.extend(header + data + (b'\n' if len(data) % 2 else b''))
    target = root / (name + '.deb')
    target.write_bytes(content)
    return target
outside = root / 'outside'
outside.mkdir()
traversal = deb('traversal', [('../escaped', b'unsafe', None)])
assert subprocess.run(['dpkg-deb', '-x', str(traversal), str(root / 'traversal')]).returncode != 0
assert not (root / 'escaped').exists()
symlink = deb('symlink', [('link', b'', str(outside)), ('link/escaped', b'unsafe', None)])
assert subprocess.run(['dpkg-deb', '-x', str(symlink), str(root / 'symlink')]).returncode != 0
assert not (outside / 'escaped').exists()
assert subprocess.check_output(['dpkg-deb', '-f', str(symlink), 'Package'], text=True).strip() == 'qsys-wrapper-test'
print('wrapper selection, invalid archive, parent traversal and symlink traversal passed')
'''
    print(run('exec', 'python3', '-c', script))
    results.append('root-owned immutable tools and selected wrapper; invalid/traversal archives fail closed')

    # Test copy-up using fresh named volumes, then remove only our volumes.
    volumes = [prefix + '-' + name for name in ['input', 'work', 'cache', 'artifacts', 'home']]
    try:
        options = []
        for name, path in zip(volumes, ['/input', '/work', '/cache', '/artifacts', '/home/qsys']):
            docker('volume', 'create', '--label', f'qsys.runtime-test={prefix}', name)
            options.extend(['--mount', f'type=volume,src={name},dst={path}'])
        docker('run', '--rm', '--init', *options, args.image, 'exec', 'python3', '-c',
               "import os; from pathlib import Path; "
               "[(Path(p)/'owned').write_text('copy-up') for p in ['/input','/work','/cache','/artifacts','/home/qsys']]; "
               "assert os.getuid()==1000")
    finally:
        for name in volumes:
            subprocess.run(['docker', 'volume', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results.append('fresh volume copy-up ownership and writes')

    # Run the actual verified Wine ELF tree on this image without installing it.
    # Keep this host directory isolated: caller supplies only the public deb.
    wine_script = r'''
set -euo pipefail
 echo '0429ca26cf940f78ae17bf5279779dffdc675878f07180c570bf9a34cdeb24c1  /tmp/wine.deb' | sha256sum -c -
 dpkg-deb -f /tmp/wine.deb Package Version Depends
 mkdir -p /work/wine-check
 dpkg-deb -x /tmp/wine.deb /work/wine-check
 /work/wine-check/opt/wine-staging/bin/wine --version
 python3 - <<'PY'
import os, pathlib, subprocess
root = pathlib.Path('/work/wine-check/opt/wine-staging')
# Wine's loader supplies its sibling Unix modules; ldd needs that same search path.
env = dict(os.environ, LD_LIBRARY_PATH=str(root / 'lib/wine/x86_64-unix'))
count = 0
for file in root.rglob('*'):
    if not file.is_file() or file.open('rb').read(4) != b'\x7fELF':
        continue
    result = subprocess.run(['ldd', str(file)], capture_output=True, text=True, env=env)
    assert 'not found' not in result.stdout + result.stderr, str(file) + '\n' + result.stdout + result.stderr
    count += 1
assert count > 10, count
print(f'ldd: {count} Wine ELF files have no missing host libraries')
PY
 mkdir -p /work/apt-check
 cd /work/apt-check
 apt-get download 7zip msitools libmsi-1.0-0 libgcab-1.0-0 icoutils
 for deb in *.deb; do dpkg-deb -x "$deb" /work/wine-check; done
 LD_LIBRARY_PATH=/work/wine-check/usr/lib/x86_64-linux-gnu ldd /work/wine-check/usr/bin/msiinfo
 ! LD_LIBRARY_PATH=/work/wine-check/usr/lib/x86_64-linux-gnu ldd /work/wine-check/usr/bin/msiinfo | grep 'not found'
'''
    output = docker('run', '--rm', '--init', '--platform', 'linux/amd64',
                    '--memory=4g', '--cpus=4', '--shm-size=1g',
                    '--label', f'qsys.runtime-test={prefix}',
                    '--mount', f'type=bind,src={args.wine_deb.resolve()},dst=/tmp/wine.deb,readonly',
                    args.image, 'exec', 'bash', '-c', wine_script, timeout=300)
    print(output)
    results.append('verified Wine 11.20 version and all ELF ldd; non-root apt helper downloads')

    name = prefix + '-signal'
    try:
        docker('run', '-d', '--name', name, '--init', '--label', f'qsys.runtime-test={prefix}',
               args.image, 'exec', 'bash', '-c',
               "trap 'echo child-term >> /artifacts/signal.txt; sleep 3; echo cleanup-complete >> /artifacts/signal.txt; exit 0' TERM; "
               "echo ready > /artifacts/ready; while true; do sleep 1; done")
        for attempt in range(100):
            state = json.loads(docker('inspect', name))[0]['State']
            if not state['Running']:
                raise AssertionError(docker('logs', name))
            probe = subprocess.run(['docker', 'exec', name, 'test', '-f', '/artifacts/ready'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if probe.returncode == 0:
                break
            time.sleep(.1)
        else:
            raise AssertionError('signal-test command readiness timeout')
        docker('kill', '--signal', 'TERM', name)
        time.sleep(1.5)  # Deliberate second-signal fault injection during cleanup.
        docker('kill', '--signal', 'TERM', name)
        docker('wait', name, timeout=15)
        state = json.loads(docker('inspect', name))[0]['State']
        assert state['ExitCode'] == 143, state
        # Docker cp works with a stopped container; inspect evidence before rm.
        import tempfile
        with tempfile.TemporaryDirectory(prefix=prefix) as directory:
            docker('cp', f'{name}:/artifacts/signal.txt', directory)
            evidence = pathlib.Path(directory, 'signal.txt').read_text()
            assert 'child-term' in evidence
            assert 'cleanup-complete' in evidence, evidence
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results.append('repeated SIGTERM preserves bounded command/desktop cleanup through completion (exit 143)')
    print(json.dumps({'status': 'passed', 'runtimeChecks': results, 'applicationAcceptance': 'not tested'}, indent=2))


if __name__ == '__main__':
    main()
