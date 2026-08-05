import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeterministicDeliveryKey,
  canEvictLifecycleEntry,
  evaluateDeterministicJournalAdmission,
  hashReviewFindings,
  isVerdictSnapshotLost,
  TERMINAL_DELIVERED,
} from '../docs/review-delivery-lifecycle.mjs';
import {
  buildScriptedReviewDeliveryMessage,
  parsePackReviewTerminalStdout,
} from '../docs/scripted-review-post-submit-delivery.mjs';
import {
  classifyPackReviewPayload,
  deliverPackReviewVerdict,
  isNonBlockingPackReviewFinding,
  recordPackReviewPendingStatus,
  resumePackReviewVerdictDelivery,
  sendPackReviewWorkerNotification,
  type PackReviewWorkerNotificationRequest,
} from './lib/pack-review-delivery.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  updatePackReviewRun,
  type PackReviewDeliveryOutcome,
  type PackReviewRunRecord,
} from './lib/pack-review-run-store.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';

const headSha = 'abc123def4567890abcdef1234567890abcdef12';
const prNumber = 718;
const tempRoots: string[] = [];
const originalEnv = { ...process.env };

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function repositoryHead(repoRoot: string): string {
  const result = runProcessSync({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: repoRoot,
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(`git_head_unresolved:${result.stderr || result.error}`);
  return result.stdout.trim().toLowerCase();
}

function deliveryKey(findings: unknown[]): string {
  const key = buildDeterministicDeliveryKey({
    prNumber,
    headSha,
    verdictSource: 'wrapper-stdout',
    findingsHash: hashReviewFindings(findings),
  });
  if (!key) throw new Error('delivery key required for test fixture');
  return key;
}

function deliveryOutcome(
  state: PackReviewDeliveryOutcome['state'],
  idempotencyKey: string,
  reason: string,
): PackReviewDeliveryOutcome {
  return {
    state,
    idempotencyKey,
    reason,
    recordedAtUtc: '2026-08-05T00:00:00.000Z',
  };
}

function writeSessionBinding(input: {
  sessionRoot: string;
  sessionId: string;
  runtime: string;
  id: string;
  generation: string;
  workspacePath: string;
  headSha: string;
}): void {
  mkdirSync(input.sessionRoot, { recursive: true });
  writeFileSync(path.join(input.sessionRoot, `${input.sessionId}.json`), `${JSON.stringify({
    runtimeHandle: {
      runtime: input.runtime,
      id: input.id,
      generation: input.generation,
      data: {
        workspacePath: input.workspacePath,
        headSha: input.headSha,
      },
    },
  })}\n`, 'utf8');
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runtime-neutral review delivery contract', () => {
  it('keeps actionable non-terminal lifecycle entries durable', () => {
    const result = canEvictLifecycleEntry({
      entry: { terminalStatus: '', state: 'verdict_recorded', lastUpdatedMs: 1 },
      prActionable: true,
      nowMs: 10_000,
    });
    expect(result).toEqual({ ok: false, reason: 'non_terminal_actionable_pr' });
  });

  it.each(['started', 'verdict_recorded', 'delivery_claimed', 'delivery_attempted'])(
    'fails closed when %s has no durable verdict snapshot',
    (state) => {
      expect(isVerdictSnapshotLost({ state, stdoutSnapshot: '' })).toBe(true);
      expect(isVerdictSnapshotLost({ state, stdoutSnapshot: '{"verdict":"clean"}' })).toBe(false);
    },
  );

  it('does not resend a terminal delivered deterministic journal entry', () => {
    const key = deliveryKey([]);
    const admission = evaluateDeterministicJournalAdmission({
      prior: {
        deliveryId: 'worker:pack-send:det:abc',
        deterministicKey: key,
        dispatchOutcome: 'dispatched',
        lifecycleTerminal: TERMINAL_DELIVERED,
      },
    }, {
      deterministicKey: key,
      findingsHash: hashReviewFindings([]),
    });
    expect(admission.action).toBe('no_op_terminal');
  });

  it('escalates changed findings for the same head instead of sending twice', () => {
    const priorFindings = [{ id: 'F1', severity: 'blocking' }];
    const nextFindings = [{ id: 'F2', severity: 'blocking' }];
    const priorKey = deliveryKey(priorFindings);
    const nextKey = deliveryKey(nextFindings);
    const admission = evaluateDeterministicJournalAdmission({
      prior: {
        deliveryId: 'worker:pack-send:det:abc',
        deterministicKey: priorKey,
        dispatchOutcome: 'dispatched',
        lifecycleTerminal: TERMINAL_DELIVERED,
        findingsHash: hashReviewFindings(priorFindings),
      },
    }, {
      deterministicKey: nextKey,
      findingsHash: hashReviewFindings(nextFindings),
    });
    expect(admission.ok).toBe(false);
    expect(admission.action).toBe('escalate_supersede');
    expect(admission.reason).toBe('different_findings_same_head');
  });

  it('parses terminal stdout and builds a deterministic worker message', () => {
    const parsed = parsePackReviewTerminalStdout(JSON.stringify({
      verdict: 'clean',
      findingCount: 0,
      findings: [],
    }));
    expect(parsed.ok).toBe(true);
    expect(parsed.gateVerdict).toBe('approved');

    const message = buildScriptedReviewDeliveryMessage({
      prNumber,
      deliveryKey: deliveryKey([]),
      headSha,
      gateVerdict: 'approved',
    });
    expect(message.ok).toBe(true);
    expect(message.message).toContain(`PR #${prNumber}`);
  });

  it('maps clean, non-blocking, and blocking payloads to the closed status contract', () => {
    expect(classifyPackReviewPayload({ verdict: 'clean', findingCount: 0, findings: [] })).toMatchObject({
      terminalStatus: 'up_to_date',
      requiredStatus: 'success',
      blocking: false,
    });
    expect(isNonBlockingPackReviewFinding({ severity: 'warning' })).toBe(true);
    expect(classifyPackReviewPayload({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'warning' }],
    })).toMatchObject({ terminalStatus: 'commented', requiredStatus: 'success', blocking: false });
    expect(classifyPackReviewPayload({
      verdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'blocking' }],
    })).toMatchObject({ terminalStatus: 'changes_requested', requiredStatus: 'failure', blocking: true });
  });

  it('rejects normal delivery before claim, journal, or dispatch after same-id generation recreation', async () => {
    const repoRoot = process.cwd();
    const storeRoot = tempRoot('opk-review-notification-binding-normal-');
    const stateRoot = tempRoot('opk-review-notification-state-normal-');
    const sessionRoot = tempRoot('opk-review-notification-session-normal-');
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({
      title: 'review-worker-normal',
      command: 'test-worker',
      workspace: repoRoot,
    });
    if (spawned.status !== 'ok') throw new Error('fixture_worker_spawn_failed');
    const worker = spawned.value;
    const exactHead = repositoryHead(repoRoot);
    const run = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1281,
      headSha: exactHead,
      linkedSessionId: worker.identity.id,
      startReason: 'test',
      surface: 'review-delivery-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
    }).run;
    process.env.PACK_REVIEW_SESSION_METADATA_ROOT = sessionRoot;
    writeSessionBinding({
      sessionRoot,
      sessionId: worker.identity.id,
      runtime: worker.identity.runtime,
      id: worker.identity.id,
      generation: worker.identity.generation,
      workspacePath: worker.workspacePath,
      headSha: exactHead,
    });
    await recordPackReviewPendingStatus({
      run,
      projectId: 'orchestrator-pack',
      storeRoot,
      writeRequiredStatus: async () => {},
    });
    const bound = getPackReviewRun(run.id, {
      projectId: 'orchestrator-pack',
      storeRoot,
    }) as (PackReviewRunRecord & { workerNotificationBinding?: Record<string, unknown> }) | null;
    expect(bound?.workerNotificationBinding).toMatchObject({
      runtime: worker.identity.runtime,
      id: worker.identity.id,
      generation: worker.identity.generation,
      workspacePath: path.resolve(worker.workspacePath),
      headSha: exactHead,
    });

    const recreated = adapter.recreateWorker(worker.identity);
    writeSessionBinding({
      sessionRoot,
      sessionId: worker.identity.id,
      runtime: recreated.identity.runtime,
      id: recreated.identity.id,
      generation: recreated.identity.generation,
      workspacePath: recreated.workspacePath,
      headSha: exactHead,
    });
    const dispatch = vi.spyOn(adapter, 'dispatchInput');
    const journalPath = path.join(stateRoot, 'dispatch.json');
    const claimNamespace = path.join(stateRoot, 'claims');
    const notifyWorker = (request: PackReviewWorkerNotificationRequest) => sendPackReviewWorkerNotification({
      trustedPackRoot: repoRoot,
      sessionId: worker.identity.id,
      request,
      projectId: 'orchestrator-pack',
      storeRoot,
      adapter,
      journalPath,
      claimNamespace,
      sideEffectFencePath: path.join(stateRoot, 'side-effect.lock'),
    });

    const result = await deliverPackReviewVerdict({
      run: bound ?? run,
      payload: {
        verdict: 'findings',
        findingCount: 1,
        findings: [{ severity: 'blocking' }],
      },
      projectId: 'orchestrator-pack',
      storeRoot,
      postGithubComment: async () => ({
        id: 128101,
        url: 'https://example.test/reviews/128101',
        event: 'COMMENT',
      }),
      writeRequiredStatus: async () => {},
      notifyWorker,
    });

    expect(result.reason).toBe('completed_with_delivery_failures');
    expect(dispatch).not.toHaveBeenCalled();
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(claimNamespace)).toBe(false);
    expect(getPackReviewRun(run.id, {
      projectId: 'orchestrator-pack',
      storeRoot,
    })?.deliveryOutcomes.workerNotification).toMatchObject({
      state: 'escalated',
      reason: 'worker_generation_mismatch',
    });
  });

  it('rejects resumed delivery before claim, journal, or dispatch after same-id generation recreation', async () => {
    const repoRoot = process.cwd();
    const storeRoot = tempRoot('opk-review-notification-binding-resume-');
    const stateRoot = tempRoot('opk-review-notification-state-resume-');
    const sessionRoot = tempRoot('opk-review-notification-session-resume-');
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({
      title: 'review-worker-resume',
      command: 'test-worker',
      workspace: repoRoot,
    });
    if (spawned.status !== 'ok') throw new Error('fixture_worker_spawn_failed');
    const worker = spawned.value;
    const exactHead = repositoryHead(repoRoot);
    const run = createPackReviewRun({
      projectId: 'orchestrator-pack',
      storeRoot,
      prNumber: 1282,
      headSha: exactHead,
      linkedSessionId: worker.identity.id,
      startReason: 'test',
      surface: 'review-delivery-test',
      trustedPackRoot: repoRoot,
      sourceRepoRoot: repoRoot,
      canonicalRepository: 'chetwerikoff/orchestrator-pack',
    }).run;
    process.env.PACK_REVIEW_SESSION_METADATA_ROOT = sessionRoot;
    writeSessionBinding({
      sessionRoot,
      sessionId: worker.identity.id,
      runtime: worker.identity.runtime,
      id: worker.identity.id,
      generation: worker.identity.generation,
      workspacePath: worker.workspacePath,
      headSha: exactHead,
    });
    await recordPackReviewPendingStatus({
      run,
      projectId: 'orchestrator-pack',
      storeRoot,
      writeRequiredStatus: async () => {},
    });
    const journaled = updatePackReviewRun(run.id, {
      status: 'reviewing',
      latestRunStatus: 'reviewing',
      reviewVerdict: 'findings',
      findingCount: 1,
      findings: [{ severity: 'blocking' }],
      journalOutcome: {
        state: 'persisted',
        recordedAtUtc: '2026-08-05T00:00:00.000Z',
        reason: 'verdict_persisted',
        idempotencyKey: `verdict:${run.id}:${exactHead}`,
        attempts: 1,
      },
      deliveryOutcomes: {
        githubComment: deliveryOutcome(
          'succeeded',
          `github-comment:${run.id}:${exactHead}`,
          'comment_posted',
        ),
        requiredStatus: deliveryOutcome(
          'succeeded',
          `required-status:orchestrator-pack/pack-review:${exactHead}`,
          'status_failure',
        ),
      },
    }, { projectId: 'orchestrator-pack', storeRoot });

    const recreated = adapter.recreateWorker(worker.identity);
    writeSessionBinding({
      sessionRoot,
      sessionId: worker.identity.id,
      runtime: recreated.identity.runtime,
      id: recreated.identity.id,
      generation: recreated.identity.generation,
      workspacePath: recreated.workspacePath,
      headSha: exactHead,
    });
    const dispatch = vi.spyOn(adapter, 'dispatchInput');
    const postGithubComment = vi.fn(async () => {
      throw new Error('completed GitHub channel must not be replayed');
    });
    const writeRequiredStatus = vi.fn(async () => {
      throw new Error('completed required-status channel must not be replayed');
    });
    const journalPath = path.join(stateRoot, 'dispatch.json');
    const claimNamespace = path.join(stateRoot, 'claims');
    const notifyWorker = (request: PackReviewWorkerNotificationRequest) => sendPackReviewWorkerNotification({
      trustedPackRoot: repoRoot,
      sessionId: worker.identity.id,
      request,
      projectId: 'orchestrator-pack',
      storeRoot,
      adapter,
      journalPath,
      claimNamespace,
      sideEffectFencePath: path.join(stateRoot, 'side-effect.lock'),
    });

    const result = await resumePackReviewVerdictDelivery({
      run: journaled,
      projectId: 'orchestrator-pack',
      storeRoot,
      postGithubComment,
      writeRequiredStatus,
      notifyWorker,
    });

    expect(result.reason).toBe('completed_with_delivery_failures');
    expect(postGithubComment).not.toHaveBeenCalled();
    expect(writeRequiredStatus).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(claimNamespace)).toBe(false);
    expect(getPackReviewRun(run.id, {
      projectId: 'orchestrator-pack',
      storeRoot,
    })?.deliveryOutcomes.workerNotification).toMatchObject({
      state: 'escalated',
      reason: 'worker_generation_mismatch',
    });
  });
});
