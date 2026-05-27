import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SyntheticGitRepo {
  /** Absolute path to the temporary repository root. */
  root: string;
  /** Remove the temporary directory (call in afterEach). */
  dispose: () => void;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Create an isolated git repository for scope-guard integration tests (#5, #6).
 * Uses only stock git — no AO runtime.
 */
export function createSyntheticGitRepo(options?: {
  initialFiles?: Record<string, string>;
}): SyntheticGitRepo {
  const root = mkdtempSync(join(tmpdir(), 'op-pack-git-fixture-'));

  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'fixture@test.local']);
  runGit(root, ['config', 'user.name', 'orchestrator-pack-fixture']);

  const files = options?.initialFiles ?? { 'README.md': '# fixture\n' };
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
    runGit(root, ['add', relativePath]);
  }

  runGit(root, ['commit', '-m', 'initial fixture commit']);

  return {
    root,
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup for test fixtures.
      }
    },
  };
}
