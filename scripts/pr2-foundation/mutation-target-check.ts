import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mutationBinding } from './mutation-catalog.ts';

function gitStatus(file: string): string {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', file], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function main(): void {
  const keyIndex = process.argv.indexOf('--key');
  const key = keyIndex >= 0 ? String(process.argv[keyIndex + 1] ?? '') : '';
  const binding = mutationBinding(key);
  const dirty = gitStatus(binding.artifactPath);
  if (dirty) {
    process.stderr.write(`${binding.failingTestId}: ${binding.artifactPath} differs from HEAD\n`);
    process.exit(1);
  }
  process.stdout.write(`${binding.failingTestId}: passed\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
