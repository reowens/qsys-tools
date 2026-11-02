#!/usr/bin/env python3
"""Container-only .deb extraction using current libarchive, including on Rosetta.

Ubuntu's GNU tar requires openat2, which some amd64 translators do not supply.
Keep dpkg's archive decoding and libarchive's safe extraction defaults. Other
dpkg-deb commands use the unmodified system executable.
"""
import os
from pathlib import Path
import subprocess
import sys


def main(argv):
    if len(argv) != 3 or argv[0] not in ('-x', '--extract'):
        os.execv('/usr/bin/dpkg-deb', ['dpkg-deb', *argv])
    archive, destination = argv[1:]
    Path(destination).mkdir(parents=True, exist_ok=True)
    producer = subprocess.Popen(['/usr/bin/dpkg-deb', '--fsys-tarfile', archive], stdout=subprocess.PIPE)
    consumer = None
    try:
        consumer = subprocess.run(['/usr/bin/bsdtar', '--extract', '--file=-',
                                   '--directory', destination, '--no-same-owner'], stdin=producer.stdout)
    finally:
        producer.stdout.close()
        if consumer is None or consumer.returncode:
            producer.terminate()
        try:
            status = producer.wait(timeout=30)
        except subprocess.TimeoutExpired:
            producer.kill()
            producer.wait()
            raise
    return consumer.returncode or status


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, subprocess.SubprocessError) as error:
        print(f'dpkg-deb extraction: {error}', file=sys.stderr)
        sys.exit(2)
