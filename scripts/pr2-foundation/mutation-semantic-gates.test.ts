import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProcessIdentity } from '../lib/cutover/activation-cordon.ts';
import { appendPhaseOne, readPhaseOneDetail, verifyPhaseOneDetails } from '../lib/cutover/activation-evidence.ts';
import {
  observeSchedulerHealthAndDelivery,
  productionRecoveryBoundary,
} from '../lib/cutover/activation-recovery.ts';
import {
  candidateLegacyReferenceRows,
  isExecutableLegacyReference,
} from '../lib/cutover/activation-transaction.ts';
import type { ActivationRequest, EpochCommitCore } from '../lib/cutover/types.ts';
import {
  createPackReviewRun,
  initializePackReviewRunStore,
  updatePackReviewRun,
} from '../lib/pack-review-run-store.ts';
import { AC_MUTATION_CONTROLS } from './contracts.ts';
import {
  MUTATION_BEHAVIOR_PROBE_KEYS,
} from './mutation-behavior-probes.ts';
import {
  buildBehavioralMutation,
  EXECUTABLE_BEHAVIOR_MUTATION_KEYS,
} from './mutation-behavior-recipes.ts';
import { FOUNDATION_MUTATION_CATALOG } from './mutation-catalog.ts';

const ISSUE_928_CUTOVER_MARKERS = Object.freeze([
  'scripts/cutover/mutation-runner.ts',
  'scripts/orchestrator-cutover-activate.ts',
  'scripts/pr2a/final-conformance-precutover.ts',
]);
const TERMINALIZED_FOUNDATION_MUTATION_KEY = 'AC9:registry-or-supervisor-modified';
const repoRoot = path.resolve(process.cwd());

function issue928CutoverPresent(): boolean {
  return ISSUE_928_CUTOVER_MARKERS.every((file) => existsSync(path.resolve(file)));
}

function mutationKeys(): string[] {
  return Object.entries(AC_MUTATION_CONTROLS).flatMap(([ac, ids]) =>
    ids.map((mutationId) => `${ac}:${mutationId}`),
  );
}

