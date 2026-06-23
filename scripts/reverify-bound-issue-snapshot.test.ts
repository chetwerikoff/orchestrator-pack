import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureBoundIssueSnapshot,
  captureBoundIssueSnapshotsFromPreflight,
  loadValidatedBoundSnapshotBody,
  resolveBoundIssueSnapshot,
} from './lib/reverify-bound-issue-snapshot.js';
import { hashIssueBodySnapshot } from './lib/reviewer-contract-mapping.js';
import {
  captureValidatedBoundIssueSnapshots,
  shouldPersistBoundIssueSnapshots,
  specBodiesMatchContractSet,
} from './invoke-reviewer-contract-mapping.js';

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

  it('defers bound issue snapshot capture until validated spec statuses', () => {
    expect(shouldPersistBoundIssueSnapshots('mapping_pending')).toBe(true);
    expect(shouldPersistBoundIssueSnapshots('mapped')).toBe(true);
    expect(shouldPersistBoundIssueSnapshots('incomplete_evidence')).toBe(true);
    expect(shouldPersistBoundIssueSnapshots('skipped_input_limit')).toBe(true);
    expect(shouldPersistBoundIssueSnapshots('stale_spec')).toBe(false);
    expect(shouldPersistBoundIssueSnapshots('lookup_unavailable')).toBe(false);
  });

  it('captures bound snapshots for mapping fallback statuses with validated contract set', () => {
    withStoreDir();
    const body = '# Issue body\n\ncontract-evidence:\n- datum: sample\n';
    const members = [{ issueNumber: 376, snapshotHash: hashIssueBodySnapshot(body) }];
    const captures = captureValidatedBoundIssueSnapshots({
      opts: {
        prBodyFile: null,
        issueFile: null,
        issuesFile: null,
        issueSpecs: [],
        diffFile: null,
        changedPathsFile: null,
        explicitIssue: 376,
        declarationIssue: null,
        prHeadSha: 'abc1234',
        ledgerFile: null,
        invokeCoworker: false,
        json: true,
        lookupAvailable: true,
        coworkerAvailable: true,
        prNumber: 380,
        projectId: 'orchestrator-pack',
      },
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      contractSet: members,
      status: 'incomplete_evidence',
      specBodies: [{ issueNumber: 376, body }],
    });
    expect(captures).toHaveLength(1);
    expect(captures[0]?.created).toBe(true);
  });

  it('rejects snapshot files that do not match resolver-validated artifact path', () => {
    withStoreDir();
    const body = '# Issue body\n\ncontract-evidence:\n- datum: sample\n';
    const captured = captureBoundIssueSnapshot({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
      issueBody: body,
    });
    expect(() => loadValidatedBoundSnapshotBody({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
      snapshotFilePath: join(tmpdir(), 'not-the-bound-snapshot.md'),
    })).toThrow(/does not match resolver-validated/);
    const loaded = loadValidatedBoundSnapshotBody({
      projectId: 'orchestrator-pack',
      prNumber: 380,
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      issueNumber: 376,
      snapshotFilePath: captured.snapshotPath,
    });
    expect(loaded.body).toBe(body);
    expect(loaded.snapshotHash).toBe(captured.snapshotHash);
  });

  it('does not capture bound issue snapshots when supplied spec drifts from contract set', () => {
    const body = '# Issue body\n\ncontract-evidence:\n- datum: sample\n';
    const members = [{ issueNumber: 376, snapshotHash: hashIssueBodySnapshot(body) }];
    const staleBody = `${body}\nchanged`;
    expect(specBodiesMatchContractSet(
      [{ issueNumber: 376, body }],
      members,
    )).toBe(true);
    expect(specBodiesMatchContractSet(
      [{ issueNumber: 376, body: staleBody }],
      members,
    )).toBe(false);

    const captures = captureValidatedBoundIssueSnapshots({
      opts: {
        prBodyFile: null,
        issueFile: null,
        issuesFile: null,
        issueSpecs: [],
        diffFile: null,
        changedPathsFile: null,
        explicitIssue: 376,
        declarationIssue: null,
        prHeadSha: 'abc1234',
        ledgerFile: null,
        invokeCoworker: false,
        json: true,
        lookupAvailable: true,
        coworkerAvailable: true,
        prNumber: 380,
        projectId: 'orchestrator-pack',
      },
      prHeadSha: '9d7864bd16ed548b8d98b181e8b286ad7aeb7d99',
      contractSet: members,
      status: 'mapping_pending',
      specBodies: [{ issueNumber: 376, body: staleBody }],
    });
    expect(captures).toEqual([]);
  });
});
