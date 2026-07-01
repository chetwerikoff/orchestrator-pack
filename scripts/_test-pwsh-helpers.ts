import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

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
