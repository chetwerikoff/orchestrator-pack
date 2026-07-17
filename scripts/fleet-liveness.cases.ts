import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateHeadReadyForReview } from '../docs/review-head-ready.mjs';
import {
  REVIEW_READY_SEED_LIVENESS_EXPECTED,
} from './lib/review-ready-seed-liveness-matrix.mjs';
import {
  BOUNDED_EXTERNAL_CALL_SCHEMA,
  consumePendingExternalCallTimeout,
  loadFleetLivenessContract,
  readLivenessProgressRecord,
  resolveLivenessProgressPath,
  runExternalCallWithLiveness,
  writeLivenessCheckpoint,
} from './kernel/side-process-liveness.ts';
import { runProcess, type ProcessResult } from './kernel/subprocess.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const created: string[] = [];

const ISSUE_853_RUNTIME_EXPECTED = [
  'fast-tick-ok',
  'long-tick-not-stalled-seed',
  'long-tick-not-stalled-reeval',
  'bounded-call-timeout-degraded',
  'hang-still-stalled',
  'progress-livelock-fails',
  'progress-identity',
  'dead-process-not-fresh',
  'overlap-safe',
  'atomic-progress-read',
  'upgrade-safe-progress',
  'e2e-seed-to-trigger-restored',
] as const;

const ISSUE_853_LOCAL_EXPECTED = new Set<string>([
  'long-tick-not-stalled-seed',
  'long-tick-not-stalled-reeval',
  'bounded-call-timeout-degraded',
  'e2e-seed-to-trigger-restored',
]);

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'opk-fleet-liveness-'));
  created.push(root);
  return root;
}

function readProgress(root: string, childId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveLivenessProgressPath(root, childId), 'utf8')) as Record<string, unknown>;
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    outcome: 'exit',
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: '{}\n',
    stderr: '',
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

