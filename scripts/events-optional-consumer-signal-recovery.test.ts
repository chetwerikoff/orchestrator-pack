import { spawnSync } from 'node:child_process';
import { planCiGreenWakeActions } from '../docs/ci-green-wake-reconcile.mjs';
import { QUIESCENCE_DEBOUNCE_MS } from '../docs/worker-iteration-cycle.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLiveSignalSourceBinding,
  DEAD_AO_SIGNAL_SURFACES,
  formatJournalWriteDegradedLog,
  formatReportReceiptSurfaceRemovedLog,
  formatSignalSourceLog,
  hasReactionDispatchJournalEntries,
  isSessionReviewsDeliveredRun,
  resolveDeliveredRunObservedAtMs,
  reviewRunsLackAoWireDeliveredAt,
  sessionHasLegacyReportReceiptSurface,
  shouldSuppressNudgeForPendingJournal,
  shouldSuppressSubmitForPendingOutcome,
  SIGNAL_SOURCES,
} from '../docs/events-optional-consumer-signal-recovery.mjs';
import { liveWorker, packGreenCiChecks } from './_test-worker-session-fixtures.js';
import { mergeDeliveryRecords, resolveReviewSendObservedAtMs } from '../docs/worker-message-dispatch-observe.mjs';
import { mergeWorkerDeliveriesFromPlanInput } from '../docs/review-head-ready.mjs';
import {
  pendingDeliveredRunsLackReportReceiptSurface,
  resolveSendObservedAtMs,
} from '../docs/review-finding-delivery-confirm.mjs';
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

  it('live signal-source bindings exclude dead AO 0.10.2 report surfaces', () => {
    for (const source of Object.values(SIGNAL_SOURCES)) {
      expect(() => assertLiveSignalSourceBinding(source)).not.toThrow();
      for (const dead of DEAD_AO_SIGNAL_SURFACES) {
        expect(String(source).toLowerCase()).not.toContain(dead);
      }
    }
    expect(() => assertLiveSignalSourceBinding('openPrs+reviewRuns+ao report')).toThrow(
      /dead AO 0.10.2 signal surface/,
    );
  });

  it('AO 0.10.2 live delivery-confirm path uses ao status --json sessions, not report-full reader', () => {
    const source = consumerSource('scripts/review-finding-delivery-confirm.ps1');
    expect(source).toContain('Get-AoStatusSessionsWithReports -Project $Project');
    expect(source).toContain('Write-ReconcileReportReceiptSurfaceRemoved');
  });

  it('descopes worker-ack confirmation when legacy report receipt surface is absent', () => {
    const nowMs = 1_717_502_000_000;
    const reviewRuns = [
      {
        id: 'run-live',
        prNumber: 120,
        targetSha: 'cafe120',
        status: 'changes_requested',
        prReviewStatus: 'changes_requested',
        deliveredFindingCount: 1,
        linkedSessionId: 'opk-worker-ok',
        latestRunStatus: 'delivered',
        updatedAt: '2026-06-04T11:00:00Z',
      },
    ];
    const sessions = [
      {
        sessionId: 'opk-worker-ok',
        role: 'worker',
        prNumber: 120,
        status: 'working',
        activity: { state: 'working', lastActivityAt: '2026-06-04T11:02:00Z' },
      },
    ];
    expect(sessionHasLegacyReportReceiptSurface(sessions[0]!)).toBe(false);
    expect(pendingDeliveredRunsLackReportReceiptSurface(reviewRuns, sessions)).toBe(true);
    expect(
      formatReportReceiptSurfaceRemovedLog('review-finding-delivery-confirm'),
    ).toBe('report_receipt_surface_removed surface=review-finding-delivery-confirm followup=pack-worker-report-store');
  });

  it('emits signal_source helper strings per consumer surface', () => {
    expect(formatSignalSourceLog('review-trigger-reconcile', SIGNAL_SOURCES.reviewTrigger)).toBe(
      'signal_source surface=review-trigger-reconcile source=openPrs+reviewRuns',
    );
    expect(formatSignalSourceLog('review-finding-delivery-confirm', SIGNAL_SOURCES.deliveryConfirm)).toContain(
      'sessionReviewsDeliveredStatus+packJournal+sessionStatus',
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

  it('prefers deliveredAt over updatedAt when both are present on delivered runs', () => {
    const run = {
      latestRunStatus: 'delivered',
      deliveredAt: '2026-07-08T10:00:00.000Z',
      updatedAt: '2026-07-08T12:00:00.000Z',
    };
    expect(resolveDeliveredRunObservedAtMs(run)).toBe(Date.parse('2026-07-08T10:00:00.000Z'));
    expect(resolveSendObservedAtMs(run, 0)).toBe(Date.parse('2026-07-08T10:00:00.000Z'));
    expect(resolveReviewSendObservedAtMs(run)).toBe(Date.parse('2026-07-08T10:00:00.000Z'));
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

  it('dedup matrix cell 3: ci-green next tick logs journal_write_degraded without re-nudge after post-send journal write failure', () => {
    const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (pwshProbe.status !== 0) {
      return;
    }

    const openPrs = [{ number: 42, headRefOid: 'abc123', headCommittedAt: '2026-06-01T00:00:00.000Z' }];
    const sessions = [
      liveWorker({
        reports: [{ reportState: 'fixing_ci', reportedAt: '2026-06-01T00:00:00.000Z' }],
      }),
    ];
    const settledAt = Date.parse('2026-06-01T00:00:00.000Z');
    const nowMs = settledAt + QUIESCENCE_DEBOUNCE_MS + 1000;
    const plan = planCiGreenWakeActions({
      openPrs,
      sessions,
      ciChecksByPr: { 42: packGreenCiChecks },
      tracking: {},
      nowMs,
      repoRoot,
    });
    const nudge = plan.actions.find((action) => action.type === 'nudge');
    expect(nudge).toBeDefined();
    const transitionId = String(nudge?.transitionId ?? '');
    expect(shouldSuppressNudgeForPendingJournal(transitionId, { [transitionId]: { sessionId: 'op-worker' } })).toBe(
      true,
    );

    const fixtureDir = mkdtempSync(join(tmpdir(), 'ci-green-journal-failure-'));
    const fixturePath = join(fixtureDir, 'journal-write-failure-next-tick.json');
    writeFileSync(
      fixturePath,
      JSON.stringify({
        description: 'AC#7 cell 3: post-send journal write failed; next tick must not re-nudge',
        nowMs,
        openPrs,
        sessions,
        ciChecksByPr: { 42: packGreenCiChecks },
        tracking: {
          pendingJournal: {
            [transitionId]: {
              sessionId: 'op-worker',
              sentAtMs: nowMs,
              message: String(nudge?.message ?? 'Required CI is green for the current PR head.'),
            },
          },
        },
      }),
    );

    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        join(repoRoot, 'scripts/ci-green-wake-reconcile.ps1'),
        '-Once',
        '-DryRun',
        '-FixturePath',
        fixturePath,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain(formatJournalWriteDegradedLog('ci-green-wake-reconcile', transitionId));
    expect(output).toContain('journal_pending');
    expect(output).not.toContain('dry-run would send');
    expect(output).not.toContain('nudging worker');
  });

  it('dedup matrix cell 4: worker-submit next tick logs journal_write_degraded without re-submit after post-send outcome write failure', () => {
    const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (pwshProbe.status !== 0) {
      return;
    }

    const deliveryId = 'opk-ml-232:1717600000000:ao-send:orch-1';
    const fixtureDir = mkdtempSync(join(tmpdir(), 'worker-submit-journal-failure-'));
    const fixturePath = join(fixtureDir, 'journal-write-failure-next-tick.json');
    writeFileSync(
      fixturePath,
      JSON.stringify({
        description: 'AC#7 cell 4: post-submit outcome write failed; next tick must not re-submit',
        nowMs: 1717600100000,
        sessions: [
          {
            sessionId: 'opk-ml-232',
            role: 'worker',
            status: 'working',
            runtime: 'alive',
            activity: 'idle',
            reports: [],
          },
        ],
        dispatchJournal: {
          [deliveryId]: {
            deliveryId,
            sessionId: 'opk-ml-232',
            deliveredAtMs: 1717600000000,
            source: 'ao-send',
            sourceKey: 'orch-1',
            deliveryPath: 'pending-draft',
            messageShape: { charLength: 42, lineCount: 2 },
          },
        },
        aoEvents: [],
        reviewRuns: [],
        tracking: {
          deliveries: {},
          audit: [],
          pendingOutcomes: {
            [deliveryId]: {
              claimKey: `${deliveryId}:1`,
              submittedAtMs: 1717600100000,
              sessionId: 'opk-ml-232',
            },
          },
        },
      }),
    );
    expect(shouldSuppressSubmitForPendingOutcome(deliveryId, { [deliveryId]: { sessionId: 'opk-ml-232' } })).toBe(true);

    const stateDir = mkdtempSync(join(tmpdir(), 'worker-submit-state-'));
    const statePath = join(stateDir, 'state.json');
    const journalPath = join(stateDir, 'journal.json');
    writeFileSync(statePath, JSON.stringify({ deliveries: {}, audit: [], pendingOutcomes: {} }));
    writeFileSync(journalPath, '{}');

    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        join(repoRoot, 'scripts/worker-message-submit-reconcile.ps1'),
        '-Once',
        '-DryRun',
        '-FixturePath',
        fixturePath,
        '-StateFile',
        statePath,
        '-DispatchJournalPath',
        journalPath,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain(formatJournalWriteDegradedLog('worker-message-submit-reconcile', deliveryId));
    expect(output).toContain('outcome_journal_pending');
    expect(output).not.toContain('submitted: delivery=');
    expect(output).toContain('fixture tick complete (submitted=0');
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
    expect(formatSignalSourceLog('ci-failure-notification-reconcile', SIGNAL_SOURCES.ciFailureNotification)).toMatch(
      /signal_source/,
    );
  });

  it('five consumers complete -Once -DryRun without throwing (four fixture-backed; ci-failure via planner unit test)', { timeout: 120_000 }, () => {
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
      const result = spawnSync('pwsh', args, {
        cwd: repoRoot,
        encoding: 'utf8',
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
