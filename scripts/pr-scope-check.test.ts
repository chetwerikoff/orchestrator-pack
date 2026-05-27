import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  extractLinkedIssueNumber,
  resolveLatestCommittedSnapshot,
} from './pr-scope-check.js';

function writeSnapshot(
  dir: string,
  issueNumber: number,
  iterationId: string,
  input: {
    supersedes: string | null;
    created_at: string;
  },
): void {
  const payload = {
    issue_number: issueNumber,
    iteration_id: iterationId,
    iteration_id_source: 'ao_session',
    supersedes: input.supersedes,
    created_at: input.created_at,
    baseline: {
      commit_sha: 'abc123',
      worktree_dirty: false,
      active_scope_hash: 'sha256:abc',
    },
    declared_paths: ['scripts/pr-scope-check.ts'],
    declared_globs: [],
    amendments: [],
  };
  writeFileSync(
    join(dir, 'docs', 'declarations', `${issueNumber}.${iterationId}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

describe('extractLinkedIssueNumber', () => {
  it.each([
    ['Closes #6', 6],
    ['Fixes #6', 6],
    ['Resolves #6', 6],
    ['Closed #6', 6],
    ['Fix #6', 6],
    ['Resolve #6', 6],
  ])('accepts GitHub closing keyword in %s', (body, expected) => {
    expect(extractLinkedIssueNumber(body)).toBe(expected);
  });

  it('uses the last closing reference in the body', () => {
    expect(extractLinkedIssueNumber('Closes #1\n\nResolves #6')).toBe(6);
  });
});

describe('resolveLatestCommittedSnapshot', () => {
  it('does not treat lexicographic filename order as chronological order', () => {
    const repoRoot = join(tmpdir(), `scope-guard-${randomUUID()}`);
    const declarationsDir = join(repoRoot, 'docs', 'declarations');
    mkdirSync(declarationsDir, { recursive: true });

    writeSnapshot(repoRoot, 9, 'op-1', {
      supersedes: null,
      created_at: '2026-05-27T10:00:00.000Z',
    });
    writeSnapshot(repoRoot, 9, 'op-2', {
      supersedes: 'op-1',
      created_at: '2026-05-27T11:00:00.000Z',
    });
    writeSnapshot(repoRoot, 9, 'op-10', {
      supersedes: 'op-2',
      created_at: '2026-05-27T12:00:00.000Z',
    });

    const result = resolveLatestCommittedSnapshot(repoRoot, 9);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.iteration_id).toBe('op-10');
    }
  });
});
