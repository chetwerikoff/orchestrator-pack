import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeAoSessionRow,
  type AoSessionRow,
  type OpenPrSnapshotRow,
} from './binding.ts';
import { DEFAULT_FOUNDATION_CONFIG } from './config.ts';
import { withJournalLock } from './journal-lock.ts';
import { createTestRootRegistry } from './test-root.ts';
import {
  resolveWakeSupervisorStateRoot,
  resolveWorkerMessageDispatchJournalPath,
} from './wake-supervisor-state-root.ts';
import {
  admitDispatchJournalRecord,
  DISPATCH_OUTCOME_IN_FLIGHT,
  finalizeDispatchJournalRecord,
  type DispatchJournalRecord,
} from './worker-dispatch-journal.ts';
import {
  acquireWorkerNudgeClaim,
  finalizeWorkerNudgeClaim,
  markWorkerNudgeSendAttempted,
  persistWorkerNudgeMessageHash,
  workerNudgeClaimNamespace,
} from './worker-nudge-claim-store.ts';
import { resolveVerifiedWorkerNotificationTarget } from './worker-notification-target.ts';

const testRoots = createTestRootRegistry();
const originalAoBaseDir = process.env.AO_BASE_DIR;
const originalLockStaleMs = process.env.AO_WORKER_NOTIFICATION_JOURNAL_LOCK_STALE_MS;

function workerSession(overrides: Partial<AoSessionRow> = {}): AoSessionRow {
  return {
    createdAt: '2026-07-20T00:00:00.000Z',
    harness: 'cursor',
    isTerminated: false,
    issueId: 923,
    lastActivityAt: '2026-07-20T00:10:00.000Z',
    projectId: 'orchestrator-pack',
    id: 'worker-923',
    role: 'worker',
    status: 'working',
    updatedAt: '2026-07-20T00:10:00.000Z',
    ...overrides,
  };
}

function openPr(): OpenPrSnapshotRow {
  return {
    repoSlug: 'chetwerikoff/orchestrator-pack',
    number: 923,
    state: 'OPEN',
    isDraft: false,
    headRefName: 'issue-923-foundation',
    headRefOid: 'a'.repeat(40),
  };
}

function historicalDispatchRecord(overrides: Partial<DispatchJournalRecord> = {}): DispatchJournalRecord {
  return {
    deliveryId: 'worker-923:pack-send:det:historical',
    sessionId: 'worker-923',
    deliveredAtMs: Date.parse('2026-07-20T00:00:00.000Z'),
    source: 'pack-send',
    sourceKey: 'sha256-historical',
    deliveryPath: 'pending-draft',
    messageShape: { charLength: 512, lineCount: 8 },
    dispatchOutcome: DISPATCH_OUTCOME_IN_FLIGHT,
    draftState: 'draft_present',
    deterministicKey: 'worker-notification:historical:' + 'a'.repeat(40),
    findingsHash: 'sha256:' + 'b'.repeat(64),
    reviewRunId: 'prr-historical',
    prNumber: 923,
    headSha: 'a'.repeat(40),
    historicalExtension: { preserved: true },
    ...overrides,
  };
}

afterEach(() => {
  if (originalAoBaseDir === undefined) delete process.env.AO_BASE_DIR;
  else process.env.AO_BASE_DIR = originalAoBaseDir;
  if (originalLockStaleMs === undefined) {
    delete process.env.AO_WORKER_NOTIFICATION_JOURNAL_LOCK_STALE_MS;
  } else {
    process.env.AO_WORKER_NOTIFICATION_JOURNAL_LOCK_STALE_MS = originalLockStaleMs;
  }
  testRoots.cleanup();
});

