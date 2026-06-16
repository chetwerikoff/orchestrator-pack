import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function runPwsh(script: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`pwsh failed ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

export function psString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
