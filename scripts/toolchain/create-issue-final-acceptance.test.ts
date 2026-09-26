import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const finalAcceptanceMock = vi.hoisted(() => ({
  runFinalAcceptance: vi.fn((): {
    ok: boolean;
    diagnostics: Array<{ message: string }>;
    guardErrors: string[];
    projectionPendingRepair?: boolean;
  } => ({
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

  it('returns a bound retry action for transient final-acceptance reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-1192-final-acceptance-retry-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'issue-r01-body.json'), JSON.stringify({
      schema: 'create-issue-live-snapshot/v1',
      issueNumber: 1192,
      sourceRevision: 'r01',
      title: ghMock.title,
      body: ghMock.body,
    }, null, 2) + '\n');
    writeFileSync(join(dir, 'stage-completeness-receipt-terminal.json'), JSON.stringify({
      schema: 'stage-completeness-receipt/v1',
      stage: 'architectural',
      stageSequence: 1,
      stageAttemptId: 'terminal',
      sourceRevision: 'r01',
      cycleId: 'cycle-1192',
      relayEligibleCaptures: [],
    }, null, 2) + '\n');
    finalAcceptanceMock.runFinalAcceptance.mockReturnValueOnce({
      ok: false,
      diagnostics: [],
      guardErrors: ['unable to re-read current Issue body before final event publication'],
      projectionPendingRepair: true,
    });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runCli([
        'node',
        'scripts/create-issue-final-acceptance.ts',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', '1192',
        '--review-dir', dir,
        '--public-actor', 'cursor-flow-manager',
        '--json',
      ])).toBe(3);
      const output = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? '{}')) as {
        ok?: boolean;
        cause?: string;
        nextAction?: {
          kind?: string;
          binding?: Record<string, unknown>;
          argv?: string[];
        } | null;
      };
      expect(output).toMatchObject({
        ok: false,
        cause: 'final_acceptance_failed',
        nextAction: {
          kind: 'retry-final-acceptance',
          binding: {
            repository: 'chetwerikoff/orchestrator-pack',
            issueNumber: 1192,
            sourceRevision: 'r01',
            stage: 'acceptance',
          },
        },
      });
      expect(output.nextAction?.argv).toContain('--issue-revision');
      expect(output.nextAction?.argv).toContain('r01');
      expect(output.nextAction?.argv).toEqual(expect.arrayContaining(['--public-actor', 'cursor-flow-manager']));
    } finally {
      stdout.mockRestore();
    }
  });

  it('routes missing producer-owned acceptance artifacts back to produce-artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opk-1192-final-acceptance-producer-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'issue-r01-body.json'), JSON.stringify({
      schema: 'create-issue-live-snapshot/v1',
      issueNumber: 1192,
      sourceRevision: 'r01',
      title: ghMock.title,
      body: ghMock.body,
    }, null, 2) + '\n');
    writeFileSync(join(dir, 'stage-completeness-receipt-terminal.json'), JSON.stringify({
      schema: 'stage-completeness-receipt/v1',
      stage: 'architectural',
      stageSequence: 1,
      stageAttemptId: 'terminal',
      sourceRevision: 'r01',
      cycleId: 'cycle-1192',
      relayEligibleCaptures: [],
    }, null, 2) + '\n');
    finalAcceptanceMock.runFinalAcceptance.mockReturnValueOnce({
      ok: false,
      diagnostics: [],
      guardErrors: ['finding-ledger: unable to read ' + join(dir, 'finding-disposition-ledger.json')],
    });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runCli([
        'node',
        'scripts/create-issue-final-acceptance.ts',
        '--repo', 'chetwerikoff/orchestrator-pack',
        '--issue-number', '1192',
        '--review-dir', dir,
        '--public-actor', 'cursor-flow-manager',
        '--json',
      ])).toBe(3);
      const output = JSON.parse(String(stdout.mock.calls.at(-1)?.[0] ?? '{}')) as {
        nextAction?: {
          kind?: string;
          binding?: Record<string, unknown>;
          argv?: string[];
        } | null;
      };
      expect(output).toMatchObject({
        ok: false,
        nextAction: {
          kind: 'produce-acceptance-artifacts',
          binding: {
            repository: 'chetwerikoff/orchestrator-pack',
            issueNumber: 1192,
            sourceRevision: 'r01',
            stage: 'architectural',
            stageAttemptId: 'terminal',
          },
        },
      });
      expect(output.nextAction?.argv).toContain('produce-artifacts');
      expect(output.nextAction?.argv).toContain('--expected-stage-attempt-id');
    } finally {
      stdout.mockRestore();
    }
  });


  it('renders top-level help from the manager CLI declaration', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(runCli(['node', 'scripts/create-issue-final-acceptance.ts', '--help'])).toBe(0);
      const output = stdout.mock.calls.flat().join('');
      expect(output).toContain('Usage:');
      expect(output).toContain('--issue-number');
      expect(output).toContain('--public-actor');
      expect(finalAcceptanceMock.runFinalAcceptance).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });

  it('requires explicit public actor before final-acceptance reads or mutation', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(runCli([
        'node', 'scripts/create-issue-final-acceptance.ts',
        '--issue-number', '1192',
        '--review-dir', '/unused',
      ])).toBe(2);
      expect(stderr.mock.calls.flat().join('')).toContain('--public-actor is required');
      expect(finalAcceptanceMock.runFinalAcceptance).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
