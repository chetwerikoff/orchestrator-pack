import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcessSync } from '../kernel/subprocess.ts';
import { runRealFoundationScopeProof } from './real-scope-proof.ts';

const FOUNDATION_MERGE_SHA = 'b967dfe156838039e1d6d137e7064dc9d1b10b4d';

function git(repoRoot: string, args: string[]) {
  return runProcessSync({
    command: 'git',
    args,
    cwd: repoRoot,
    inheritParentEnv: true,
  });
}

function gitOutput(repoRoot: string, args: string[]): string {
  const result = git(repoRoot, args);
  if (!result.ok) {
    throw new Error(`git_failed:${args.join(' ')}:${result.stderr || result.error || result.outcome}`);
  }
  return result.stdout.trim();
}

function createMovingTipFixture(sourceRoot: string): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'opk-pr2-moving-tip-'));
  gitOutput(sourceRoot, ['clone', '--no-local', sourceRoot, fixtureRoot]);
  gitOutput(fixtureRoot, ['clean', '-fdx']);
  gitOutput(fixtureRoot, ['config', 'user.name', 'AC9 fixture']);
  gitOutput(fixtureRoot, ['config', 'user.email', 'ac9-fixture@example.invalid']);
  gitOutput(fixtureRoot, ['checkout', '--force', '--detach', FOUNDATION_MERGE_SHA]);
  gitOutput(fixtureRoot, ['commit', '--allow-empty', '-m', 'fixture origin main advance']);
  const originMainTip = gitOutput(fixtureRoot, ['rev-parse', 'HEAD']);
  gitOutput(fixtureRoot, ['update-ref', 'refs/remotes/origin/main', originMainTip]);
  gitOutput(fixtureRoot, ['checkout', '-b', 'subject', FOUNDATION_MERGE_SHA]);
  gitOutput(fixtureRoot, ['commit', '--allow-empty', '-m', 'fixture subject advance']);
  return fixtureRoot;
}

function createUnrelatedTip(fixtureRoot: string): string {
  gitOutput(fixtureRoot, ['checkout', '--orphan', 'unrelated']);
  gitOutput(fixtureRoot, ['read-tree', '--empty']);
  gitOutput(fixtureRoot, ['commit', '--allow-empty', '-m', 'fixture unrelated tip']);
  const unrelatedTip = gitOutput(fixtureRoot, ['rev-parse', 'HEAD']);
  gitOutput(fixtureRoot, ['checkout', '--force', 'subject']);
  return unrelatedTip;
}

function withMovingTipFixture(
  sourceRoot: string,
  callback: (fixtureRoot: string) => void,
): void {
  const fixtureRoot = createMovingTipFixture(sourceRoot);
  try {
    callback(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('[AC9] real committed declaration and terminal scope proof', () => {
  it('validates sibling descendants without requiring mutable-tip ordering', () => {
    withMovingTipFixture(path.resolve('.'), (fixtureRoot) => {
      const originMainTip = gitOutput(fixtureRoot, ['rev-parse', 'origin/main']);
      const headTip = gitOutput(fixtureRoot, ['rev-parse', 'HEAD']);
      expect(git(fixtureRoot, ['merge-base', '--is-ancestor', originMainTip, headTip]).ok).toBe(false);
      expect(git(fixtureRoot, ['merge-base', '--is-ancestor', headTip, originMainTip]).ok).toBe(false);
      expect(runRealFoundationScopeProof(fixtureRoot)).toEqual({
        ok: true,
        result: 'foundation-bounded-regular-single-revert',
      });
    });
  });

  it('fails when origin/main omits the immutable foundation merge', () => {
    withMovingTipFixture(path.resolve('.'), (fixtureRoot) => {
      const unrelatedTip = createUnrelatedTip(fixtureRoot);
      gitOutput(fixtureRoot, ['update-ref', 'refs/remotes/origin/main', unrelatedTip]);
      expect(() => runRealFoundationScopeProof(fixtureRoot)).toThrow(/git_failed:merge-base --is-ancestor/);
    });
  });

  it('fails when HEAD omits the immutable foundation merge', () => {
    withMovingTipFixture(path.resolve('.'), (fixtureRoot) => {
      createUnrelatedTip(fixtureRoot);
      gitOutput(fixtureRoot, ['checkout', '--force', 'unrelated']);
      expect(() => runRealFoundationScopeProof(fixtureRoot)).toThrow(/git_failed:merge-base --is-ancestor/);
    });
  });
});
