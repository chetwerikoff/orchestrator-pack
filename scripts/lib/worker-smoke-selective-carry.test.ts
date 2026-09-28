// @vitest-pre-topology-seconds 1
// @vitest-ci-lane light
import { runProcessSync } from '../kernel/subprocess.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSmokeProgressWriterCommand } from '../worker-smoke-run.ts';
import {
  bindSmokeTerminalHandle,
  createSmokeLifecycleReservation,
  markSmokeCreateInProgress,
  smokeProgressPath,
} from './worker-smoke-lifecycle.ts';
import {
  evaluateWorkerSmokeMainMergeCarry,
  formatSmokeReportComment,
  planWorkerSmokeSelectiveRetry,
  resolveSmokeRunArtifactDir,
  SMOKE_REPORT_PRODUCER,
  type SmokeReport,
  type WorkerSmokeCommentRecord,
  type WorkerSmokeTrustedTarget,
} from './worker-smoke-core.ts';

const ISSUE = 2213;
const PR = 2300;
const EARLIER_HEAD = '1'.repeat(40);
const CURRENT_HEAD = '2'.repeat(40);
const MERGE_BASE = '3'.repeat(40);
const MAIN_HEAD = '4'.repeat(40);
const PATCH_ID = '5'.repeat(40);
const TRUSTED_ACTOR = 'pack-publisher';
const ACTION = 'exercise independent smoke scenario';
const EXPECTED = 'scenario executes unless an eligible earlier-head carry exists';

function issueBody(): string {
  return [
    '```behavior-kind',
    'action-producing',
    '```',
    '',
    '```smoke-test-plan',
    'scenarios:',
    '  - action: ' + ACTION + ' | expected: ' + EXPECTED,
    '```',
  ].join('\n');
}

function passReport(headSha: string): SmokeReport {
  return {
    result: 'PASS',
    issueNumber: ISSUE,
    prNumber: PR,
    headSha,
    scenarios: [{
      action: ACTION,
      expected: EXPECTED,
      observed: 'scenario executed',
      outcome: 'pass',
    }],
    limitations: [],
    trackedFilesUnmodified: true,
    terminalCleanup: 'closed_owned_handle',
    environmentNotes: ['smoke-execution=executed'],
    producer: SMOKE_REPORT_PRODUCER,
    orcaExecutable: 'runtime-adapter',
    terminalHandle: 'smoke-terminal-1',
  };
}

function comment(id: number, report: SmokeReport): WorkerSmokeCommentRecord {
  const timestamp = new Date(Date.UTC(2026, 8, 28, 0, 0, 0, id)).toISOString();
  return {
    id,
    body: formatSmokeReportComment(report),
    created_at: timestamp,
    updated_at: timestamp,
    user: { login: TRUSTED_ACTOR },
  };
}

function target(headSha = CURRENT_HEAD): WorkerSmokeTrustedTarget {
  return {
    repositorySlug: 'chetwerikoff/orchestrator-pack',
    issueNumber: ISSUE,
    prNumber: PR,
    headSha,
    resolvedIssueNumber: ISSUE,
    resolvedPrNumber: PR,
    liveHeadSha: headSha,
    issueBodyMatchesTarget: true,
    trustedPublisherLogin: TRUSTED_ACTOR,
    commentCensusComplete: true,
    commentSnapshotStable: true,
  };
}

describe('Issue #2213 actor-sensitive selective smoke carry', () => {
  it('does not carry the only same-head worker-owned PASS into an independent run', () => {
    const comments = [comment(1, passReport(CURRENT_HEAD))];
    const common = {
      issueBody: issueBody(),
      prBody: '',
      comments,
      target: target(),
      isAncestor: () => true,
    };

    const workerOwned = planWorkerSmokeSelectiveRetry({
      ...common,
      smokeActor: 'worker-owned',
      workerOwnedPassHeadShas: [CURRENT_HEAD],
    });
    expect(workerOwned.carried).toHaveLength(1);
    expect(workerOwned.attemptPlan.scenarios).toHaveLength(0);

    const independent = planWorkerSmokeSelectiveRetry({
      ...common,
      smokeActor: 'independent',
      workerOwnedPassHeadShas: [CURRENT_HEAD],
    });
    expect(independent.carried).toHaveLength(0);
    expect(independent.attemptPlan.scenarios).toEqual([
      { action: ACTION, expected: EXPECTED },
    ]);
  });

  it('keeps an earlier independent PASS eligible for the existing clean main-merge carry', () => {
    const selection = planWorkerSmokeSelectiveRetry({
      issueBody: issueBody(),
      prBody: '',
      comments: [
        comment(1, passReport(EARLIER_HEAD)),
        comment(2, passReport(CURRENT_HEAD)),
      ],
      target: target(),
      isAncestor: (ancestorSha, descendantSha) =>
        ancestorSha === EARLIER_HEAD && descendantSha === CURRENT_HEAD,
      smokeActor: 'independent',
      workerOwnedPassHeadShas: [CURRENT_HEAD],
    });

    expect(selection.attemptPlan.scenarios).toHaveLength(0);
    expect(selection.carried).toHaveLength(1);
    expect(selection.carried[0]?.sourceHeadSha).toBe(EARLIER_HEAD);

    expect(evaluateWorkerSmokeMainMergeCarry({
      sourceHeadSha: EARLIER_HEAD,
      destinationHeadSha: CURRENT_HEAD,
      mergeBaseSha: MERGE_BASE,
      destinationBaseSha: MAIN_HEAD,
      sourcePatchId: PATCH_ID,
      destinationPatchId: PATCH_ID,
      mainPaths: ['docs/main-only-change.md'],
      protectedPaths: ['scripts/lib/worker-smoke-core.ts'],
      cleanMainMerge: true,
      descendant: true,
      hasConflictResolution: false,
    }, CURRENT_HEAD, EARLIER_HEAD)).toMatchObject({
      allowed: true,
      mainPaths: ['docs/main-only-change.md'],
    });
  });
});

describe('Issue #2213 bound smoke progress writer', () => {
  it('writes progress only to the active run artifact without a caller-supplied path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'issue-2213-progress-writer-'));
    const runId = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
    const artifactDir = resolveSmokeRunArtifactDir(cwd, runId);
    try {
      createSmokeLifecycleReservation({
        runId, artifactDir, issueNumber: ISSUE, prNumber: PR, headSha: CURRENT_HEAD, scenarioCount: 1,
      });
      markSmokeCreateInProgress(artifactDir);
      bindSmokeTerminalHandle(artifactDir, 'smoke-terminal');
      const writer = buildSmokeProgressWriterCommand(runId, artifactDir);
      expect(writer).not.toContain('progress.ndjson');
      for (const args of ['1 started', '1 terminal pass']) {
        const result = runProcessSync({ command: '/bin/sh', args: ['-c', `${writer} ${args}`], cwd });
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      }
      const progressPath = smokeProgressPath(artifactDir);
      const events = readFileSync(progressPath, 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      expect(events).toEqual([
        { runId, scenarioOrdinal: 1, phase: 'started' },
        { runId, scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' },
      ]);
      expect(existsSync(join(cwd, '.orca-worker-smo'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
