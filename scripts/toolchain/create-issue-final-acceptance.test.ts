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

vi.mock('../lib/create-issue-final-acceptance.ts', () => finalAcceptanceMock);

import { runCli } from '../create-issue-final-acceptance.ts';

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('create-issue-final-acceptance CLI entry point', () => {
  it('dispatches a complete acceptance invocation through the real CLI parser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-1192-final-acceptance-'));
    tempDirs.push(dir);
    const issueBodyPath = join(dir, 'issue.md');
    const receiptPath = join(dir, 'stage-receipt.json');
    writeFileSync(issueBodyPath, '# Issue 1192\nr01\n');
    writeFileSync(receiptPath, '{}\n');

    const exitCode = runCli([
      'node',
      'scripts/create-issue-final-acceptance.ts',
      '--repo', 'chetwerikoff/orchestrator-pack',
      '--issue-number', '1192',
      '--cycle-id', 'cycle-1192',
      '--issue-body', issueBodyPath,
      '--issue-revision', 'r01',
      '--review-dir', dir,
      '--stage-receipt', receiptPath,
      '--public-actor', 'cursor-flow-manager',
    ]);

    expect(exitCode).toBe(0);
    expect(finalAcceptanceMock.runFinalAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ runGh: expect.any(Function) }),
      expect.objectContaining({
        repo: 'chetwerikoff/orchestrator-pack',
        issueNumber: 1192,
        cycleId: 'cycle-1192',
        issueBody: '# Issue 1192\nr01\n',
        issueRevision: 'r01',
        reviewDir: dir,
        stageReceiptPaths: [receiptPath],
        publicActor: 'cursor-flow-manager',
      }),
    );
  });
});
