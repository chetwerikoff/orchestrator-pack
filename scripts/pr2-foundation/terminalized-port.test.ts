import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NONTERMINAL_MAX_AGE_MS,
  WORKER_REPORT_STORE_SCHEMA_VERSION,
  evictWorkerReportRecords,
  listWorkerReportRecordsForAssignment,
  normalizeWorkerReportStore,
} from '../../docs/worker-report-store.mjs';
import { evaluateReadiness, NOT_READY } from './readiness-evaluator.ts';
import {
  evaluatePostSmokeReadiness,
  projectPostSmokePackReview,
  type CliOptions,
  type ResolvedSmokeTarget,
} from '../worker-smoke-run.ts';
import {
  commitPackReviewTerminal,
  initializePackReviewAuthority,
  observePackReviewHead,
  recordPackReviewPublication,
  type PackReviewAuthorityOptions,
} from '../pack-review-state.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import {
  FOUNDATION_DOC_ROWS,
  FOUNDATION_LINT_SUPPRESSION_CONFIG_PATH,
} from './contracts.ts';

const runtimeSources = FOUNDATION_DOC_ROWS.filter((file) => !file.endsWith('.d.mts'));
const runtimeNeutralFoundationSources = new Set([
  'docs/review-bulk-send-diagnose.mjs',
  'docs/worker-report-store.mjs',
]);

function targetFor(source: string): string {
  const basename = path.posix.basename(source)
    .replace(/\.d\.mts$/, '.d.ts')
    .replace(/\.mjs$/, '.ts');
  return path.posix.join('scripts', 'pr2-foundation', 'terminalized', basename);
}