describe('[AC4] TypeScript notification compatibility', () => {
  it('normalizes the verified live AO string issueId without broadening the row schema', () => {
    expect(normalizeAoSessionRow({ ...workerSession(), issueId: '923' })).toMatchObject({ issueId: 923 });
    expect(normalizeAoSessionRow({ ...workerSession(), issueId: '923', branch: 'issue-923' })).toBeNull();
  });

  it('resolves one live owner from one session-list and one bulk PR snapshot, then persists generation ownership', async () => {
    const root = testRoots.create('opk-pr2-target-');
    process.env.AO_BASE_DIR = path.join(root, 'ao-base');
    let versionReads = 0;
    let sessionReads = 0;
    let prReads = 0;
    let repoReads = 0;

    const result = await resolveVerifiedWorkerNotificationTarget({
      trustedPackRoot: root,
      repoRoot: root,
      projectId: 'orchestrator-pack',
      requestedSessionId: 'worker-923',
      prNumber: 923,
      headSha: 'a'.repeat(40),
      config: DEFAULT_FOUNDATION_CONFIG.notification,
      dependencies: {
        loadAoVersion: async () => {
          versionReads += 1;
          return '0.10.3';
        },
        loadSessions: async () => {
          sessionReads += 1;
          return [workerSession()];
        },
        loadOpenPrs: async () => {
          prReads += 1;
          return [openPr()];
        },
        resolveRepoSlug: async () => {
          repoReads += 1;
          return 'chetwerikoff/orchestrator-pack';
        },
      },
    });

    expect({ versionReads, sessionReads, prReads, repoReads }).toEqual({
      versionReads: 1,
      sessionReads: 1,
      prReads: 1,
      repoReads: 1,
    });
    expect(result).toMatchObject({
      sessionId: 'worker-923',
      targetId: 'worker-923',
      targetGeneration: 'worker-923',
      workerTarget: 'worker-923:worker-923',
    });
    const claimPath = path.join(
      process.env.AO_BASE_DIR,
      'projects',
      'orchestrator-pack',
      'pr-ownership-claims',
      'pr-923.json',
    );
    expect(existsSync(claimPath)).toBe(true);
    expect(JSON.parse(readFileSync(claimPath, 'utf8'))).toMatchObject({
      prNumber: 923,
      ownerSessionId: 'worker-923',
      generation: 'worker-923',
    });
  });

  it('delivers to a successor exact-head owner when the review session is stale', async () => {
    const root = testRoots.create('opk-pr2-successor-target-');
    process.env.AO_BASE_DIR = path.join(root, 'ao-base');
    const successor = workerSession({
      id: 'worker-923-successor',
      createdAt: '2026-07-20T01:00:00.000Z',
      lastActivityAt: '2026-07-20T01:10:00.000Z',
      updatedAt: '2026-07-20T01:10:00.000Z',
    });
    const result = await resolveVerifiedWorkerNotificationTarget({
      trustedPackRoot: root,
      repoRoot: root,
      projectId: 'orchestrator-pack',
      requestedSessionId: 'worker-923',
      prNumber: 923,
      headSha: 'a'.repeat(40),
      config: DEFAULT_FOUNDATION_CONFIG.notification,
      dependencies: {
        loadAoVersion: async () => '0.10.3',
        loadSessions: async () => [
          workerSession({ isTerminated: true, status: 'terminated' }),
          successor,
        ],
        loadOpenPrs: async () => [openPr()],
        resolveRepoSlug: async () => 'chetwerikoff/orchestrator-pack',
      },
    });
    expect(result).toMatchObject({
      sessionId: 'worker-923-successor',
      targetId: 'worker-923-successor',
      targetGeneration: 'worker-923-successor',
      workerTarget: 'worker-923-successor:worker-923-successor',
    });
    const claimPath = path.join(
      process.env.AO_BASE_DIR,
      'projects',
      'orchestrator-pack',
      'pr-ownership-claims',
      'pr-923.json',
    );
    expect(JSON.parse(readFileSync(claimPath, 'utf8'))).toMatchObject({
      ownerSessionId: 'worker-923-successor',
      generation: 'worker-923-successor',
    });
  });

  it('matches canonical wake-supervisor state-root precedence on Linux and Windows', () => {
    expect(resolveWakeSupervisorStateRoot({
      env: {
        AO_WAKE_SUPERVISOR_STATE_DIR: '/override/wake',
        XDG_STATE_HOME: '/ignored/xdg',
      },
      platform: 'linux',
      homeDir: '/home/test',
    })).toBe('/override/wake');
    expect(resolveWorkerMessageDispatchJournalPath({
      env: { XDG_STATE_HOME: '/state' },
      platform: 'linux',
      homeDir: '/home/test',
    })).toBe('/state/orchestrator-pack-wake-supervisor/worker-message-dispatch-journal.json');
    expect(resolveWorkerMessageDispatchJournalPath({
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
      platform: 'win32',
      homeDir: 'C:\\Users\\test',
    })).toBe('C:\\Users\\test\\AppData\\Local\\orchestrator-pack-wake-supervisor\\worker-message-dispatch-journal.json');
    expect(resolveWakeSupervisorStateRoot({
      env: {},
      platform: 'linux',
      homeDir: '/home/test',
    })).toBe('/home/test/.local/state/orchestrator-pack-wake-supervisor');
  });

  it('fails closed when live AO version provenance is not exactly 0.10.3', async () => {
    const root = testRoots.create('opk-pr2-version-');
    process.env.AO_BASE_DIR = path.join(root, 'ao-base');
    await expect(resolveVerifiedWorkerNotificationTarget({
      trustedPackRoot: root,
      repoRoot: root,
      projectId: 'orchestrator-pack',
      requestedSessionId: 'worker-923',
      prNumber: 923,
      headSha: 'a'.repeat(40),
      config: DEFAULT_FOUNDATION_CONFIG.notification,
      dependencies: {
        loadAoVersion: async () => '0.10.4',
        loadSessions: async () => [workerSession()],
        loadOpenPrs: async () => [openPr()],
        resolveRepoSlug: async () => 'chetwerikoff/orchestrator-pack',
      },
    })).rejects.toThrow('preflight_version_unverifiable');
  });

  it('preserves single-flight claim, message hash, send-attempt, terminal dedupe, and material-change escalation', async () => {
    const root = testRoots.create('opk-pr2-claim-');
    process.env.AO_BASE_DIR = path.join(root, 'ao-base');
    const base = {
      prNumber: 923,
      cycleKey: `stdout:sha256:${'b'.repeat(64)}`,
      intentClass: 'review-findings',
      workerTarget: 'worker-923:generation-1',
      sessionId: 'worker-923',
      targetId: 'worker-923',
      targetGeneration: 'generation-1',
      surface: 'scripted-review-stdout-delivery',
      projectId: 'orchestrator-pack',
      message: 'Pack review completed for PR #923.',
    };

    const first = await acquireWorkerNudgeClaim(base);
    expect(first).toMatchObject({ acquired: true });
    if (!first.acquired) throw new Error(first.reason);
    expect(await persistWorkerNudgeMessageHash(first, base.message)).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(first)).toEqual({ ok: true });
    expect(await finalizeWorkerNudgeClaim(first, 'SENT')).toMatchObject({ ok: true });

    expect(await acquireWorkerNudgeClaim(base)).toMatchObject({
      acquired: false,
      reason: 'already_served',
      terminal: true,
      phase: 'SENT',
    });
    expect(await acquireWorkerNudgeClaim({ ...base, message: `${base.message}\nNew findings.` })).toMatchObject({
      acquired: false,
      reason: 'materially_new_content',
      escalate: true,
    });
  });

  it('retries D4 sends after uncertain finalization and crashed send-attempt recovery', async () => {
    const root = testRoots.create('opk-pr2-claim-d4-');
    process.env.AO_BASE_DIR = path.join(root, 'ao-base');
    const base = {
      prNumber: 923,
      cycleKey: `stdout:sha256:${'c'.repeat(64)}`,
      intentClass: 'review-findings',
      workerTarget: 'worker-923:generation-d4',
      sessionId: 'worker-923',
      targetId: 'worker-923',
      targetGeneration: 'generation-d4',
      surface: 'scripted-review-stdout-delivery',
      projectId: 'orchestrator-pack',
      message: 'Pack review completed for PR #923.',
    };
    const records = (): Array<Record<string, unknown>> => {
      const directory = path.join(workerNudgeClaimNamespace('orchestrator-pack'), 'terminal');
      return readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as Record<string, unknown>);
    };

    const uncertain = await acquireWorkerNudgeClaim(base);
    expect(uncertain).toMatchObject({ acquired: true });
    if (!uncertain.acquired) throw new Error(uncertain.reason);
    expect(await persistWorkerNudgeMessageHash(uncertain, base.message)).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(uncertain)).toEqual({ ok: true });
    expect(await finalizeWorkerNudgeClaim(uncertain, 'UNCERTAIN', {
      reason: 'dispatch_timeout',
    })).toMatchObject({ ok: true });

    const retry = await acquireWorkerNudgeClaim(base);
    expect(retry).toMatchObject({ acquired: true });
    if (!retry.acquired) throw new Error(retry.reason);
    expect(retry.claim.holder.processGuid).not.toBe(uncertain.claim.holder.processGuid);
    expect(records()).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'UNCERTAIN', state: 'UNCERTAIN' }),
    ]));
    expect(await persistWorkerNudgeMessageHash(retry, base.message)).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(retry)).toEqual({ ok: true });
    expect(await finalizeWorkerNudgeClaim(retry, 'SENT')).toMatchObject({ ok: true });

    const interruptedBase = {
      ...base,
      cycleKey: `${base.cycleKey}:interrupted`,
    };
    const interrupted = await acquireWorkerNudgeClaim(interruptedBase);
    expect(interrupted).toMatchObject({ acquired: true });
    if (!interrupted.acquired) throw new Error(interrupted.reason);
    expect(await persistWorkerNudgeMessageHash(interrupted, interruptedBase.message)).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(interrupted)).toEqual({ ok: true });

    const recovered = await acquireWorkerNudgeClaim(interruptedBase);
    expect(recovered).toMatchObject({ acquired: true });
    if (!recovered.acquired) throw new Error(recovered.reason);
    expect(recovered.claim.holder.processGuid).not.toBe(interrupted.claim.holder.processGuid);
    expect(records()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'UNCERTAIN',
        state: 'UNCERTAIN',
        recoveredFromPhase: 'SEND_ATTEMPTED',
        retryAllowed: true,
      }),
    ]));
    expect(await persistWorkerNudgeMessageHash(recovered, interruptedBase.message)).toMatchObject({ ok: true });
    expect(await markWorkerNudgeSendAttempted(recovered)).toEqual({ ok: true });
    expect(await finalizeWorkerNudgeClaim(recovered, 'SENT')).toMatchObject({ ok: true });
  });

  it('uses the canonical bounded journal for historical bytes, fence transitions, and capacity refusal', () => {
    const record = historicalDispatchRecord();
    const admitted = admitDispatchJournalRecord({}, record, record.deliveredAtMs);
    expect(admitted).toMatchObject({
      ok: true,
      record: {
        deliveryId: record.deliveryId,
        fenceLifecycle: 'pending',
        historicalExtension: { preserved: true },
        reviewRunId: 'prr-historical',
      },
    });
    if (!admitted.ok) throw new Error(admitted.reason);

    const finalized = finalizeDispatchJournalRecord(
      admitted.journal,
      record.deliveryId,
      'send_failed',
      record.deliveredAtMs + 1,
      'draft_present',
    );
    expect(finalized).toMatchObject({
      ok: true,
      record: {
        dispatchOutcome: 'send_failed',
        fenceLifecycle: 'failed-uncertain',
        historicalExtension: { preserved: true },
        reviewRunId: 'prr-historical',
      },
    });

    const oversizedPending = historicalDispatchRecord({
      deliveryId: 'oversized-pending',
      auditNote: 'x'.repeat(800_000),
    });
    const refused = admitDispatchJournalRecord(
      { [oversizedPending.deliveryId]: oversizedPending },
      historicalDispatchRecord({ deliveryId: 'new-delivery' }),
      Date.now(),
    );
    expect(refused).toMatchObject({ ok: false, reason: 'over_capacity', backpressure: true });
  });

  it('reclaims a crashed journal lock but never removes a live owner lock', async () => {
    const root = testRoots.create('opk-pr2-journal-lock-');
    const journalPath = path.join(root, 'dispatch.json');
    const lockPath = `${journalPath}.lock`;
    process.env.AO_WORKER_NOTIFICATION_JOURNAL_LOCK_STALE_MS = '1000';

    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      nonce: 'dead-owner',
      acquiredAtMs: Date.now() - 10_000,
    })}\n`, 'utf8');
    await expect(withJournalLock(journalPath, 1, async () => 'recovered')).resolves.toBe('recovered');
    expect(existsSync(lockPath)).toBe(false);

    for (const [nonce, acquiredAtMs] of [
      ['live-owner-current', Date.now()],
      ['live-owner-old', Date.now() - 10_000],
    ] as const) {
      writeFileSync(lockPath, `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        nonce,
        acquiredAtMs,
      })}\n`, 'utf8');
      await expect(withJournalLock(journalPath, 1, async () => 'must-not-run')).rejects.toThrow('journal_busy');
      expect(existsSync(lockPath)).toBe(true);
    }
  });

  it('contains no PowerShell child while retaining target, claim, fence, and canonical journal calls', () => {
    const files = [
      path.resolve('scripts/pr2-foundation/worker-notification.ts'),
      path.resolve('scripts/pr2-foundation/worker-notification-target.ts'),
      path.resolve('scripts/pr2-foundation/worker-nudge-claim-store.ts'),
      path.resolve('scripts/pr2-foundation/worker-dispatch-journal.ts'),
    ];
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/\bpwsh\b/i);
    expect(source).not.toMatch(/\.ps1\b/i);
    expect(source).toContain('resolveVerifiedWorkerNotificationTarget');
    expect(source).toContain('acquireWorkerNudgeClaim');
    expect(source).toContain('withWorkerNudgeSideEffectFence');
    expect(source).toContain('admitNotification');
    expect(source).toContain('finalizeNotification');
    expect(source).toContain('worker-message-dispatch-observe');
  });
});
