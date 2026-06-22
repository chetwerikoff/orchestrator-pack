import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureBoundIssueSnapshot,
  captureBoundIssueSnapshotsFromPreflight,
  resolveBoundIssueSnapshot,
} from './lib/reverify-bound-issue-snapshot.js';

const storeDirs: string[] = [];

afterEach(() => {
  while (storeDirs.length > 0) {
    process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = storeDirs.pop() ?? '';
  }
  delete process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR;
});

function withStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opk-bound-snapshot-'));
  process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = dir;
  storeDirs.push(dir);
  return dir;
}

describe('reverify bound issue snapshot (Issue #376)', () => {
  it('captures and resolves an immutable PR-bound issue snapshot', () => {
    withStoreDir();
    const body = '# Issue body\n\ncontract-evidence:\n- datum: sample\n';
    const captured = captureBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
      issueBody: body,
      capturedAt: '2026-06-22T00:00:00.000Z',
    });
    expect(captured.created).toBe(true);
    expect(readFileSync(captured.snapshotPath, 'utf8')).toBe(body);

    const resolved = resolveBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
    });
    expect(resolved.status).toBe('found');
    expect(resolved.snapshotPath).toBe(captured.snapshotPath);
    expect(resolved.snapshotHash).toBe(captured.snapshotHash);
  });

  it('is idempotent for the same PR head and issue body', () => {
    withStoreDir();
    const input = {
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
      issueBody: '# Stable body\n',
    };
    const first = captureBoundIssueSnapshot(input);
    const second = captureBoundIssueSnapshot(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshotPath).toBe(first.snapshotPath);
  });

  it('captures all spec bodies during contract-mapping preflight', () => {
    withStoreDir();
    const captures = captureBoundIssueSnapshotsFromPreflight({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      specBodies: [
        { issueNumber: 376, body: '# Issue 376\n' },
        { issueNumber: 377, body: '# Issue 377\n' },
      ],
    });
    expect(captures).toHaveLength(2);
    expect(captures.every((capture) => capture.created)).toBe(true);
  });

  it('rejects corrupted snapshot bodies on resolve', () => {
    withStoreDir();
    const captured = captureBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
      issueBody: '# Original body\n',
    });
    writeFileSync(captured.snapshotPath, '# Tampered body\n');

    const resolved = resolveBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
    });
    expect(resolved.status).toBe('corrupted');
    expect(resolved.snapshotPath).toBeNull();
    expect(resolved.metadata?.snapshotHash).toBe(captured.snapshotHash);
  });

  it('returns corrupted for malformed snapshot metadata', () => {
    withStoreDir();
    const captured = captureBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
      issueBody: '# Original body\n',
    });
    writeFileSync(captured.metadataPath, '{"schemaVersion":1,"snapshotHash":"sha256:truncated');

    const resolved = resolveBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
    });
    expect(resolved.status).toBe('corrupted');
    expect(resolved.snapshotPath).toBeNull();
    expect(resolved.metadata).toBeNull();
  });

  it('returns corrupted when metadata binding fields disagree with the request', () => {
    withStoreDir();
    const captured = captureBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
      issueBody: '# Original body\n',
      capturedAt: '2026-06-22T00:00:00.000Z',
    });
    const metadata = JSON.parse(readFileSync(captured.metadataPath, 'utf8')) as Record<string, unknown>;
    metadata.issueNumber = 377;
    writeFileSync(captured.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const resolved = resolveBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
    });
    expect(resolved.status).toBe('corrupted');
    expect(resolved.snapshotPath).toBeNull();
  });
});
