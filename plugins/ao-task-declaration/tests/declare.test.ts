import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  try {
    execFileSync(process.execPath, ['--import', 'tsx', scriptPath, '--help'], {
      encoding: 'utf8',
    });
    throw new Error(`expected ${scriptPath} --help to exit with code 1`);
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stderr?: string | Buffer;
      status?: number;
    };
    const stderr = String(execError.stderr ?? '');
    expect(stderr).toContain('Usage: ao-declare');
    expect(stderr).not.toContain('ERR_INVALID_URL');
    expect(execError.status).toBe(1);
  }
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
