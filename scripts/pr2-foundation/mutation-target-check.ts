import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';
import { mutationBinding } from './mutation-catalog.ts';

function gitStatus(file: string): string {
  const result = runProcessSync({
    command: 'git',
    args: ['status', '--porcelain=v1', '--untracked-files=all', '--', file],
    cwd: path.resolve('.'),
    inheritParentEnv: true,
  });
  if (!result.ok) {
    throw new Error(`git_status_failed:${result.stderr || result.error || result.outcome}`);
  }
  return result.stdout.trim();
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
