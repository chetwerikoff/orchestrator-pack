import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

export function readLines(filePath: string): string[] {
  return readText(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function resolveHeadSha(explicit?: string | null): string | null {
  if (explicit) {
    return explicit;
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}