const importsMutationRecipes = /(?:from\s+|import\s*\(\s*)['"]\.\/mutation-behavior-recipes\.ts['"]/u;
const importsSemanticGates = /(?:from\s+|import\s*\(\s*)['"]\.\/mutation-semantic-gates\.ts['"]/u;

describe('[AC8] independent behavioral mutation probes', () => {
  it('binds every declared control to an explicit behavioral mutation without semantic-gate fallback', () => {
    const expected = mutationKeys().sort();
    expect([...EXECUTABLE_BEHAVIOR_MUTATION_KEYS]).toEqual(expected);

    const recipes = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-recipes.ts'), 'utf8');
    expect(recipes).not.toMatch(importsSemanticGates);
    expect(recipes).not.toContain('buildBoundedSemanticMutation');
    expect(recipes).not.toContain('GATES[');
    expect(recipes).toContain("from './mutation-catalog.ts'");
    expect(recipes).toContain('behavioral_mutation_recipe_set_mismatch');
  });

  it('builds a bounded non-empty mutation plan for every live declared control and terminalizes only the #928-owned legacy supervisor control', () => {
    const terminalized: string[] = [];
    const cutoverPresent = issue928CutoverPresent();
    for (const [ac, ids] of Object.entries(AC_MUTATION_CONTROLS)) {
      for (const mutationId of ids) {
        const key = `${ac}:${mutationId}`;
        const bindingPath = FOUNDATION_MUTATION_CATALOG
          .find((entry) => `${entry.ac}:${entry.mutationId}` === key)?.artifactPath;
        expect(bindingPath, key).toBeTruthy();
        const absolute = path.resolve(bindingPath!);
        const source = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
        if (source === null && cutoverPresent && key === TERMINALIZED_FOUNDATION_MUTATION_KEY) {
          terminalized.push(key);
          continue;
        }
        const plan = buildBehavioralMutation(key, source);
        expect(plan.artifactPath, key).toBe(bindingPath);
        expect(plan.affectedOccurrences, key).toBeGreaterThan(0);
        expect(plan.content, key).not.toBe(source);
      }
    }
    expect(terminalized).toEqual(cutoverPresent ? [TERMINALIZED_FOUNDATION_MUTATION_KEY] : []);
  });

  it('binds the full control set to a checker authority independent from mutation recipes', () => {
    const expected = mutationKeys().sort();
    expect([...MUTATION_BEHAVIOR_PROBE_KEYS]).toEqual(expected);

    const checker = readFileSync(path.resolve('scripts/pr2-foundation/mutation-semantic-check.ts'), 'utf8');
    const probes = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-probes.ts'), 'utf8');
    const fixtures = readFileSync(path.resolve('scripts/pr2-foundation/mutation-behavior-fixtures.ts'), 'utf8');
    const runner = readFileSync(path.resolve('scripts/pr2-foundation/mutation-runner.ts'), 'utf8');

    expect(checker).toContain("await import('./mutation-behavior-probes.ts')");
    expect(checker).not.toMatch(importsSemanticGates);
    expect(probes).not.toMatch(importsMutationRecipes);
    expect(fixtures).not.toMatch(importsMutationRecipes);
    expect(fixtures).not.toMatch(importsSemanticGates);
    expect(runner).toContain("from './mutation-behavior-recipes.ts'");
  });

  it('uses executable behavioral mutants for the reviewer examples', () => {
    expect(EXECUTABLE_BEHAVIOR_MUTATION_KEYS).toEqual(expect.arrayContaining([
      'AC1:scheduler-acquirer-running',
      'AC1:activation-epoch-enforced',
      'AC2:draft-candidate-accepted',
      'AC2:missing-draft-bit-accepted',
      'AC3:invalid-config-accepted',
      'AC4:duplicate-send-unaccounted',
      'AC9:modification-outside-independent-union',
      'AC9:declaration-snapshot-missing',
      'AC9:declaration-created-after-implementation',
    ]));

    const scheduler = readFileSync(path.resolve('scripts/pr2-foundation/scheduler.ts'), 'utf8');
    const schedulerMutant = buildBehavioralMutation('AC1:scheduler-acquirer-running', scheduler);
    expect(schedulerMutant.content).toContain('running: true');

    const binding = readFileSync(path.resolve('scripts/pr2-foundation/binding.ts'), 'utf8');
    const draftMutant = buildBehavioralMutation('AC2:draft-candidate-accepted', binding);
    expect(draftMutant.content).not.toContain('!row.isDraft &&');

    const config = readFileSync(path.resolve('scripts/pr2-foundation/config.ts'), 'utf8');
    const invalidConfigMutant = buildBehavioralMutation('AC3:invalid-config-accepted', config);
    expect(invalidConfigMutant.content).toContain('return { ok: true, config: DEFAULT_FOUNDATION_CONFIG };');

    const notification = readFileSync(path.resolve('scripts/pr2-foundation/worker-notification.ts'), 'utf8');
    const duplicateMutant = buildBehavioralMutation('AC4:duplicate-send-unaccounted', notification);
    expect(duplicateMutant.affectedOccurrences).toBe(2);
    expect(duplicateMutant.content).not.toContain(
      "if (inspected.duplicate) return { state: 'delivered', reason: 'journal_duplicate_no_op' };",
    );

    const scopeProof = readFileSync(path.resolve('scripts/pr2-foundation/real-scope-proof.ts'), 'utf8');
    const outsideUnionMutant = buildBehavioralMutation(
      'AC9:modification-outside-independent-union',
      scopeProof,
    );
    expect(outsideUnionMutant.content).toContain("'README.md'");
  });
});

describe('[Issue #928] durable phase-one detail evidence', () => {
  it('persists canonical detail preimages and refuses a tampered sidecar', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'opk-928-phase-detail-'));
    try {
      const phaseOnePath = path.join(root, 'phase-one.json');
      const detail = { writerWatermark: 'drained-watermark', writers: [{ childId: 'legacy-writer', pid: 42 }] };
      appendPhaseOne(phaseOnePath, 'epoch-test', 'nonce-test', 'writer-drain', detail);
      expect(readPhaseOneDetail(phaseOnePath, 'epoch-test', 'nonce-test', 'writer-drain')).toEqual(detail);
      const sidecar = path.join(`${phaseOnePath}.details`, '0001.json');
      expect(existsSync(sidecar)).toBe(true);
      writeFileSync(sidecar, '{"writerWatermark":"tampered","writers":[]}\n', 'utf8');
      expect(() => verifyPhaseOneDetails(phaseOnePath, 'epoch-test', 'nonce-test')).toThrow(/phase_one_detail_digest_mismatch:writer-drain/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds pre-CAS recovery to persisted snapshot evidence and raw snapshot digests', () => {
    const recovery = readFileSync(path.resolve('scripts/lib/cutover/activation-recovery.ts'), 'utf8');
    expect(recovery).toContain("readPhaseOneDetail(request.paths.phaseOnePath, request.epochId, nonce, 'snapshots')");
    expect(recovery).toContain("throw new Error(`precas_snapshot_digest_mismatch:${spec.id}`)");
    expect(recovery).toContain('verifyPhaseOneDetails(request.paths.phaseOnePath, request.epochId, nonce);');
  });

  it('classifies an executable target-library edge from an otherwise-unlisted candidate source', () => {
    const rows = candidateLegacyReferenceRows(
      [
        "deadbeef:scripts/unlisted-cutover-consumer.ts:1:import '../lib/Review-StartClaim.ps1';",
        "deadbeef:docs/historical-note.md:1:const historicalName = 'Review-StartClaim.ps1';",
      ].join('\n'),
      [
        { path: 'scripts/unlisted-cutover-consumer.ts', executionClass: 'reachable-helper' },
        { path: 'docs/historical-note.md', executionClass: 'dead' },
      ],
    );
    expect(rows.filter(isExecutableLegacyReference).map((row) => row.source)).toEqual([
      'scripts/unlisted-cutover-consumer.ts',
    ]);
  });

  it('reuses a live waiting-restart supervisor instead of detaching a second owner', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'opk-928-supervisor-recovery-'));
    try {
      const stateDir = path.join(root, 'supervisor');
      mkdirSync(stateDir, { recursive: true });
      const identity = readProcessIdentity(process.pid);
      const request = {
        epochId: 'epoch-waiting-supervisor',
        expectedOldEpochId: null,
        hostId: 'host-test',
        repoRoot,
        installedCommitSha: 'a'.repeat(40),
        oldInstalledRevisionRoot: repoRoot,
        legacySupervisorPid: process.pid,
        knownMemberRoster: [{ hostId: 'host-test' }],
        stores: [],
        paths: {
          stateDir: root,
          cordonPath: path.join(root, 'cordon.json'),
          phaseOnePath: path.join(root, 'phase-one.json'),
          followupPath: path.join(root, 'followups.json'),
          epochAuthorityPath: path.join(root, 'authority.json'),
          targetRegistryPath: path.join(root, 'target-registry.json'),
          projectedRegistryPath: path.join(root, 'projected-registry.json'),
          snapshotDir: path.join(root, 'snapshots'),
          supervisorStateDir: stateDir,
          foundationEvidencePath: path.join(root, 'foundation.json'),
        },
      } as ActivationRequest;
      const nonce = 'waiting-supervisor-nonce';
      writeFileSync(path.join(stateDir, 'typescript-supervisor-status.json'), `${JSON.stringify({
        schemaVersion: 1,
        epochId: request.epochId,
        nonce,
        supervisorPid: process.pid,
        supervisorStartTicks: identity.startTicks,
        registryHash: 'registry-hash',
        registrySource: request.paths.targetRegistryPath,
        childId: 'pr2-scheduler',
        childPid: null,
        childGeneration: 2,
        childRestarts: 1,
        restartState: 'waiting-restart',
        startedAt: new Date().toISOString(),
        lastChildStartAt: new Date().toISOString(),
        cordonReason: 'post-cas-epoch-owner',
        refusalReason: null,
      })}\n`, 'utf8');

      await expect(productionRecoveryBoundary.ensureTypeScriptSupervisor(request, nonce)).resolves.toEqual({
        supervisorPid: process.pid,
        childGeneration: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('waits for durable scheduler delivery after child completion instead of failing one-shot', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'opk-928-delivery-wait-'));
    try {
      const stateDir = path.join(root, 'supervisor');
      const storeRoot = path.join(root, 'review-runs');
      mkdirSync(stateDir, { recursive: true });
      initializePackReviewRunStore(storeRoot);
      const identity = readProcessIdentity(process.pid);
      const core: EpochCommitCore = {
        epochId: 'epoch-delivery-wait',
        nonce: 'nonce-delivery-wait',
        hostId: 'host-test',
        repoRoot,
        installedCommitSha: 'b'.repeat(40),
        snapshotDigests: { reconcile: 'r', reevaluation: 'e', reportStateSeed: 's' },
        importDigests: { reconcile: 'ir', reevaluation: 'ie', reportStateSeed: 'is' },
        registryHash: 'registry-hash',
        preCommitLogDigest: 'phase-one',
        commitAt: new Date(Date.now() - 1_000).toISOString(),
      };
      const request = {
        epochId: core.epochId,
        expectedOldEpochId: null,
        hostId: core.hostId,
        repoRoot,
        installedCommitSha: core.installedCommitSha,
        oldInstalledRevisionRoot: repoRoot,
        legacySupervisorPid: process.pid,
        knownMemberRoster: [{ hostId: core.hostId }],
        stores: [],
        paths: {
          stateDir: root,
          cordonPath: path.join(root, 'cordon.json'),
          phaseOnePath: path.join(root, 'phase-one.json'),
          followupPath: path.join(root, 'followups.json'),
          epochAuthorityPath: path.join(root, 'authority.json'),
          targetRegistryPath: path.join(root, 'target-registry.json'),
          projectedRegistryPath: path.join(root, 'projected-registry.json'),
          snapshotDir: path.join(root, 'snapshots'),
          supervisorStateDir: stateDir,
          foundationEvidencePath: path.join(root, 'foundation.json'),
        },
      } as ActivationRequest;
      writeFileSync(path.join(stateDir, 'typescript-supervisor-status.json'), `${JSON.stringify({
        schemaVersion: 1,
        epochId: core.epochId,
        nonce: core.nonce,
        supervisorPid: process.pid,
        supervisorStartTicks: identity.startTicks,
        registryHash: core.registryHash,
        registrySource: request.paths.targetRegistryPath,
        childId: 'pr2-scheduler',
        childPid: null,
        childGeneration: 3,
        childRestarts: 2,
        restartState: 'waiting-restart',
        startedAt: new Date().toISOString(),
        lastChildStartAt: new Date().toISOString(),
        cordonReason: 'post-cas-epoch-owner',
        refusalReason: null,
      })}\n`, 'utf8');

      const headSha = 'c'.repeat(40);
      const delayedDelivery = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const created = createPackReviewRun({
          projectId: 'orchestrator-pack',
          storeRoot,
          prNumber: 928,
          headSha,
          linkedSessionId: 'worker-delayed',
          startReason: 'scheduler',
          surface: 'pr2-scheduler',
          trustedPackRoot: repoRoot,
          sourceRepoRoot: repoRoot,
        });
        const now = new Date().toISOString();
        updatePackReviewRun(created.run.id, {
          status: 'up_to_date',
          latestRunStatus: 'up_to_date',
          reviewVerdict: 'clean',
          findingCount: 0,
          findings: [],
          journalOutcome: {
            state: 'persisted',
            recordedAtUtc: now,
            reason: 'verdict_persisted',
            idempotencyKey: `verdict:${created.run.id}:${headSha}`,
            attempts: 1,
          },
          githubReviewId: 92801,
          githubReviewUrl: 'fixture://issue-928/delayed-review',
          githubReviewReconciliation: {
            schemaVersion: 1,
            event: 'COMMENT',
            phase: 'complete',
            actorLogin: 'issue-928-reviewer',
            commentBody: 'clean',
            commentReviewId: 92801,
            commentReviewUrl: 'fixture://issue-928/delayed-review',
            pendingDismissalReviewIds: [],
            dismissedReviewIds: [],
            preparedAtUtc: now,
            updatedAtUtc: now,
          },
          deliveryOutcomes: {
            requiredStatus: {
              state: 'succeeded',
              recordedAtUtc: now,
              reason: 'fixture_status_written',
              idempotencyKey: `required-status:orchestrator-pack/pack-review:${headSha}`,
            },
            workerNotification: {
              state: 'delivered',
              recordedAtUtc: now,
              reason: 'fixture_worker_delivered',
              idempotencyKey: `worker-notification:${created.run.id}:${headSha}`,
            },
          },
        }, { projectId: 'orchestrator-pack', storeRoot });
      })();

      const observation = await observeSchedulerHealthAndDelivery(
        request,
        core,
        { supervisorPid: process.pid, childGeneration: 3 },
        storeRoot,
        { timeoutMs: 1_000, pollMs: 10 },
      );
      await delayedDelivery;
      expect(observation.supervisor.restartState).toBe('waiting-restart');
      expect(observation.delivery.headSha).toBe(headSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
