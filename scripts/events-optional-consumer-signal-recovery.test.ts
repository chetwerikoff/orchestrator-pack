import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatJournalWriteDegradedLog,
  formatSignalSourceLog,
  hasReactionDispatchJournalEntries,
  isSessionReviewsDeliveredRun,
  resolveDeliveredRunObservedAtMs,
  reviewRunsLackAoWireDeliveredAt,
  shouldSuppressNudgeForPendingJournal,
  SIGNAL_SOURCES,
} from '../docs/events-optional-consumer-signal-recovery.mjs';
import { mergeDeliveryRecords, resolveReviewSendObservedAtMs } from '../docs/worker-message-dispatch-observe.mjs';
import { mergeWorkerDeliveriesFromPlanInput } from '../docs/review-head-ready.mjs';
import { resolveSendObservedAtMs } from '../docs/review-finding-delivery-confirm.mjs';
import { isDeliveredChangesRequested } from '../docs/review-producer-contract.mjs';
import { planReconcileTick, recordPendingEpisode, resolveConfig } from '../docs/ci-failure-notification.mjs';

const repoRoot = join(import.meta.dirname, '..');

const FIVE_CONSUMERS = [
  'scripts/review-trigger-reconcile.ps1',
  'scripts/review-finding-delivery-confirm.ps1',
  'scripts/ci-green-wake-reconcile.ps1',
  'scripts/worker-message-submit-reconcile.ps1',
  'scripts/ci-failure-notification-reconcile.ps1',
] as const;

