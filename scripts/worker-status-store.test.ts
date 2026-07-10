import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createDefaultWorkerStatusStore,
  evictWorkerStatusRecords,
  fuseWorkerStatus,
  mergeWorkerStatusIntoSessions,
  readWorkerStatusForDecision,
  readWorkerStatusStoreFile,
  recomputeWorkerStatusRow,
  shouldRefuseMonotonicWrite,
  shouldReloadMixedGeneration,
  mergeGenerationVectorMax,
  testSiblingReadiness,
  validateReportAgainstHead,
  writeWorkerStatusStoreFile,
  evaluateWorkerStatusKillSwitch,
  WORKER_STATUS_STORE_SCHEMA_VERSION,
  resolveWorkerStatusSessionBinding,
} from './lib/worker-status-store.mjs';
import type { RecomputeWorkerStatusRowResult } from './lib/worker-status-store.mjs';
declare module '../docs/review-producer-contract.mjs' {
  export function assertNoDaemonStatusDecisionRead(value: unknown): true;
}

import { assertNoDaemonStatusDecisionRead } from '../docs/review-producer-contract.mjs';
import { planCiGreenWakeActions } from '../docs/ci-green-wake-reconcile.mjs';

const repoRoot = join(import.meta.dirname, '..');

const GREEN_MERGE_CONTRACT_CHECKS = [
  { name: 'verify orchestrator-pack structure', conclusion: 'success', status: 'completed' },
  { name: 'pr scope guard', conclusion: 'success', status: 'completed' },
  { name: 'run pack contract tests', conclusion: 'success', status: 'completed' },
  { name: 'self-architect lint', conclusion: 'success', status: 'completed' },
];

const captureManifest = JSON.parse(
  readFileSync(join(repoRoot, 'tests/external-output-references/capture-manifest.json'), 'utf8'),
);

function pr713Fixture() {
  return {
    sessionId: 'opk-713',
    binding: { ok: true, prNumber: 713, headSha: 'abc713head' },
    github: {
      prOpen: true,
      headSha: 'abc713head',
      reviewRuns: [
        {
          prNumber: 713,
          targetSha: 'abc713head',
          latestRunStatus: 'running',
          prReviewStatus: 'running',
        },
      ],
      ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
      requiredCheckNames: [],
      repoTickGeneration: 42,
    },
    report: {
      reportState: 'needs_input',
      headSha: 'stale713head',
      prNumber: 713,
    },
    osLiveness: 'pane-alive',
    sessionActivity: 'needs_input',
    webhookHint: false,
    sourceGeneration: {
      repoTickGeneration: 42,
      reportStoreGeneration: 10,
      journalCursor: 5,
      bindingCacheGeneration: 3,
    },
    nowMs: 1_700_000_000_000,
  };
}

describe('worker-status pr713 review-active', () => {
  it('fusion reader returns review_active for PR-open-plus-review-active fixture when daemon session.status is needs_input and report row is invalidated against current head', () => {
    const result = fuseWorkerStatus(pr713Fixture());
    expect(result.derivedStatus).toBe('review_active');
    expect(result.winningSource).toBe('github');
    expect(result.diagnostics.some((d: string) => d.startsWith('report_invalidated'))).toBe(true);
  });

  it('identical status when webhook hint absent (C1b)', () => {
    const withWebhook = fuseWorkerStatus({ ...pr713Fixture(), webhookHint: true });
    const withoutWebhook = fuseWorkerStatus({ ...pr713Fixture(), webhookHint: false });
    expect(withWebhook.derivedStatus).toBe('review_active');
    expect(withoutWebhook.derivedStatus).toBe('review_active');
  });
});

