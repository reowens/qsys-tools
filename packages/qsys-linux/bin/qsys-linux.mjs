#!/usr/bin/env node
import { runCli } from '../lib/launcher.mjs';
process.exitCode = await runCli(process.argv.slice(2));