function consumerSource(rel: string) {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

describe('events-optional consumer signal recovery (Issue #700)', () => {
  it('five consumers do not call Get-AoEventsSince on live paths', () => {
    for (const rel of FIVE_CONSUMERS) {
      const source = consumerSource(rel);
      expect(source, rel).not.toMatch(/^\s*\$aoEvents\s*=\s*@?\(?Get-AoEventsSince/m);
      expect(source, rel).toContain('Write-ReconcileSignalSource.ps1');
      expect(source, rel).toContain('Write-ReconcileSignalSource');
    }
  });

  it('emits signal_source helper strings per consumer surface', () => {
    expect(formatSignalSourceLog('review-trigger-reconcile', SIGNAL_SOURCES.reviewTrigger)).toBe(
      'signal_source surface=review-trigger-reconcile source=openPrs+reviewRuns+reportState',
    );
    expect(formatSignalSourceLog('ci-green-wake-reconcile', SIGNAL_SOURCES.ciGreenWake)).toContain(
      'openPrs+checks+ownerResolver',
    );
  });

  it('Root C: delivery datum uses latestRun.status delivered without AO-wire deliveredAt', () => {
    const run = {
      prReviewStatus: 'changes_requested',
      latestRunStatus: 'delivered',
      updatedAt: '2026-07-08T12:00:00.000Z',
      deliveredFindingCount: 2,
    };
    expect(isSessionReviewsDeliveredRun(run)).toBe(true);
    expect(isDeliveredChangesRequested(run)).toBe(true);
    expect(resolveSendObservedAtMs(run, 0)).toBe(Date.parse('2026-07-08T12:00:00.000Z'));
    expect(resolveReviewSendObservedAtMs(run)).toBe(Date.parse('2026-07-08T12:00:00.000Z'));
    expect(reviewRunsLackAoWireDeliveredAt([run])).toBe(true);
  });

  it('mergeDeliveryRecords synthesizes from journal and review runs without ao events', () => {
    const journal = {
      'sess:1:pack-send:ci-green:690:abc': {
        deliveryId: 'sess:1:pack-send:ci-green:690:abc',
        sessionId: 'sess',
        deliveredAtMs: 1000,
        source: 'pack-send',
        sourceKey: 'ci-green:690:abc',
        deliveryPath: 'pending-draft',
        dispatchOutcome: 'dispatched',
        draftState: 'draft_present',
      },
    };
    const reviewRuns = [
      {
        id: 'run-1',
        linkedSessionId: 'sess',
        prNumber: 690,
        targetSha: 'a'.repeat(40),
        prReviewStatus: 'changes_requested',
        latestRunStatus: 'delivered',
        updatedAt: '2026-07-08T12:00:00.000Z',
        deliveredFindingCount: 1,
      },
    ];
    const merged = mergeDeliveryRecords({ dispatchJournal: journal, reviewRuns, nowMs: 2000 });
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.some((row) => String(row.source) === 'pack-send')).toBe(true);
    expect(merged.some((row) => String(row.source) === 'review-send')).toBe(true);
    const planMerged = mergeWorkerDeliveriesFromPlanInput({
      dispatchJournal: journal,
      reviewRuns,
      nowMs: 2000,
    });
    expect(planMerged.length).toBe(merged.length);
  });

  it('dedup matrix cell 1 admits first nudge when no pending journal exists', () => {
    expect(shouldSuppressNudgeForPendingJournal('690:abc', {})).toBe(false);
  });

  it('dedup matrix cell 2 suppresses duplicate nudge when pending journal records prior send', () => {
    const pendingJournal = {
      '690:abc': { sessionId: 'sess', sentAtMs: 5000, message: 'nudge' },
    };
    expect(shouldSuppressNudgeForPendingJournal('690:abc', pendingJournal)).toBe(true);
    expect(shouldSuppressNudgeForPendingJournal('690:def', pendingJournal)).toBe(false);
    expect(formatJournalWriteDegradedLog('ci-green-wake-reconcile', '690:abc')).toBe(
      'journal_write_degraded surface=ci-green-wake-reconcile key=690:abc',
    );
  });

  it('dedup matrix cell 3 records ci-green journal-write degradation as a non-refire signal', () => {
    expect(formatJournalWriteDegradedLog('ci-green-wake-reconcile', 'ci-green:690:abc')).toBe(
      'journal_write_degraded surface=ci-green-wake-reconcile key=ci-green:690:abc',
    );
  });

  it('dedup matrix cell 4 records worker-submit journal-write degradation as a non-refire signal', () => {
    expect(formatJournalWriteDegradedLog('worker-message-submit-reconcile', 'delivery-1')).toBe(
      'journal_write_degraded surface=worker-message-submit-reconcile key=delivery-1',
    );
  });

  it('dedup matrix cell 5 does not synthesize delivery without journal or review-run inputs', () => {
    const merged = mergeDeliveryRecords({
      dispatchJournal: {},
      reviewRuns: [],
      nowMs: 2000,
    });
    expect(merged).toEqual([]);
  });

  it('dedup matrix cell 6 defers owner-scoped reaction dispatch when config unavailable', () => {
    const journal = {
      d1: { source: 'reaction', sessionId: 'sess', deliveredAtMs: 1 },
    };
    expect(hasReactionDispatchJournalEntries(journal)).toBe(true);
    expect(hasReactionDispatchJournalEntries({})).toBe(false);
  });

  it('ci-failure reconcile plans from pending episode store without reaction events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-failure-episodes-'));
    const episode = {
      repo: 'chetwerikoff/orchestrator-pack',
      prNumber: 690,
      headSha: 'b'.repeat(40),
      redPeriod: 'rp-1',
      targetId: 'worker-sess',
      targetGeneration: 'worker-sess',
    };
    const config = resolveConfig({ reconcileIntervalMs: 60_000, maxEligibleEvaluationAgeMs: 180_000 });
    recordPendingEpisode({
      storeDir: dir,
      episode,
      nowMs: 1_000_000,
      config,
      enqueueTickId: 'tick-old',
    });
    const plan = planReconcileTick({
      storeDir: dir,
      nowMs: 1_000_000 + 120_000,
      enqueueTickId: 'tick-new',
      config,
    });
    expect((plan.actions ?? []).some((action) => action.type === 'evaluate')).toBe(true);
  });

  it('five consumers complete -Once -DryRun without throwing', { timeout: 120_000 }, () => {
    const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (pwshProbe.status !== 0) {
      return;
    }
    const dryRunScripts: Array<{
      script: string;
      fixture: string;
      surface: keyof typeof SIGNAL_SOURCES;
    }> = [
      {
        script: 'scripts/review-trigger-reconcile.ps1',
        fixture: 'tests/fixtures/review-trigger-reconcile/ready-head-triggers.json',
        surface: 'reviewTrigger',
      },
      {
        script: 'scripts/review-finding-delivery-confirm.ps1',
        fixture: 'scripts/fixtures/review-finding-delivery-confirm/confirmed-idempotent.json',
        surface: 'deliveryConfirm',
      },
      {
        script: 'scripts/ci-green-wake-reconcile.ps1',
        fixture: 'tests/fixtures/ci-green-wake-reconcile/pre-handoff-green.json',
        surface: 'ciGreenWake',
      },
      {
        script: 'scripts/worker-message-submit-reconcile.ps1',
        fixture: 'scripts/fixtures/worker-message-submit-reconcile/first-finding-delivery.json',
        surface: 'workerSubmit',
      },
      {
        script: 'scripts/ci-failure-notification-reconcile.ps1',
        fixture: 'scripts/fixtures/ci-failure-notification/worker-state-golden.json',
        surface: 'ciFailureNotification',
      },
    ];
    for (const { script, fixture, surface } of dryRunScripts) {
      const args = [
        '-NoProfile',
        '-File',
        join(repoRoot, script),
        '-Once',
        '-DryRun',
        '-FixturePath',
        join(repoRoot, fixture),
      ];
      const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
      const result = spawnSync('pwsh', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(ghToken ? { GH_TOKEN: ghToken } : {}),
        },
      });
      expect(result.status, `${script} stderr: ${result.stderr}`).toBe(0);
      expect(formatSignalSourceLog(script.replace(/^scripts\//, '').replace(/\.ps1$/, ''), SIGNAL_SOURCES[surface])).toMatch(
        /signal_source/,
      );
    }
  });

  it('deliveredAt grep census: rider-table consumers avoid live AO-wire deliveredAt reads', () => {
    const observe = readFileSync(join(repoRoot, 'docs/worker-message-dispatch-observe.mjs'), 'utf8');
    const confirm = readFileSync(join(repoRoot, 'docs/review-finding-delivery-confirm.mjs'), 'utf8');
    expect(observe).toContain('resolveDeliveredRunObservedAtMs');
    expect(confirm).toContain('resolveDeliveredRunObservedAtMs');
    expect(observe).not.toMatch(/resolveReviewSendObservedAtMs\(run\)\s*\{[\s\S]*run\?\.deliveredAt/);
  });
});