describe('worker-status fusion precedence', () => {
  it('red required CI overrides valid ready_for_review report', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c2b',
      binding: { ok: true, prNumber: 2, headSha: 'head2' },
      github: {
        prOpen: true,
        headSha: 'head2',
        reviewRuns: [],
        ciChecks: [{ name: 'scope-guard', conclusion: 'failure', status: 'completed' }],
        requiredCheckNames: ['scope-guard'],
        repoTickGeneration: 1,
      },
      report: { reportState: 'ready_for_review', headSha: 'head2', prNumber: 2 },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 1, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('ci_failed');
    expect(result.winningSource).toBe('github_ci');
  });

  it('pending CI blocks valid ready_for_review report', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c2c',
      binding: { ok: true, prNumber: 2, headSha: 'head2' },
      github: {
        prOpen: true,
        headSha: 'head2',
        reviewRuns: [],
        ciChecks: [{ name: 'scope-guard', conclusion: '', status: 'in_progress' }],
        requiredCheckNames: ['scope-guard'],
        repoTickGeneration: 1,
      },
      report: { reportState: 'ready_for_review', headSha: 'head2', prNumber: 2 },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 1, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('pr_open');
    expect(result.winningSource).toBe('github_pr');
  });

  it('requires open PR before accepting ready_for_review report', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c2c',
      binding: { ok: true, prNumber: 2, headSha: 'head2' },
      github: {
        prOpen: false,
        headSha: 'head2',
        reviewRuns: [],
        ciChecks: [],
        requiredCheckNames: [],
        repoTickGeneration: 1,
      },
      report: { reportState: 'ready_for_review', headSha: 'head2', prNumber: 2 },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 1, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('unknown');
    expect(result.degradedReason).toBe('pr_not_open');
    expect(result.winningSource).toBe('degraded');
  });

  it('valid ready_for_review at current head wins (C2)', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c2',
      binding: { ok: true, prNumber: 2, headSha: 'head2' },
      github: {
        prOpen: true,
        headSha: 'head2',
        reviewRuns: [],
        ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
        requiredCheckNames: [],
        repoTickGeneration: 1,
      },
      report: { reportState: 'ready_for_review', headSha: 'head2', prNumber: 2 },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 1, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('ready_for_review');
    expect(result.winningSource).toBe('report_store');
  });

  it('stale report loses to GitHub+CI (C3)', () => {
    const validation = validateReportAgainstHead(
      { reportState: 'ready_for_review', headSha: 'oldhead', prNumber: 3 },
      'newhead',
    );
    expect(validation.invalidated).toBe(true);
    const result = fuseWorkerStatus({
      sessionId: 'opk-c3',
      binding: { ok: true, prNumber: 3, headSha: 'newhead' },
      github: {
        prOpen: true,
        headSha: 'newhead',
        reviewRuns: [],
        ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
        repoTickGeneration: 2,
      },
      report: { reportState: 'ready_for_review', headSha: 'oldhead', prNumber: 3 },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 2, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('pr_open');
    expect(result.invalidatedReport).toBe(true);
  });
});

describe('worker-status ci fallback', () => {
  it('ci_failed when required checks red (C4)', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c4',
      binding: { ok: true, prNumber: 4, headSha: 'head4' },
      github: {
        prOpen: true,
        headSha: 'head4',
        reviewRuns: [],
        ciChecks: [{ name: 'scope-guard', conclusion: 'failure', status: 'completed' }],
        requiredCheckNames: ['scope-guard'],
        repoTickGeneration: 3,
      },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 3, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('ci_failed');
    expect(result).not.toHaveProperty('ciVerdict');
  });

  it('ready_for_review via merge-contract fallback when no branch-protection names (C4b)', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c4b',
      binding: { ok: true, prNumber: 41, headSha: 'head41' },
      github: {
        prOpen: true,
        headSha: 'head41',
        reviewRuns: [],
        ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
        requiredCheckNames: [],
        repoTickGeneration: 4,
      },
      report: { reportState: 'ready_for_review', headSha: 'head41', prNumber: 41 },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 4, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('ready_for_review');
    expect(result.requiredCheckSource).toBeUndefined();
  });

  it('unknown when branch-protection lookup failed (C4c)', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c4c',
      binding: { ok: true, prNumber: 42, headSha: 'head42' },
      github: {
        prOpen: true,
        headSha: 'head42',
        reviewRuns: [],
        ciChecks: [],
        requiredCheckLookupFailed: true,
        repoTickGeneration: 5,
      },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 5, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('unknown');
    expect(result.degradedReason).toBe('ci_lookup_failed');
  });
});