describe('[AC7] terminalized executable docs TypeScript ports', () => {
  it('preserves the surviving foundation rows without restoring the retired AO API owner', () => {
    for (const source of FOUNDATION_DOC_ROWS) {
      expect(existsSync(path.resolve(source)), source).toBe(true);
      const text = readFileSync(path.resolve(source), 'utf8');
      if (runtimeNeutralFoundationSources.has(source)) {
        if (source === 'docs/review-bulk-send-diagnose.mjs') {
          expect(text, source).toContain('The pack review producer/store is the only active authority.');
          expect(text, source).not.toContain('ao-0-10-review-api');
        } else {
          expect(text, source).toContain('export const WORKER_REPORT_STORE_SCHEMA_VERSION = 3;');
          expect(text, source).toContain('OPK_WORKER_REPORT_STORE');
          expect(text, source).not.toContain('AO_' + 'WORKER_REPORT_STORE');
        }
      } else {
        expect(text, source).toMatch(/^\/\/ Issue #923 foundation-terminalized:/);
      }
    }
    for (const source of runtimeSources) {
      const target = targetFor(source);
      expect(existsSync(path.resolve(target)), target).toBe(true);
      const text = readFileSync(path.resolve(target), 'utf8');
      if (source === 'docs/review-bulk-send-diagnose.mjs') {
        expect(text, target).toContain('The pack review producer/store is the only active authority.');
        expect(text, target).not.toContain('ao-0-10-review-api');
      } else {
        expect(text, target).toContain(`Ported from ${source} blob `);
      }
      expect(text, target).not.toContain(`from './${path.basename(source)}'`);
    }
    const declarationTarget = path.resolve(
      'scripts/pr2-foundation/terminalized/events-optional-consumer-signal-recovery.d.ts',
    );
    expect(existsSync(declarationTarget)).toBe(true);
    expect(readFileSync(declarationTarget, 'utf8')).toContain(
      'Ported from docs/events-optional-consumer-signal-recovery.d.mts blob ',
    );
  });

  it('limits duplicate-literal suppressions to fifteen Issue #923 pairs and one Issue #948 pair', () => {
    const config = JSON.parse(readFileSync(
      path.resolve(FOUNDATION_LINT_SUPPRESSION_CONFIG_PATH),
      'utf8',
    )) as {
      excludePaths: string[];
      suppressions: Array<{ rule: string; files: string[]; reason: string }>;
      [key: string]: unknown;
    };
    const issue923Reason = 'Issue #923 migration parity until draft 315; remove at cutover';
    const issue948Reason = 'Issue #948 owner-mechanism manifest intentionally mirrors canonical catalog coverage for mechanical cross-checking';
    const duplicateSuppressions = config.suppressions
      .filter((suppression) => suppression.rule === 'duplicate-literal');
    const issue923Suppressions = duplicateSuppressions
      .filter((suppression) => suppression.reason === issue923Reason);
    const issue948Suppressions = duplicateSuppressions
      .filter((suppression) => suppression.reason === issue948Reason);
    const unexpectedSuppressions = duplicateSuppressions
      .filter((suppression) => suppression.reason !== issue923Reason && suppression.reason !== issue948Reason);
    const expected923Pairs = FOUNDATION_DOC_ROWS
      .map((source) => [source, targetFor(source)].join('|'))
      .sort();
    const actual923Pairs = issue923Suppressions
      .map((suppression) => suppression.files.join('|'))
      .sort();

    expect(FOUNDATION_DOC_ROWS).toHaveLength(15);
    expect(config.suppressions).toHaveLength(duplicateSuppressions.length);
    expect(duplicateSuppressions).toHaveLength(16);
    expect(issue923Suppressions).toHaveLength(15);
    expect(actual923Pairs).toEqual(expected923Pairs);
    expect(issue948Suppressions).toHaveLength(1);
    expect([...issue948Suppressions[0].files].sort()).toEqual([
      'scripts/orchestrator-message-catalog.json',
      'scripts/orchestrator-message-owner-mechanisms.manifest.json',
    ].sort());
    expect(unexpectedSuppressions).toEqual([]);
    for (const suppression of duplicateSuppressions) {
      expect(suppression.files).toHaveLength(2);
      const hasWildcard = suppression.files.some((file) =>
        file.includes('*') || file.includes('?') || file.includes('['));
      expect(hasWildcard, suppression.files.join(' | ')).toBe(false);
    }
  });

  it('keeps cutover bytes untouched and leaves no temporary workflow in the final tree', () => {
    const cutoverSource = readFileSync(path.resolve('scripts/reaction-config-messages.mjs'), 'utf8');
    expect(cutoverSource).toContain("from '../docs/worker-message-dispatch-observe.mjs'");
    expect(cutoverSource).not.toContain('scripts/pr2-foundation/terminalized');
    for (const workflow of [
      '.github/workflows/issue-923-scope-type-diagnostic.yml',
      '.github/workflows/issue-923-final-cleanup-helper.yml',
      '.github/workflows/issue-923-final-diagnostics.yml',
      '.github/workflows/issue-923-regression-diagnostics.yml',
    ]) {
      expect(existsSync(path.resolve(workflow)), workflow).toBe(false);
    }
  });

  it('keeps the worker-report PowerShell edge byte-compatible and the TypeScript authority dormant', () => {
    const wrapper = readFileSync(path.resolve('scripts/lib/WorkerReportStore.ps1'), 'utf8');
    expect(wrapper).toContain("'docs/worker-report-store.mjs'");
    expect(wrapper).toContain(
      'Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:WorkerReportStoreCli',
    );
    expect(wrapper).not.toContain('scripts/lib/Invoke-TypeScriptCli.ts');
    expect(wrapper).not.toContain("'--experimental-strip-types'");
    expect(wrapper).not.toContain('Write-MechanicalTransportPrivateFile');
    expect(existsSync(path.resolve(
      'scripts/pr2-foundation/terminalized/worker-report-store.ts',
    ))).toBe(true);
  });

  it('keeps live sibling readiness byte-compatible and the TypeScript port dormant', () => {
    const source = readFileSync(path.resolve('scripts/lib/worker-status-store.mjs'), 'utf8');
    expect(source).toContain('workerReportStorePresent = reportStorePath');
    expect(source).toContain("existsSync(join(docsDir, 'worker-report-store.mjs'))");
    expect(source).not.toContain("join(packRoot, 'scripts', 'pr2-foundation', 'terminalized'");
    expect(source).not.toContain('worker-report-store.ts');
    expect(existsSync(path.resolve(
      'scripts/pr2-foundation/terminalized/worker-report-store.ts',
    ))).toBe(true);
  });

  it('binds #1419 exact-head post-port proof into the required TypeScript runtime context', () => {
    const workflow = readFileSync(path.resolve('.github/workflows/typescript-foundation.yml'), 'utf8');
    const runtimeStart = workflow.indexOf('  runtime:');
    const typecheckStart = workflow.indexOf('  typecheck:', runtimeStart);
    expect(runtimeStart).toBeGreaterThanOrEqual(0);
    expect(typecheckStart).toBeGreaterThan(runtimeStart);
    const runtimeJob = workflow.slice(runtimeStart, typecheckStart);
    expect(runtimeJob).toContain('name: TypeScript runtime (Node 22)');
    expect(runtimeJob).toContain('Produce and admit exact-head post-port evidence');
    expect(runtimeJob).toContain('Upload exact-head post-port evidence');
    expect(runtimeJob).toContain('working-directory: post-port-exact-head');
    expect(runtimeJob).toContain('name: post-port-${{ github.event.pull_request.head.sha }}');
    expect(runtimeJob).toContain('post-port-exact-head/docs/investigations/orca-pwsh-zero-estate/post-port.json');
    expect(runtimeJob).toContain('if-no-files-found: error');
    expect(workflow).not.toContain('\n  post-port-proof:\n');
  });

  it('wires #1419 direct review reconciliation and readiness after an exact-head smoke PASS', () => {
    const source = readFileSync(path.resolve('scripts/worker-smoke-run.ts'), 'utf8');
    expect(source).toContain("case 'reconcile-direct-review': return runDirectReviewReconciliation(options);");
    expect(source).toContain('projectDirectPackReviewState({');
    expect(source).toContain('semanticPackReviewRequiredStatusRequest({');
    expect(source).toContain("reason: 'ancestor_blocker_requires_descendant_fix_facts'");
    const deliverySource = readFileSync(path.resolve('scripts/lib/pack-review-delivery.ts'), 'utf8');
    expect(deliverySource).toContain("description === 'pack review completed with no findings.'");
    expect(deliverySource).toContain('projectRunnerPackReviewStatusFromCombined');
    expect(source).toContain("['api', '--paginate', '--slurp', endpoint]");
    expect(source).toContain('/statuses?per_page=100');
    expect(source).not.toContain('/commits/${headSha}/status`');
    expect(source).toContain('open: target.prOpen');
    expect(source).toContain('expectedTarget: target.expectedTarget');
    expect(source).toContain('evaluateReadiness({');
    const terminalPass = source.indexOf("if (!lifecycleCleanup.clean && report.result === 'PASS') report.result = 'FAIL';");
    const postSmokeCall = source.indexOf('evaluatePostSmokeReadiness(options, target, adapter)', terminalPass);
    expect(terminalPass).toBeGreaterThanOrEqual(0);
    expect(postSmokeCall).toBeGreaterThan(terminalPass);

    expect(existsSync(path.resolve('scripts/direct-pack-review-status.ts'))).toBe(true);
    const workflow = readFileSync(path.resolve('.github/workflows/direct-pack-review-status.yml'), 'utf8');
    expect(workflow).toContain('pull_request_review:');
    expect(workflow).toContain('types: [submitted]');
    expect(workflow).toContain('scripts/direct-pack-review-status.ts');
    expect(workflow).toContain('--repo-slug "${{ github.repository }}"');
    expect(workflow).not.toContain('worker-smoke-run.ts reconcile-direct-review');
    expect(workflow).toContain('statuses: write');
  });

  it('fails readiness for an aged same-head WorkerReport using the WorkerReportStore freshness authority', () => {
    const repository = 'chetwerikoff/orchestrator-pack';
    const headSha = 'a'.repeat(40);
    const prNumber = 1709;
    const assignment = { assignmentId: 'assignment-1419', generation: 3, taskId: 'task-1419' } as const;
    const store = normalizeWorkerReportStore({
      schemaVersion: WORKER_REPORT_STORE_SCHEMA_VERSION,
      sourceRecords: {
        stale: {
          accepted: true,
          repoSlug: repository,
          assignment,
          prNumber,
          headSha,
          reportState: 'ready_for_review',
          reportedAtMs: 1,
          lastObservedMs: 1,
        },
      },
    });
    const eviction = evictWorkerReportRecords({
      store,
      openPrs: [{ number: prNumber, state: 'open', repoSlug: repository }],
      currentHeadByPr: { [`${repository}|${prNumber}`]: headSha },
      nowMs: DEFAULT_NONTERMINAL_MAX_AGE_MS + 2,
      repoSlug: repository,
    });
    expect(eviction.removed).toBe(1);

    const workerReports = listWorkerReportRecordsForAssignment(store, repository, assignment);
    expect(workerReports).toEqual([]);
    const result = evaluateReadiness({
      target: {
        repository,
        issueNumber: 1419,
        taskId: assignment.taskId,
        assignmentId: assignment.assignmentId,
        assignmentGeneration: assignment.generation,
        prNumber,
        headSha,
      },
      pr: { open: true, expectedTarget: true, prNumber, headSha },
      workerReports,
      workerStatuses: [{
        assignmentId: assignment.assignmentId,
        assignmentGeneration: assignment.generation,
        taskId: assignment.taskId,
        issueNumber: 1419,
        repository,
        kind: 'local',
        localCapability: 'available',
        derivedStatus: 'idle',
        winningSource: 'runtime',
        stale: false,
        degradedReason: '',
        killSwitchActive: false,
        siblingReadinessOk: true,
      }],
      requiredCi: { headSha, state: 'success' },
      review: {
        obligation: 'complete',
        unresolvedRequiredFinding: false,
        atCapOpenFindings: false,
        atCapContinuationRequired: false,
      },
      smoke: { headSha, state: 'pass' },
    });
    expect(result.state).toBe(NOT_READY);
    expect(result.failedPredicates).toContain('accepted_worker_lifecycle_missing_or_conflicting');

    const source = readFileSync(path.resolve('scripts/worker-smoke-run.ts'), 'utf8');
    const evictionCall = source.indexOf('evictWorkerReportRecords({');
    const reportListing = source.indexOf('listWorkerReportRecordsForAssignment(reportStore');
    expect(evictionCall).toBeGreaterThanOrEqual(0);
    expect(reportListing).toBeGreaterThan(evictionCall);
  });

  it('rewrites actual imports without rewriting string-based consumer inventories', () => {
    const source = readFileSync(path.resolve('scripts/session-pr-binding-resolver.test.ts'), 'utf8');
    expect(source).toContain(
      "} from './pr2-foundation/terminalized/review-trigger-reconcile.ts';",
    );
    expect(source).toContain("'docs/review-trigger-reconcile.mjs',");
    expect(source).toContain("'docs/review-finding-delivery-confirm.mjs',");
    expect(source).toContain("'docs/review-wake-trigger.mjs',");
  });
});


describe('Issue #1867 completed pack-review post-smoke projection', () => {
  const logicalComplete = {
    cycleId: 'cycle-1867',
    capMapVersion: 'issue-1826-logical-rounds-1-1-2',
    reviewStageComplete: true,
  } as const;
  const missingRunner = {
    hasLegitimateReview: false,
    unresolvedBlockingFinding: false,
  } as const;

  it('keeps completed-stage status successful for proven ancestor blockers', () => {
    const result = projectPostSmokePackReview({
      authorityCycle: logicalComplete,
      runner: {
        hasLegitimateReview: true,
        unresolvedBlockingFinding: true,
      },
      direct: {
        hasLegitimateReview: true,
        state: 'blocked',
        unresolvedBlockingReviewIds: [101],
        unresolvedCurrentHeadBlockingReviewIds: [],
        unresolvedAncestorBlockingReviewIds: [101],
      },
    });

    expect(result).toMatchObject({
      reviewProjection: {
        state: 'success',
        reason: 'clear',
        description: 'Required pack-review stage completed; no additional review round required.',
      },
      unresolvedRequiredFinding: false,
      completedLogicalCycleId: 'cycle-1867',
    });
  });

  it('uses completion authority when the later head has no direct-review artifact', () => {
    const result = projectPostSmokePackReview({
      authorityCycle: logicalComplete,
      runner: missingRunner,
      direct: {
        hasLegitimateReview: false,
        state: 'missing-review',
        unresolvedBlockingReviewIds: [],
        unresolvedCurrentHeadBlockingReviewIds: [],
        unresolvedAncestorBlockingReviewIds: [],
      },
    });

    expect(result.reviewProjection.state).toBe('success');
    expect(result.unresolvedRequiredFinding).toBe(false);
    expect(result.completedLogicalCycleId).toBe('cycle-1867');
  });

  it('keeps an exact-current-head blocker material only for readiness', () => {
    const result = projectPostSmokePackReview({
      authorityCycle: logicalComplete,
      runner: missingRunner,
      direct: {
        hasLegitimateReview: true,
        state: 'blocked',
        unresolvedBlockingReviewIds: [202],
        unresolvedCurrentHeadBlockingReviewIds: [202],
        unresolvedAncestorBlockingReviewIds: [],
      },
    });

    expect(result.reviewProjection.state).toBe('success');
    expect(result.unresolvedRequiredFinding).toBe(true);
  });

  it('keeps an unknown-lineage blocker material for readiness', () => {
    const result = projectPostSmokePackReview({
      authorityCycle: logicalComplete,
      runner: missingRunner,
      direct: {
        hasLegitimateReview: true,
        state: 'blocked',
        unresolvedBlockingReviewIds: ['unknown-303'],
        unresolvedCurrentHeadBlockingReviewIds: [],
        unresolvedAncestorBlockingReviewIds: [],
      },
    });

    expect(result.reviewProjection.state).toBe('success');
    expect(result.unresolvedRequiredFinding).toBe(true);
  });

  it('does not activate the override for a legacy completed cycle', () => {
    const result = projectPostSmokePackReview({
      authorityCycle: {
        cycleId: 'legacy-cycle',
        capMapVersion: 'legacy-frozen',
        reviewStageComplete: true,
      },
      runner: missingRunner,
      direct: {
        hasLegitimateReview: true,
        state: 'blocked',
        unresolvedBlockingReviewIds: [404],
        unresolvedCurrentHeadBlockingReviewIds: [],
        unresolvedAncestorBlockingReviewIds: [404],
      },
    });

    expect(result.reviewProjection).toMatchObject({
      state: 'failure',
      reason: 'unresolved-blocker',
    });
    expect(result.unresolvedRequiredFinding).toBe(true);
    expect(result.completedLogicalCycleId).toBeNull();
  });

  it('does not activate the override before logical stage completion', () => {
    const result = projectPostSmokePackReview({
      authorityCycle: {
        ...logicalComplete,
        reviewStageComplete: false,
      },
      runner: missingRunner,
      direct: {
        hasLegitimateReview: true,
        state: 'blocked',
        unresolvedBlockingReviewIds: [505],
        unresolvedCurrentHeadBlockingReviewIds: [],
        unresolvedAncestorBlockingReviewIds: [505],
      },
    });

    expect(result.reviewProjection.state).toBe('failure');
    expect(result.unresolvedRequiredFinding).toBe(true);
    expect(result.completedLogicalCycleId).toBeNull();
  });

  it('preserves existing fallback behavior when authority is unavailable', () => {
    const result = projectPostSmokePackReview({
      authorityCycle: null,
      runner: missingRunner,
      direct: {
        hasLegitimateReview: false,
        state: 'missing-review',
        unresolvedBlockingReviewIds: [],
        unresolvedCurrentHeadBlockingReviewIds: [],
        unresolvedAncestorBlockingReviewIds: [],
      },
    });

    expect(result.reviewProjection).toMatchObject({
      state: 'failure',
      reason: 'missing-review',
    });
    expect(result.unresolvedRequiredFinding).toBe(false);
    expect(result.completedLogicalCycleId).toBeNull();
  });
});


describe('Issue #1867 post-smoke readiness wiring regression', () => {
  const repository = 'chetwerikoff/orchestrator-pack';
  const issueNumber = 1867;
  const prNumber = 1874;
  const reviewedHead = 'a'.repeat(40);
  const currentHead = 'b'.repeat(40);

  function completeLogicalStage(storeRoot: string): void {
    const options: PackReviewAuthorityOptions = { storeRoot };
    const authority = initializePackReviewAuthority({
      prNumber,
      headSha: reviewedHead,
      tier: 'T2',
      options,
    });
    const terminal = commitPackReviewTerminal({
      prNumber,
      expectedTransitionSeq: authority.transitionSeq,
      terminal: {
        schemaVersion: 1,
        terminalContractVersion: 2,
        terminalSource: 'normal',
        runId: 'review-run-1867',
        targetSha: reviewedHead,
        logicalRoundOrdinal: 1,
        reviewVerdict: 'clean',
        findingCount: 0,
        findingsDigest: 'clean-findings-digest',
      },
      status: 'up_to_date',
      findingCount: 0,
      options,
    });
    const published = recordPackReviewPublication({
      prNumber,
      expectedTransitionSeq: terminal.transitionSeq,
      publication: {
        headSha: reviewedHead,
        terminalRunId: 'review-run-1867',
        status: 'succeeded',
        publicationDigest: 'publication-digest',
        recordedAtUtc: new Date().toISOString(),
      },
      options,
    });
    expect(published.cycle?.reviewStageComplete).toBe(true);
    const advanced = observePackReviewHead({
      prNumber,
      expectedTransitionSeq: published.transitionSeq,
      headSha: currentHead,
      options,
    });
    expect(advanced.cycle?.reviewStageComplete).toBe(true);
  }

  function cliOptions(): CliOptions {
    return {
      command: '',
      issueNumber,
      prNumber,
      headSha: currentHead,
      issueBodyFile: '',
      smokeComplexity: '',
      repoRoot: process.cwd(),
      cwd: process.cwd(),
      dryRun: false,
      json: false,
      reviewId: '',
      reviewHeadSha: '',
    };
  }

  function target(): ResolvedSmokeTarget {
    return {
      repositorySlug: repository,
      issueNumber,
      prNumber,
      headSha: currentHead,
      issueBody: '',
      issueBodyMatchesTarget: true,
      trustedPublisherLogin: 'chetwerikoff',
      prOpen: true,
      baseRef: 'main',
      expectedTargetRef: 'main',
      expectedTarget: true,
    };
  }

  function blockingReview(headSha: string, id: number) {
    return [{
      id,
      state: 'COMMENTED',
      user: { login: 'chetwerikoff' },
      submitted_at: '2026-08-31T00:00:00.000Z',
      body: `<!-- opk-pack-review:v1 head=${headSha} verdict=findings blocking=true -->`,
      commit_id: headSha,
      html_url: `https://github.com/chetwerikoff/orchestrator-pack/pull/1874#pullrequestreview-${id}`,
    }];
  }

  it('covers the real post-smoke status/readiness path for stale and material blockers', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'opk-1867-post-smoke-readiness-'));
    const previousEnv = {
      OPK_BASE_DIR: process.env.OPK_BASE_DIR,
      OPK_VITEST_HARNESS: process.env.OPK_VITEST_HARNESS,
      OPK_WORKER_REPORT_STORE: process.env.OPK_WORKER_REPORT_STORE,
      PACK_REVIEW_RUN_STORE_ROOT: process.env.PACK_REVIEW_RUN_STORE_ROOT,
      PACK_REVIEW_GITHUB_REVIEWS_FIXTURE: process.env.PACK_REVIEW_GITHUB_REVIEWS_FIXTURE,
      PACK_REVIEW_REQUIRED_STATUS_CAPTURE_FILE: process.env.PACK_REVIEW_REQUIRED_STATUS_CAPTURE_FILE,
    };
    try {
      process.env.OPK_BASE_DIR = root;
      process.env.OPK_VITEST_HARNESS = '1';
      process.env.OPK_WORKER_REPORT_STORE = path.join(root, 'worker-report-store.json');
      process.env.PACK_REVIEW_RUN_STORE_ROOT = path.join(root, 'review-store');
      completeLogicalStage(process.env.PACK_REVIEW_RUN_STORE_ROOT);

      const scenarios = [
        {
          name: 'proven-ancestor',
          reviewHead: reviewedHead,
          reviewId: 186701,
          lineage: 'ancestor',
          blocked: false,
        },
        {
          name: 'exact-current-head',
          reviewHead: currentHead,
          reviewId: 186702,
          lineage: 'current',
          blocked: true,
        },
        {
          name: 'unknown-lineage',
          reviewHead: reviewedHead,
          reviewId: 186703,
          lineage: 'unknown',
          blocked: true,
        },
      ] as const;

      for (const scenario of scenarios) {
        const captureFile = path.join(root, `${scenario.name}-required-status.json`);
        process.env.PACK_REVIEW_REQUIRED_STATUS_CAPTURE_FILE = captureFile;
        process.env.PACK_REVIEW_GITHUB_REVIEWS_FIXTURE = JSON.stringify(
          blockingReview(scenario.reviewHead, scenario.reviewId),
        );

        const result = await evaluatePostSmokeReadiness(
          cliOptions(),
          target(),
          {} as RuntimeAdapter,
          {
            resolveCiGreen: () => true,
            currentPackReviewStatusFact: () => ({
              hasLegitimateReview: false,
              unresolvedBlockingFinding: false,
            }),
            isAncestor: (_repositorySlug, ancestorSha, descendantSha) => {
              if (scenario.lineage === 'unknown') throw new Error('fixture lineage unavailable');
              return ancestorSha === reviewedHead && descendantSha === currentHead;
            },
          },
        );

        expect(result.reviewProjection).toMatchObject({
          state: 'success',
          reason: 'clear',
          description: 'Required pack-review stage completed; no additional review round required.',
        });
        const captured = JSON.parse(readFileSync(captureFile, 'utf8')) as Record<string, unknown>;
        expect(captured).toMatchObject({
          repoSlug: repository,
          headSha: currentHead,
          state: 'success',
          context: 'orchestrator-pack/pack-review',
          description: 'Required pack-review stage completed; no additional review round required.',
        });
        expect(result.readiness.failedPredicates.includes('unresolved_required_review_finding'))
          .toBe(scenario.blocked);
      }
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
