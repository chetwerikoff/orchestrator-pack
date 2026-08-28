import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runProcessSync } from '../../kernel/subprocess.ts';

export type GraphifySubcommand = 'extract' | 'update';

export function graphifyRepoRoot(): string {
  return resolve(import.meta.dirname, '../../..');
}

export function graphifyVenvDir(): string {
  return join(graphifyRepoRoot(), '.graphify', 'venv');
}

export function graphifyGraphOutDir(): string {
  return join(graphifyRepoRoot(), '.graphify', 'graph');
}

export function graphifyLockFile(): string {
  return resolve(import.meta.dirname, '../requirements.lock.txt');
}

export function graphifyExecutable(): string {
  const candidates = [
    join(graphifyVenvDir(), 'bin', 'graphify'),
    join(graphifyVenvDir(), 'Scripts', 'graphify.exe'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`graphify executable not found under '${graphifyVenvDir()}'. Run scripts/graphify/bootstrap.ts first.`);
  return found;
}

export function runGraphify(subcommand: GraphifySubcommand, args: readonly string[] = []): void {
  if (args.some((arg) => arg === 'install')) {
    throw new Error("Refusing to invoke graphify: standalone 'install' is not an allowed argument.");
  }
  const workDir = join(graphifyRepoRoot(), '.graphify');
  mkdirSync(workDir, { recursive: true });
  const result = runProcessSync({
    command: graphifyExecutable(),
    args: [subcommand, ...args],
    cwd: workDir,
    inheritParentEnv: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok) throw new Error(`graphify ${subcommand} failed: ${result.stderr || result.error || result.outcome}`);
}