describe('worker-status eviction', () => {
  it('evicts terminated session rows (C10)', () => {
    const store = createDefaultWorkerStatusStore({
      records: {
        dead1: { sessionId: 'dead1', derivedStatus: 'dead', lastUpdatedMs: 1000 },
        live1: { sessionId: 'live1', derivedStatus: 'pr_open', lastUpdatedMs: 1000 },
      },
    });
    const result = evictWorkerStatusRecords(store, [{ sessionId: 'live1' }], 2000);
    expect(result.removed).toBe(1);
    expect(result.store.records.live1).toBeTruthy();
    expect(result.store.records.dead1).toBeUndefined();
  });

  it('recompute marks terminated for eviction (C5 dead)', () => {
    const fused = fuseWorkerStatus({
      sessionId: 'opk-dead',
      binding: { ok: true, prNumber: 5, headSha: 'head5' },
      github: { prOpen: true, headSha: 'head5', reviewRuns: [], repoTickGeneration: 1 },
      osLiveness: 'pane-gone',
      terminated: false,
      sourceGeneration: { repoTickGeneration: 1, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(fused.derivedStatus).toBe('dead');
  });

  it('decision reader path invokes worker-status eviction (C10 wiring)', () => {
    const source = readFileSync(join(import.meta.dirname, 'lib/Get-WorkerStatusDecisionSessions.ps1'), 'utf8');
    expect(source).toContain('Invoke-WorkerStatusStoreEviction');
  });
});

describe('worker-status pr-open idle', () => {
  it('needs_input when session activity is waiting_input (C6)', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c6',
      binding: { ok: true, prNumber: 6, headSha: 'head6' },
      github: {
        prOpen: true,
        headSha: 'head6',
        reviewRuns: [],
        ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
        repoTickGeneration: 6,
      },
      osLiveness: 'pane-alive',
      sessionActivity: 'waiting_input',
      sourceGeneration: { repoTickGeneration: 6, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('needs_input');
  });
});

describe('stale status skip silent', () => {
  it('unknown binding miss skips with degraded diagnostic (C7)', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c7',
      binding: { ok: false, reason: 'binding_miss' },
      github: { unavailable: true },
      osLiveness: 'pane-alive',
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('unknown');
    expect(result.degradedReason).toBe('binding_miss');
  });

  it('binding miss blocks valid ready_for_review report (C7b)', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c7b',
      binding: { ok: false, reason: 'binding_miss' },
      github: {
        prOpen: true,
        headSha: 'head7',
        reviewRuns: [],
        ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
        requiredCheckNames: [],
        repoTickGeneration: 1,
      },
      report: { reportState: 'ready_for_review', headSha: 'head7', prNumber: 7 },
      osLiveness: 'pane-alive',
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('unknown');
    expect(result.degradedReason).toBe('binding_miss');
    expect(result.winningSource).toBe('degraded');
  });

  it('github unavailable fails closed before needs_input (C8)', () => {
    const result = fuseWorkerStatus({
      sessionId: 'opk-c8',
      binding: { ok: true, prNumber: 8, headSha: 'head8' },
      github: { unavailable: true },
      osLiveness: 'pane-alive',
      sessionActivity: 'waiting_input',
      nowMs: 1_700_000_000_000,
    });
    expect(result.derivedStatus).toBe('unknown');
    expect(result.degradedReason).toBe('github_unavailable');
    expect(result.winningSource).toBe('degraded');
  });


  it('preserves missing-report anchor and degrades to unknown past freshness (C14)', () => {
    const freshnessMs = 60_000;
    const anchorMs = 1_700_000_000_000;
    const nowMs = anchorMs + freshnessMs + 1;
    const store = createDefaultWorkerStatusStore({
      records: {
        'opk-c14': {
          sessionId: 'opk-c14',
          derivedStatus: 'pr_open',
          lastUpdatedMs: anchorMs,
          missingReportObservedMs: anchorMs,
          freshnessBoundMs: freshnessMs,
          generationVector: { repoTickGeneration: 1, reportStoreGeneration: 0, journalCursor: 0, bindingCacheGeneration: 0 },
          diagnostics: [],
        },
      },
    });
    const result = recomputeWorkerStatusRow({
      sessionId: 'opk-c14',
      store,
      binding: { ok: true, prNumber: 14, headSha: 'head14' },
      github: {
        prOpen: true,
        headSha: 'head14',
        reviewRuns: [],
        ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
        requiredCheckNames: [],
        repoTickGeneration: 1,
      },
      osLiveness: 'pane-alive',
      freshnessBoundMs: freshnessMs,
      sourceGeneration: { repoTickGeneration: 1, reportStoreGeneration: 0, journalCursor: 0, bindingCacheGeneration: 0 },
      nowMs,
    }) as RecomputeWorkerStatusRowResult;
    expect(result.ok).toBe(true);
    expect(result.row?.derivedStatus).toBe('unknown');
    expect(result.row?.degradedReason).toBe('missing_report_past_freshness_bound');
    expect(result.row?.lastUpdatedMs).toBe(anchorMs);
    expect(result.row?.missingReportObservedMs).toBe(anchorMs);
  });
  it('merge marks stale rows unknown for consumers (C8)', () => {
    const store = createDefaultWorkerStatusStore({
      records: {
        opk: {
          sessionId: 'opk',
          derivedStatus: 'pr_open',
          lastUpdatedMs: 1,
          freshnessBoundMs: 1000,
          sourceGeneration: { repoTickGeneration: 1 },
          diagnostics: [],
        },
      },
    });
    const merged = mergeWorkerStatusIntoSessions(
      [{ sessionId: 'opk', status: 'needs_input', reports: [] }],
      store,
      1_700_000_100_000,
      99,
    );
    expect(merged[0]?.status).toBe('unknown');
    expect(merged[0]?.workerStatusStale).toBe(true);
  });

  it('consumer plan skips when session status unknown — no send substitute', () => {
    const actions = planCiGreenWakeActions({
      openPrs: [{ number: 99, headRefOid: 'head99' }],
      sessions: [
        {
          sessionId: 'opk-unknown',
          role: 'worker',
          prNumber: 99,
          status: 'unknown',
          workerStatusStale: true,
          reports: [],
          runtime: 'active',
        } as Record<string, unknown>,
      ],
      ciChecksByPr: { 99: [{ name: 'scope-guard', conclusion: 'success', status: 'completed' }] },
      requiredCheckNamesByPr: { 99: [] },
      state: {},
      nowMs: 1_700_000_000_000,
    } as Parameters<typeof planCiGreenWakeActions>[0]);
    const nudges = (actions.actions ?? actions).filter((a: { type?: string }) => a.type === 'nudge');
    expect(nudges.length).toBe(0);
  });
});

describe('worker-status webhook non-gating', () => {
  it('webhook accelerates timestamp but steady state matches without webhook (C9)', () => {
    const base = {
      sessionId: 'opk-c9',
      binding: { ok: true, prNumber: 9, headSha: 'head9' },
      github: {
        prOpen: true,
        headSha: 'head9',
        reviewRuns: [],
        ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
        repoTickGeneration: 9,
      },
      report: { reportState: 'ready_for_review', headSha: 'head9', prNumber: 9 },
      osLiveness: 'pane-alive',
      sourceGeneration: { repoTickGeneration: 9, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
      nowMs: 1_700_000_000_000,
    };
    const withHint = fuseWorkerStatus({ ...base, webhookHint: true });
    const withoutHint = fuseWorkerStatus({ ...base, webhookHint: false });
    expect(withHint.derivedStatus).toBe('ready_for_review');
    expect(withoutHint.derivedStatus).toBe('ready_for_review');
    expect(withHint.webhookAccelerated).toBe(true);
    expect(withoutHint.webhookAccelerated).toBe(false);
  });
});

describe('worker-status monotonic generations', () => {
  it('uniformly older source-generation vector is refused (C12)', () => {
    const existing = {
      sourceGeneration: {
        repoTickGeneration: 10,
        reportStoreGeneration: 10,
        journalCursor: 10,
        bindingCacheGeneration: 10,
      },
    };
    const writer = {
      repoTickGeneration: 5,
      reportStoreGeneration: 5,
      journalCursor: 5,
      bindingCacheGeneration: 5,
    };
    expect(shouldRefuseMonotonicWrite(existing, writer)).toBe(true);
    const result = recomputeWorkerStatusRow({
      sessionId: 'opk-c12',
      store: createDefaultWorkerStatusStore({ records: { 'opk-c12': { sessionId: 'opk-c12', ...existing, derivedStatus: 'pr_open', lastUpdatedMs: 1000 } } }),
      binding: { ok: true, prNumber: 12, headSha: 'head12' },
      github: { prOpen: true, headSha: 'head12', reviewRuns: [], repoTickGeneration: 5 },
      sourceGeneration: writer,
      nowMs: 2000,
    }) as RecomputeWorkerStatusRowResult;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('monotonic_refused');
  });

  it('uniformly older generation is refused even when fused status changes (C12)', () => {
    const writer = {
      repoTickGeneration: 5,
      reportStoreGeneration: 5,
      journalCursor: 5,
      bindingCacheGeneration: 5,
    };
    const result = recomputeWorkerStatusRow({
      sessionId: 'opk-c12-status-change',
      store: createDefaultWorkerStatusStore({
        records: {
          'opk-c12-status-change': {
            sessionId: 'opk-c12-status-change',
            derivedStatus: 'ci_failed',
            status: 'ci_failed',
            generationVector: {
              repoTickGeneration: 10,
              reportStoreGeneration: 10,
              journalCursor: 10,
              bindingCacheGeneration: 10,
            },
            lastUpdatedMs: 1000,
          },
        },
      }),
      binding: { ok: true, prNumber: 12, headSha: 'head12' },
      github: {
        prOpen: true,
        headSha: 'head12',
        reviewRuns: [],
        repoTickGeneration: 5,
        ciChecks: GREEN_MERGE_CONTRACT_CHECKS,
      },
      report: {
        reportState: 'ready_for_review',
        headSha: 'head12',
        accepted: true,
      },
      sourceGeneration: writer,
      nowMs: 2000,
    }) as RecomputeWorkerStatusRowResult;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('monotonic_refused');
    expect(result.store?.records?.['opk-c12-status-change']?.derivedStatus).toBe('ci_failed');
  });
});

describe('worker-status mixed generation vector', () => {
  it('mixed-generation vector triggers reload path (C12b)', () => {
    const existing = {
      sourceGeneration: {
        repoTickGeneration: 10,
        reportStoreGeneration: 5,
        journalCursor: 5,
        bindingCacheGeneration: 5,
      },
    };
    const writer = {
      repoTickGeneration: 5,
      reportStoreGeneration: 10,
      journalCursor: 5,
      bindingCacheGeneration: 5,
    };
    expect(shouldReloadMixedGeneration(existing, writer)).toBe(true);
    expect(shouldRefuseMonotonicWrite(existing, writer)).toBe(false);
    expect(mergeGenerationVectorMax(existing, writer)).toEqual({
      repoTickGeneration: 10,
      reportStoreGeneration: 10,
      journalCursor: 5,
      bindingCacheGeneration: 5,
    });
  });

  it('mixed-generation reload merges vectors and writes the fused row', () => {
    const result = recomputeWorkerStatusRow({
      sessionId: 'opk-c12b',
      store: createDefaultWorkerStatusStore({
        records: {
          'opk-c12b': {
            sessionId: 'opk-c12b',
            status: 'pr_open',
            derivedStatus: 'pr_open',
            generationVector: {
              repoTickGeneration: 10,
              reportStoreGeneration: 5,
              journalCursor: 5,
              bindingCacheGeneration: 5,
            },
            lastUpdatedMs: 1000,
          },
        },
      }),
      binding: { ok: true, prNumber: 12, headSha: 'head12' },
      github: { prOpen: true, headSha: 'head12', reviewRuns: [], repoTickGeneration: 5 },
      sourceGeneration: {
        repoTickGeneration: 5,
        reportStoreGeneration: 10,
        journalCursor: 5,
        bindingCacheGeneration: 5,
      },
      nowMs: 2000,
    }) as RecomputeWorkerStatusRowResult;
    expect(result.ok).toBe(true);
    expect(result.reloadedMixedGeneration).toBe(true);
    expect(result.row?.generationVector).toEqual({
      repoTickGeneration: 10,
      reportStoreGeneration: 10,
      journalCursor: 5,
      bindingCacheGeneration: 5,
    });
    expect(result.store?.records['opk-c12b']?.generationVector?.repoTickGeneration).toBe(10);
  });
});

describe('worker-status concurrent cross-session', () => {
  it('concurrent updates to two different session ids leave both rows present (C13)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-status-c13-'));
    const storePath = join(dir, 'worker-status-store.json');
    try {
      writeFileSync(
        storePath,
        JSON.stringify(createDefaultWorkerStatusStore({ generation: 0, records: {} })),
      );
      const common = {
        binding: { ok: true, prNumber: 13, headSha: 'head13' },
        github: { prOpen: true, headSha: 'head13', reviewRuns: [], repoTickGeneration: 13 },
        osLiveness: 'pane-alive',
        sourceGeneration: { repoTickGeneration: 13, reportStoreGeneration: 1, journalCursor: 0, bindingCacheGeneration: 1 },
        nowMs: 1_700_000_000_000,
      };
      const a = recomputeWorkerStatusRow({ ...common, sessionId: 'session-a', store: readWorkerStatusStoreFile(storePath) }) as RecomputeWorkerStatusRowResult;
      writeWorkerStatusStoreFile(storePath, a.store!);
      const b = recomputeWorkerStatusRow({ ...common, sessionId: 'session-b', store: readWorkerStatusStoreFile(storePath) }) as RecomputeWorkerStatusRowResult;
      writeWorkerStatusStoreFile(storePath, b.store!);
      const finalStore = readWorkerStatusStoreFile(storePath);
      expect(finalStore.records['session-a']).toBeTruthy();
      expect(finalStore.records['session-b']).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('worker-status kill-switch fail-closed', () => {
  it('kill-switch env disables store decisions', () => {
    const result = evaluateWorkerStatusKillSwitch({ PACK_WORKER_STATUS_STORE_DISABLED: '1' });
    expect(result.disabled).toBe(true);
    expect(result.reason).toBe('kill_switch_active');
  });

  it('kill-switch fail-closed returns unknown without daemon composite fallback', () => {
    const merged = mergeWorkerStatusIntoSessions(
      [{ sessionId: 'opk-kill', status: 'needs_input', reports: [] }],
      createDefaultWorkerStatusStore(),
      Date.now(),
    );
    expect(merged[0]?.status).toBe('unknown');
    expect(evaluateWorkerStatusKillSwitch({ PACK_WORKER_STATUS_STORE_DISABLED: '1' }).disabled).toBe(true);
  });
});

describe('ao report removed capture', () => {
  it('capture-backed test documents live unknown command behavior', () => {
    const entry = captureManifest.entries['ao-0-10-cli/report-removed'];
    expect(entry).toBeTruthy();
    const raw = readFileSync(join(repoRoot, 'tests/external-output-references', entry.path), 'utf8');
    expect(raw.toLowerCase()).toContain('unknown command');
    expect(raw.toLowerCase()).toContain('report');
  });
});

describe('ao status reports removed capture', () => {
  it('capture-backed test documents live unknown flag behavior', () => {
    const entry = captureManifest.entries['ao-0-10-cli/status-reports-flag-removed'];
    expect(entry).toBeTruthy();
    const raw = readFileSync(join(repoRoot, 'tests/external-output-references', entry.path), 'utf8');
    expect(raw.toLowerCase()).toContain('unknown');
    expect(raw.toLowerCase()).toContain('reports');
  });
});

describe('worker-status producer-contract cutover guard', () => {
  it('forbids daemon composite decision reads post-cutover', () => {
    expect(() => assertNoDaemonStatusDecisionRead('Get-AoStatusSessionsWithReports')).toThrow(
      /daemon status decision read forbidden/i,
    );
    expect(assertNoDaemonStatusDecisionRead('Get-WorkerStatusDecisionSessions')).toBe(true);
  });
});

describe('worker-status store schema', () => {
  it('rejects unknown schema with empty records fail-closed', () => {
    const store = createDefaultWorkerStatusStore({
      schemaVersion: 999,
      records: {
        opk: { sessionId: 'opk', derivedStatus: 'ready_for_review', status: 'ready_for_review' },
      },
    });
    expect(store.schemaVersion).toBe(WORKER_STATUS_STORE_SCHEMA_VERSION);
    expect(store.schemaRejected).toBe(true);
    expect(Object.keys(store.records)).toHaveLength(0);
    const merged = mergeWorkerStatusIntoSessions(
      [{ sessionId: 'opk', status: 'idle', reports: [] }],
      store,
      Date.now(),
      1,
    );
    expect(merged[0]?.status).toBe('unknown');
    expect(merged[0]?.degradedReason).toBe('unsupported_schema_version');
  });

  it('rejects records when schemaVersion is missing on disk (fail-closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-status-schema-'));
  try {
      const storePath = join(dir, 'worker-status-store.json');
      writeFileSync(storePath, JSON.stringify({
        records: {
          opk: { sessionId: 'opk', derivedStatus: 'ready_for_review', status: 'ready_for_review' },
        },
      }));
      const store = readWorkerStatusStoreFile(storePath);
      expect(store.schemaRejected).toBe(true);
      expect(Object.keys(store.records)).toHaveLength(0);
      const merged = mergeWorkerStatusIntoSessions(
        [{ sessionId: 'opk', status: 'idle', reports: [] }],
        store,
        Date.now(),
        1,
      );
      expect(merged[0]?.status).toBe('unknown');
      expect(merged[0]?.degradedReason).toBe('unsupported_schema_version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readWorkerStatusForDecision returns unknown for missing row', () => {
    const decision = readWorkerStatusForDecision('missing', createDefaultWorkerStatusStore(), Date.now());
    expect(decision.status).toBe('unknown');
    expect(decision.degradedReason).toBe('missing_row');
  });
});



describe('worker-status pack session binding', () => {
  const openPr729 = {
    number: 729,
    headRefOid: 'head729abc',
    headRefName: 'issue-720-worker-status-store',
    state: 'open',
  };
  const issueOnlyRow = {
    id: 'opk-720',
    sessionId: 'opk-720',
    name: 'opk-720',
    role: 'worker',
    issueId: '720',
    status: 'working',
  };

  it('resolves issue-only worker rows through pack session binding (P1)', () => {
    const binding = resolveWorkerStatusSessionBinding({
      session: issueOnlyRow,
      openPrs: [openPr729],
      headSha: 'head729abc',
    });
    expect(binding.ok).toBe(true);
    expect(binding.prNumber).toBe(729);
    expect(binding.headSha).toBe('head729abc');
    expect(binding.bindingSource).toBe('issue_correlation');
  });

  it('marks binding miss when pack resolver cannot attach a PR', () => {
    const binding = resolveWorkerStatusSessionBinding({
      session: issueOnlyRow,
      openPrs: [],
    });
    expect(binding.ok).toBe(false);
    expect(binding.reason).toBeTruthy();
  });
});

describe('worker-status PowerShell bridge', () => {
  it('collects PR numbers from pack report bindings for GitHub snapshot', () => {
    const source = readFileSync(join(import.meta.dirname, 'lib/WorkerStatusStore.ps1'), 'utf8');
    expect(source).toContain('Get-WorkerStatusTrackedPrNumbers');
    expect(source).toContain('$session.reports');
  });

  it('selects newest worker report for fusion', () => {
    const source = readFileSync(join(import.meta.dirname, 'lib/WorkerStatusStore.ps1'), 'utf8');
    expect(source).toContain('$reports[0]');
    expect(source).not.toContain('$reports[$reports.Count - 1]');
  });

  it('fails closed on malformed worker-status store JSON', () => {
    const source = readFileSync(join(import.meta.dirname, 'lib/WorkerStatusStore.ps1'), 'utf8');
    expect(source).toContain('schemaRejected = $true');
    expect(source).toContain('empty_worker_status_store');
  });

  it('feeds real OS liveness into fusion (P2)', () => {
    const source = readFileSync(join(import.meta.dirname, 'lib/WorkerStatusStore.ps1'), 'utf8');
    expect(source).toContain('Get-WorkerOsLiveness');
    expect(source).not.toMatch(/osLiveness\s*=\s*'pane-alive'/);
  });

  it('loads open PR inventory when pack binding resolution is required', () => {
    const source = readFileSync(join(import.meta.dirname, 'lib/WorkerStatusStore.ps1'), 'utf8');
    expect(source).toContain('Test-WorkerStatusSessionsNeedPackBindingResolution');
    expect(source).toContain('Invoke-GhOpenPrList -RepoRoot');
  });

  it('preserves live source generations for writer vector (P1)', () => {
    const store = readFileSync(join(import.meta.dirname, 'lib/WorkerStatusStore.ps1'), 'utf8');
    const reader = readFileSync(join(import.meta.dirname, 'lib/Get-WorkerStatusDecisionSessions.ps1'), 'utf8');
    expect(store).toContain('function Get-WorkerStatusWriterGenerationVector');
    expect(store).toContain('Get-WorkerReportStoreState');
    expect(store).toContain('Get-WorkerMessageDispatchJournal');
    expect(reader).toContain('Get-WorkerStatusWriterGenerationVector');
    expect(reader).not.toMatch(/reportStoreGeneration\s*=\s*0/);
  });
});


describe('worker-status operator report', () => {
  it('uses read-only projection without store writes', () => {
    const report = readFileSync(join(import.meta.dirname, 'show-worker-status-report.ps1'), 'utf8');
    const reader = readFileSync(join(import.meta.dirname, 'lib/Get-WorkerStatusDecisionSessions.ps1'), 'utf8');
    expect(report).toContain('Get-WorkerStatusReadOnlyProjection');
    expect(report).not.toContain('Get-WorkerStatusDecisionSessions');
    expect(reader).toContain('function Get-WorkerStatusReadOnlyProjection');
    expect(reader).toContain('Merge-AoSessionRowsWithWorkerStatusStore');
    expect(reader.split('function Get-WorkerStatusReadOnlyProjection')[1].split('function Get-WorkerStatusDecisionSessions')[0]).not.toContain('Write-WorkerStatusRow');
  });

  it('computes freshness age from workerStatusLastUpdatedMs', () => {
    const report = readFileSync(join(import.meta.dirname, 'show-worker-status-report.ps1'), 'utf8');
    expect(report).toContain('workerStatusLastUpdatedMs');
    expect(report).not.toContain('workerStatusFreshnessMs');
    expect(report).toContain('[long]$session.workerStatusLastUpdatedMs');
    expect(report).not.toContain('[int]$session.workerStatusLastUpdatedMs');
  });
});

describe('worker-status sibling readiness', () => {
  it('reports ready when docs sibling modules are present', () => {
    const result = testSiblingReadiness({});
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.workerReportStorePresent).toBe(true);
    expect(result.sessionPrBindingResolverPresent).toBe(true);
  });

  it('fails closed when worker-report-store missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-status-sibling-'));
    try {
      const result = testSiblingReadiness({
        ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: dir,
      });
      expect(result.ready).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
