import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  replayMergeForCarryover,
  validateFocusedResolutionReview,
} from './pack-review-carryover.ts';

const roots: string[] = [];
function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'pack-review-carryover-test-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'file.txt'), 'base\n');
  writeFileSync(join(root, 'stable.txt'), 'stable\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}
function makeConflictMerge(options: { unrelatedEdit?: boolean } = {}) {
  const repoRoot = makeRepo();
  git(repoRoot, 'checkout', '-qb', 'feature');
  writeFileSync(join(repoRoot, 'file.txt'), 'feature\n');
  git(repoRoot, 'commit', '-qam', 'feature');
  const sourceHeadSha = git(repoRoot, 'rev-parse', 'HEAD');
  git(repoRoot, 'checkout', '-q', 'master');
  writeFileSync(join(repoRoot, 'file.txt'), 'main\n');
  git(repoRoot, 'commit', '-qam', 'main');
  const mainSha = git(repoRoot, 'rev-parse', 'HEAD');
  git(repoRoot, 'checkout', '-q', 'feature');
  try {
    git(repoRoot, 'merge', '--no-ff', mainSha, '-m', 'merge');
  } catch {
    // Expected content conflict.
  }
  writeFileSync(join(repoRoot, 'file.txt'), 'resolved feature + main\n');
  git(repoRoot, 'add', 'file.txt');
  if (options.unrelatedEdit) {
    writeFileSync(join(repoRoot, 'unrelated.txt'), 'not produced by mechanical merge\n');
    git(repoRoot, 'add', 'unrelated.txt');
  }
  git(repoRoot, 'commit', '--no-edit', '-q');
  return { repoRoot, sourceHeadSha, mainSha, targetHeadSha: git(repoRoot, 'rev-parse', 'HEAD') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #898 conflict-only clean carry-over', () => {
  it('publishes composite H1 clean only after source clean focused resolution clean and terminal contract v2 authority', () => {
    const merge = makeConflictMerge();
    const replay = replayMergeForCarryover(merge);
    expect(replay.kind).toBe('merge_composite');
    expect(replay.bundle).toMatchObject({
      schema: 'merge-resolution-bundle/v2',
      sourceHeadSha: merge.sourceHeadSha,
      mainSha: merge.mainSha,
      targetHeadSha: merge.targetHeadSha,
      orderedParentShas: [merge.sourceHeadSha, merge.mainSha],
      conflictCount: 1,
    });
    expect(replay.bundle?.conflicts[0]).toMatchObject({
      pathUtf8: 'file.txt',
      stage1: { mode: '100644' },
      stage2: { mode: '100644' },
      stage3: { mode: '100644' },
      resolved: { mode: '100644' },
    });
    expect(validateFocusedResolutionReview({
      replay,
      reviewedTargetHeadSha: merge.targetHeadSha,
      reviewedBundleDigest: replay.bundle!.bundleDigest,
      verdict: 'clean',
      findingCount: 0,
    })).toEqual({
      clean: true,
      targetHeadSha: merge.targetHeadSha,
      bundleDigest: replay.bundle!.bundleDigest,
    });
    expect(() => validateFocusedResolutionReview({
      replay,
      reviewedTargetHeadSha: merge.targetHeadSha,
      reviewedBundleDigest: replay.bundle!.bundleDigest,
      verdict: 'findings',
      findingCount: 1,
    })).toThrow(/focused_review_findings/);
  });

  it('fails closed on unrelated H1 edits outside the replayed conflict set', () => {
    const merge = makeConflictMerge({ unrelatedEdit: true });
    expect(() => replayMergeForCarryover(merge)).toThrow(/carryover_replay_drift/);
  });

  it('requires exact two-parent H0 then pinned-main topology', () => {
    const merge = makeConflictMerge();
    expect(() => replayMergeForCarryover({
      ...merge,
      sourceHeadSha: merge.mainSha,
      mainSha: merge.sourceHeadSha,
    })).toThrow(/carryover_topology_invalid/);
  });

  it('allows direct carry-over only for a conflict-free exact replay tree', () => {
    const repoRoot = makeRepo();
    git(repoRoot, 'checkout', '-qb', 'feature');
    writeFileSync(join(repoRoot, 'feature.txt'), 'feature\n');
    git(repoRoot, 'add', 'feature.txt');
    git(repoRoot, 'commit', '-qm', 'feature');
    const sourceHeadSha = git(repoRoot, 'rev-parse', 'HEAD');
    git(repoRoot, 'checkout', '-q', 'master');
    writeFileSync(join(repoRoot, 'main.txt'), 'main\n');
    git(repoRoot, 'add', 'main.txt');
    git(repoRoot, 'commit', '-qm', 'main');
    const mainSha = git(repoRoot, 'rev-parse', 'HEAD');
    git(repoRoot, 'checkout', '-q', 'feature');
    git(repoRoot, 'merge', '--no-ff', mainSha, '-m', 'merge');
    const targetHeadSha = git(repoRoot, 'rev-parse', 'HEAD');
    expect(replayMergeForCarryover({ repoRoot, sourceHeadSha, mainSha, targetHeadSha })).toMatchObject({
      kind: 'conflict_free_carryover',
      sourceHeadSha,
      mainSha,
      targetHeadSha,
    });
  });
});
