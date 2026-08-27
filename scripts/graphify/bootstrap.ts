#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { graphifyLockFile, graphifyVenvDir } from './lib/graphify-env.ts';

function run(command: string, args: readonly string[]): string {
  const result = runProcessSync({ command, args, cwd: process.cwd(), inheritParentEnv: true });
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok) throw new Error(`${command} failed: ${result.stderr || result.error || result.outcome}`);
  return result.stdout;
}

function resolvePython(): string {
  for (const candidate of ['python3', 'python']) {
    try {
      const version = run(candidate, ['--version']).trim();
      const match = /(\d+)\.(\d+)/u.exec(version);
      if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 10))) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('No python3 >=3.10 found on PATH. Install Python 3.10+ and re-run this bootstrap.');
}

function pins(raw: string): string[] {
  return raw.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).sort();
}

const python = resolvePython();
const venv = graphifyVenvDir();
const lock = graphifyLockFile();
if (!existsSync(lock)) throw new Error(`Pinned lock file not found at '${lock}'.`);

process.stdout.write(`[graphify bootstrap] creating isolated venv at ${venv}\n`);
rmSync(venv, { recursive: true, force: true });
run(python, ['-m', 'venv', venv]);

const venvPython = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python');
if (!existsSync(venvPython)) throw new Error(`venv creation did not produce an interpreter at '${venvPython}'.`);

process.stdout.write('[graphify bootstrap] installing pinned dependency set\n');
run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet']);
run(venvPython, ['-m', 'pip', 'install', '--no-deps', '-r', lock]);

const installed = pins(run(venvPython, ['-m', 'pip', 'freeze']));
const locked = pins(readFileSync(lock, 'utf8'));
const missing = locked.filter((pin) => !installed.includes(pin));
const extra = installed.filter((pin) => !locked.includes(pin));
if (missing.length || extra.length) {
  throw new Error(`installed environment does not match lock; missing=${missing.join(',')} extra=${extra.join(',')}`);
}
process.stdout.write(`[PASS] isolated environment at ${venv} matches scripts/graphify/requirements.lock.txt exactly (${locked.length} packages).\n`);
