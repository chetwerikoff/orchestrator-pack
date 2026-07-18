#!/usr/bin/env node
/**
 * npm bin entry point for PowerShell/cmd: Node shebang runs tsx via node, avoiding
 * Windows shims that look for tsx.exe when the package shebang is `env tsx`.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const script = join(dirname(fileURLToPath(import.meta.url)), 'ledger.ts');

const child = spawnSync(process.execPath, [tsxCli, script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

process.exit(child.status === null ? 1 : child.status);
