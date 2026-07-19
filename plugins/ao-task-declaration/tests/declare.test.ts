import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProcessSync } from '../../../scripts/kernel/subprocess.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const declareScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'declare.ts',
);
const workspaceBinScript = join(
  repoRoot,
  'node_modules',
  '@orchestrator-pack',
  'ao-task-declaration',
  'bin',
  'declare.ts',
);

function expectHelpFailure(scriptPath: string): void {
  const result = runProcessSync({
    command: process.execPath,
    args: ['--experimental-strip-types', scriptPath, '--help'],
    inheritParentEnv: true,
  });
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain('Usage: ao-declare');
  expect(result.stderr).not.toContain('ERR_INVALID_URL');
  expect(result.exitCode).toBe(1);
}

describe('declare CLI entrypoint', () => {
  it('handles direct invocation without crashing on argv path comparison', () => {
    expectHelpFailure(declareScript);
  });

  it('runs when invoked through the workspace package bin link', () => {
    expect(existsSync(workspaceBinScript)).toBe(true);
    expectHelpFailure(workspaceBinScript);
  });
});
