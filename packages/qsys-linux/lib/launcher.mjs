// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Robert Owens
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';

export function runCli(args, { platform = process.platform, spawnImpl = spawn, processImpl = process, stderr = process.stderr } = {}) {
  if (platform !== 'linux' && !args.includes('--help') && !args.includes('-h')) {
    stderr.write('qsys-linux runs on Linux. For macOS, use qsys-mac.\n');
    return Promise.resolve(1);
  }
  const recipe = fileURLToPath(new URL('./qsys_linux.py', import.meta.url));
  return new Promise((resolve) => {
    const child = spawnImpl('python3', [recipe, ...args], { stdio: 'inherit' });
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) processImpl.removeListener(signal, handler);
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      processImpl.on(signal, handler);
    }
    child.once('error', (error) => {
      cleanup();
      stderr.write(error.code === 'ENOENT'
        ? 'qsys-linux requires Python 3. Install python3, then run this command again.\n'
        : `qsys-linux could not start Python: ${error.message}\n`);
      resolve(1);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(code ?? (128 + (constants.signals[signal] ?? 1)));
    });
  });
}
