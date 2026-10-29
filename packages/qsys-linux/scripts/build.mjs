// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
import { cp, mkdir, chmod, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const mac = path.resolve(root, '../qsys-mac-installer');
const support = path.join(root, 'lib/support');
await rm(support, { recursive: true, force: true });
await mkdir(support, { recursive: true });
for (const name of ['assemble-msi.py', 'rename-font-family.py']) {
  await copyFile(path.join(mac, 'lib', name), path.join(support, name));
}
await cp(path.join(mac, 'assets/fonts/selawik'), path.join(support, 'fonts'), { recursive: true });
await copyFile(path.resolve(root, '../../LICENSE'), path.join(root, 'LICENSE'));
await chmod(path.join(root, 'bin/qsys-linux.mjs'), 0o755);
