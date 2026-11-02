#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Explicit interpreters for QEMU execve; retain coreutils name validation."""
import os
from pathlib import Path
import runpy
import sys

if Path(sys.argv[0]).name == 'qsys-linux':
    os.execv('/usr/local/bin/node', ['node', '/usr/local/lib/node_modules/qsys-linux/bin/qsys-linux.mjs', *sys.argv[1:]])
elif Path(sys.argv[0]).name == 'dpkg-deb':
    runpy.run_path('/usr/local/bin/dpkg-deb', run_name='__main__')
else:
    raise SystemExit('Unknown explicit-interpreter shim')
