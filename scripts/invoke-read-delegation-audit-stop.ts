#!/usr/bin/env node
/**
 * Stop-hook entry for coworker read-delegation audit (Issue #255).
 * Fail-open compatibility wrapper: pipes hook stdin to the TypeScript producer.
 */
import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.ts';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const launcher = join(root, 'scripts/lib/Invoke-TypeScriptCli.ts');
const producer = join(root, 'scripts/json-producers/read-delegation-audit-stop.ts');

function readStdinFully(): string {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function warn(message: string): void {
  process.stderr.write(`WARNING: read-delegation audit wrapper failed open: ${message}\n`);
}

try {
  const node = process.execPath;
  const nodeVersion = runProcessSync({
    command: node,
    args: ['--version'],
    inheritParentEnv: true,
  });
  const version = nodeVersion.stdout.trim();
  if (!/^v22\./u.test(version)) {
    throw new Error(`Node.js 22.x is required; running ${version || 'unknown'}.`);
  }

  const stdin = readStdinFully();
  const result = runProcessSync({
    command: node,
    args: ['--experimental-strip-types', launcher, '--script', producer, '--', ...process.argv.slice(2)],
    inheritParentEnv: true,
    input: stdin,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  warn(message);
}

// Fail-open by contract: deliberately ignore preparation, launch, and child failures.
process.exit(0);
