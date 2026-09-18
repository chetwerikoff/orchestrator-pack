import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const finalAcceptanceMock = vi.hoisted(() => ({
  runFinalAcceptance: vi.fn(() => ({
    ok: true,
    diagnostics: [],
    guardErrors: [],
  })),
}));

const ghMock = vi.hoisted(() => ({
  body: '# Issue 1192\n<!-- source-revision: r01 -->\n',
  title: 'Issue 1192',
}));

vi.mock('../lib/create-issue-final-acceptance.ts', () => finalAcceptanceMock);
vi.mock('../lib/create-issue-stage-record-gh.ts', () => ({
  defaultGhTransport: () => ({ runGh: vi.fn() }),
  fetchIssueRevision: () => ({ title: ghMock.title, body: ghMock.body, labels: [] }),
}));

import { runCli } from '../create-issue-final-acceptance.ts';

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('create-issue-final-acceptance CLI entry point', () => {
  it('derives a complete acceptance invocation from canonical producer artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-1192-final-acceptance-'));
    tempDirs.push(dir);
    const snapshotPath = join(dir, 'issue-r01-body.json');
    const receiptPath = join(dir, 'stage-completeness-receipt-terminal.json');
    writeFileSync(snapshotPath, JSON.stringify({
      schema: 'create-issue-live-snapshot/v1',
      issueNumber: 1192,
      sourceRevision: 'r01',
      title: ghMock.title,
      body: ghMock.body,
    }, null, 2) + '\n');
    writeFileSync(receiptPath, JSON.stringify({
      schema: 'stage-completeness-receipt/v1',
      stage: 'architectural',
      stageSequence: 1,
      stageAttemptId: 'terminal',
      sourceRevision: 'r01',
      cycleId: 'cycle-1192',
      relayEligibleCaptures: [],
    }, null, 2) + '\n');

    const exitCode = runCli([
      'node',
      'scripts/create-issue-final-acceptance.ts',
      '--repo', 'chetwerikoff/orchestrator-pack',
      '--issue-number', '1192',
      '--review-dir', dir,
      '--public-actor', 'cursor-flow-manager',
    ]);

    expect(exitCode).toBe(0);
    expect(finalAcceptanceMock.runFinalAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ runGh: expect.any(Function) }),
      expect.objectContaining({
        repo: 'chetwerikoff/orchestrator-pack',
        issueNumber: 1192,
        cycleId: 'cycle-1192',
        issueBody: ghMock.body,
        terminalSourceBody: ghMock.body,
        issueRevision: 'r01',
        reviewDir: dir,
        stageReceiptPaths: [receiptPath],
        publicActor: 'cursor-flow-manager',
      }),
    );
  });
});