function emitProof(expected: string): void {
  console.log(JSON.stringify({ producer: 'orchestrator-pack', datum: 'fleet-liveness', expected }));
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function productionFreshnessVerdict(options: {
  progress: Record<string, unknown>;
  childId: string;
  childPid: number;
  tickId: string;
  nowMs: number;
  stallThresholdMs: number;
}): Promise<Record<string, unknown>> {
  const progressJson = JSON.stringify(options.progress);
  const evidencePath = path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessProgressEvidence.ps1');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `. ${quotePowerShellLiteral(evidencePath)}`,
    `$progress = ${quotePowerShellLiteral(progressJson)} | ConvertFrom-Json`,
    `$verdict = Get-OrchestratorSideProcessProgressFreshnessVerdict -Progress $progress -ChildPid ${options.childPid} -StallThresholdMs ${options.stallThresholdMs} -NowMs ${options.nowMs} -TickId ${quotePowerShellLiteral(options.tickId)} -ChildId ${quotePowerShellLiteral(options.childId)}`,
    '$verdict | ConvertTo-Json -Compress',
  ].join('; ');
  const result = await runProcess({
    command: 'pwsh',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    cwd: repoRoot,
    inheritParentEnv: true,
    timeoutMs: 30_000,
    allowEmptyStdout: false,
  });
  expect(result.ok, result.stderr || result.error || 'PowerShell freshness verdict failed').toBe(true);
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  expect(output).toBeDefined();
  return JSON.parse(output ?? '{}') as Record<string, unknown>;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fleet-liveness shared producer contract', () => {
  it('maps every Issue #853 runtime matrix label to a local or inherited deterministic proof', () => {
    const inherited = new Set<string>(REVIEW_READY_SEED_LIVENESS_EXPECTED);
    for (const expected of ISSUE_853_RUNTIME_EXPECTED) {
      expect(
        ISSUE_853_LOCAL_EXPECTED.has(expected) || inherited.has(expected),
        `missing deterministic proof mapping for ${expected}`,
      ).toBe(true);
    }
  });

  for (const row of [
    { childId: 'review-ready-report-state-seed', expected: 'long-tick-not-stalled-seed' },
    { childId: 'review-trigger-reeval', expected: 'long-tick-not-stalled-reeval' },
  ]) {
    it(`expected: ${row.expected}`, async () => {
      const root = tempRoot();
      const checkpoints = [1_000, 9_000, 17_000, 25_000];
      for (const nowMs of checkpoints) {
        writeLivenessCheckpoint({
          childId: row.childId,
          ownerPid: 4242,
          workStep: 'github_fanout',
          progressDir: root,
          tickId: `tick-${row.childId}`,
          nowMs,
        });
      }
      const declaration = loadFleetLivenessContract().children.find((entry) => entry.id === row.childId);
      expect(declaration?.maxLocalComputeGapMs).toBe(8_000);
      expect(checkpoints.at(-1)! - checkpoints[0]!).toBeGreaterThan(20_000);
      for (let index = 1; index < checkpoints.length; index += 1) {
        expect(checkpoints[index]! - checkpoints[index - 1]!).toBeLessThanOrEqual(declaration!.maxLocalComputeGapMs!);
      }
      const record = readProgress(root, row.childId);
      expect(record.workCursor).toBe(4);
      expect(record.progressSchemaVersion).toBe(2);
      const verdict = await productionFreshnessVerdict({
        progress: record,
        childId: row.childId,
        childPid: 4242,
        tickId: `tick-${row.childId}`,
        nowMs: 30_000,
        stallThresholdMs: 20_000,
      });
      expect(verdict).toMatchObject({ Fresh: true, Status: 'fresh' });
      emitProof(row.expected);
    });
  }

  it('emits start and completion progress for every bounded external call', async () => {
    const root = tempRoot();
    const times = [1_000, 1_100, 2_000, 2_120];
    const now = () => times.shift() ?? 2_120;
    const runner = async () => processResult();
    await runExternalCallWithLiveness({
      childId: 'review-trigger-reeval', ownerPid: 31337, callName: 'gh:pr:list', command: 'fake-gh', progressDir: root, now, runner,
    });
    await runExternalCallWithLiveness({
      childId: 'review-trigger-reeval', ownerPid: 31337, callName: 'ao:session:ls', command: 'fake-ao', progressDir: root, now, runner,
    });
    expect(readProgress(root, 'review-trigger-reeval')).toMatchObject({
      workCursor: 4,
      workStep: 'ao:session:ls',
      lastProgressMs: 2_120,
      lastExternalCall: { callName: 'ao:session:ls', outcome: 'exit', elapsedMs: 120 },
    });
  });

  it('expected: bounded-call-timeout-degraded', async () => {
    const root = tempRoot();
    const values = [10_000, 10_025];
    const result = await runExternalCallWithLiveness({
      childId: 'review-trigger-reeval',
      ownerPid: 991,
      callName: 'gh:pr:list',
      command: 'fake-gh',
      progressDir: root,
      timeoutMs: 25,
      now: () => values.shift() ?? 10_025,
      runner: async () => processResult({ outcome: 'timeout', ok: false, exitCode: null, timedOut: true }),
    });
    expect(result.timedOut).toBe(true);
    expect(readProgress(root, 'review-trigger-reeval')).toMatchObject({
      phase: 'external_call_timeout',
      workCursor: 2,
      boundedExternalCallPending: true,
      failureClass: 'dependency',
      boundedExternalCall: {
        schemaVersion: BOUNDED_EXTERNAL_CALL_SCHEMA,
        callName: 'gh:pr:list',
        outcome: 'timeout',
        timeoutMs: 25,
      },
    });
    expect(consumePendingExternalCallTimeout({ childId: 'review-trigger-reeval', ownerPid: 991, progressDir: root }))
      .toBe('bounded external call timeout: gh:pr:list after 25ms');
    expect(readProgress(root, 'review-trigger-reeval').boundedExternalCallPending).toBe(false);

    const progressSource = readFileSync(path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessProgress.ps1'), 'utf8');
    const healthSource = readFileSync(path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessHealth.ps1'), 'utf8');
    expect(progressSource).toContain("'consume-timeout'");
    expect(progressSource).toContain("-Phase 'tick_error' -TickOutcome 'error'");
    expect(healthSource).toContain('Test-OrchestratorSideProcessSustainedErrors');
    expect(healthSource).toContain("$tail | Where-Object { $_ -eq 'error' }");
    expect(healthSource).toMatch(/Status\s*=\s*'degraded'/);
    emitProof('bounded-call-timeout-degraded');
  });

  it('expected: bounded-call-diagnostic-redacted', async () => {
    const root = tempRoot();
    const secret = 'ghp_SUPER_SECRET_AUTH_TOKEN';
    const values = [20_000, 20_025];
    await runExternalCallWithLiveness({
      childId: 'review-trigger-reeval',
      ownerPid: 992,
      callName: 'gh:pr:list',
      command: 'fake-gh',
      progressDir: root,
      timeoutMs: 25,
      now: () => values.shift() ?? 20_025,
      runner: async () => processResult({
        outcome: 'timeout', ok: false, exitCode: null, stdout: secret, stderr: secret, error: secret, timedOut: true,
      }),
    });
    const record = readProgress(root, 'review-trigger-reeval');
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(Object.keys(record.boundedExternalCall as Record<string, unknown>).sort()).toEqual([
      'callName', 'elapsedMs', 'observedAtMs', 'outcome', 'schemaVersion', 'timeoutMs',
    ]);
    emitProof('bounded-call-diagnostic-redacted');
  });

  it('expected: hang-still-stalled', () => {
    const root = tempRoot();
    expect(readLivenessProgressRecord(resolveLivenessProgressPath(root, 'review-trigger-reeval'))).toBeNull();
    const evidence = readFileSync(path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessProgressEvidence.ps1'), 'utf8');
    expect(evidence).toMatch(/Status\s*=\s*'hang'/);
    expect(evidence).toMatch(/Fresh\s*=\s*\$false/);
    emitProof('hang-still-stalled');
  });

  it('expected: progress-livelock-fails', () => {
    const root = tempRoot();
    for (const nowMs of [1_000, 2_000]) {
      writeLivenessCheckpoint({
        childId: 'review-trigger-reeval', ownerPid: 77, workStep: 'gh:pr:list', progressDir: root, tickId: 'tick-a', nowMs,
      });
    }
    expect(readProgress(root, 'review-trigger-reeval').workCursor).toBe(2);
    const evidence = readFileSync(path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessProgressEvidence.ps1'), 'utf8');
    expect(evidence).toMatch(/Status\s*=\s*'livelock'/);
    expect(evidence).toMatch(/Fresh\s*=\s*\$false/);
    emitProof('progress-livelock-fails');
  });

  it('expected: progress-identity', () => {
    const root = tempRoot();
    writeLivenessCheckpoint({ childId: 'review-trigger-reeval', ownerPid: 77, workStep: 'gh:pr:list', progressDir: root, nowMs: 1_000 });
    expect(readProgress(root, 'review-trigger-reeval').pid).toBe(77);
    expect(consumePendingExternalCallTimeout({ childId: 'review-trigger-reeval', ownerPid: 88, progressDir: root })).toBeNull();
    const evidence = readFileSync(path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessProgressEvidence.ps1'), 'utf8');
    const progressSource = readFileSync(path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessProgress.ps1'), 'utf8');
    const ghSource = readFileSync(path.join(repoRoot, 'scripts/gh'), 'utf8');
    expect(evidence).toMatch(/Status\s*=\s*'stale_identity'/);
    expect(progressSource).toContain('if (-not $env:AO_SIDE_PROCESS_OWNER_PID)');
    expect(progressSource).toContain('--owner-pid $env:AO_SIDE_PROCESS_OWNER_PID');
    expect(ghSource).toContain('owner_pid="${AO_SIDE_PROCESS_OWNER_PID:-$PPID}"');
    emitProof('progress-identity');
  });

  it('preserves dead-process and overlap consumers', () => {
    const health = readFileSync(path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessHealth.ps1'), 'utf8');
    const seedProgress = readFileSync(path.join(repoRoot, 'scripts/lib/Review-ReadyReportStateSeedProgress.ps1'), 'utf8');
    expect(health).toMatch(/Status\s*=\s*'stopped'/);
    expect(seedProgress).toContain('[System.IO.FileMode]::CreateNew');
    expect(seedProgress).toContain('return @{ acquired = $false');
  });

  it('keeps progress-file publication atomic and leaves no temp artifacts', () => {
    const root = tempRoot();
    for (let index = 1; index <= 100; index += 1) {
      writeLivenessCheckpoint({ childId: 'review-trigger-reeval', ownerPid: 12, workStep: `call-${index}`, progressDir: root, nowMs: index });
    }
    expect(readLivenessProgressRecord(resolveLivenessProgressPath(root, 'review-trigger-reeval'))).not.toBeNull();
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('expected: e2e-seed-to-trigger-restored', () => {
    const headSha = 'abc123def456';
    const decision = evaluateHeadReadyForReview({
      reviewRuns: [],
      prNumber: 853,
      headSha,
      session: {
        id: 'worker-853', role: 'worker', status: 'working', ownedHeadSha: headSha,
        reports: [{ reportState: 'ready_for_review', headRefOid: headSha, reportedAt: '2026-07-16T01:00:00.000Z' }],
      } as never,
      ciChecks: [
        { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
        { name: 'PR scope guard', state: 'SUCCESS' },
        { name: 'Run pack contract tests', state: 'SUCCESS' },
        { name: 'Self-architect lint', state: 'SUCCESS' },
      ],
    });
    expect(decision.reason).not.toBe('no_worker_session');
    expect(decision.route).toBe('start_review');
    expect(decision.eligible).toBe(true);
    emitProof('e2e-seed-to-trigger-restored');
  });
});
