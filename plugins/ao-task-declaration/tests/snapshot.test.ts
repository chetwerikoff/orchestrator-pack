import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { createSyntheticGitRepo } from '@orchestrator-pack/shared/lib/git_fixture.js';
import { readMirror, writeMirror } from '../lib/mirror.js';
import {
  readSnapshot,
  snapshotRelativePath,
  writeSnapshot,
} from '../lib/snapshot.js';

function sampleSnapshot(iterationId: string): DeclarationSnapshot {
  return {
    issue_number: 4,
    iteration_id: iterationId,
    iteration_id_source: 'wrapper_generated',
    supersedes: null,
    created_at: '2026-05-26T12:00:00.000Z',
    baseline: {
      commit_sha: 'abc123',
      worktree_dirty: false,
      active_scope_hash: 'sha256:deadbeef',
    },
    declared_paths: ['plugins/demo.txt'],
    declared_globs: [],
    amendments: [],
  };
}

describe('snapshot and mirror writers', () => {
  let repo: ReturnType<typeof createSyntheticGitRepo> | undefined;

  afterEach(() => {
    repo?.dispose();
    repo = undefined;
  });

  it('writes committed snapshots under docs/declarations', () => {
    repo = createSyntheticGitRepo();
    const snapshot = sampleSnapshot('iter-1');
    const path = writeSnapshot(repo.root, snapshot);

    expect(path.endsWith(snapshotRelativePath(4, 'iter-1'))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readSnapshot(repo.root, 4, 'iter-1')).toEqual(snapshot);
  });

  it('writes runtime mirrors under .ao/declarations', () => {
    repo = createSyntheticGitRepo();
    const snapshot = sampleSnapshot('iter-2');
    const path = writeMirror(repo.root, snapshot);

    expect(path.endsWith(join('.ao', 'declarations', '4.iter-2.json'))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readMirror(repo.root, 4, 'iter-2')).toEqual(snapshot);
  });

  it('persists JSON with trailing newline', () => {
    repo = createSyntheticGitRepo();
    const snapshot = sampleSnapshot('iter-3');
    const path = writeSnapshot(repo.root, snapshot);
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});
