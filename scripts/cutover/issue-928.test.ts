import { afterEach, describe, expect, it } from 'vitest';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stableStringify } from '../lib/cutover/stable-stringify.ts';
import { JsonEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { importStore } from '../lib/cutover/activation-import.ts';
import { validateSchedulerRegistry } from '../lib/cutover/activation-registry-projection.ts';
import { detectPlatform, processStartTime } from '../lib/cutover/activation-platform-preflight.ts';
import { runActivationTransaction } from '../lib/cutover/activation-transaction.ts';
import { recoveryDisposition } from '../lib/cutover/activation-recovery.ts';
import { assertSchedulerEpoch, runSchedulerTick } from '../pr2-foundation/scheduler.ts';
import type { ActivationContext, ActivationCore, StoreId } from '../lib/cutover/types.ts';

const roots: string[] = [];
const sleepers: Array<{ pid: number; controller: AbortController; completion: Promise<ProcessResult> }> = [];
afterEach(() => {
  for (const sleeper of sleepers.splice(0)) {
    sleeper.controller.abort();
    try { process.kill(sleeper.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-928-'));
  roots.push(root);
  return root;
}

function core(epochId = 'epoch-1', nonce = 'nonce-1'): ActivationCore {
  return {
    epochId, nonce, hostId: 'host-1', repoRoot: '/repo', installedCommitSha: '1'.repeat(40),
    snapshotDigests: { reconcile: 'a', reevaluation: 'b', reportStateSeed: 'c' },
    importDigests: { reconcile: 'd', reevaluation: 'e', reportStateSeed: 'f' },
    registryHash: 'hash', preCommitLogDigest: 'phase', commitAt: '2026-07-26T00:00:00.000Z',
  };
}

function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8'); }

function spawnSleeper(role: string): { identity: { pid: number; startTime: string; role: string } } {
  const controller = new AbortController();
  let pid = 0;
  const completion = runProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    inheritParentEnv: true,
    signal: controller.signal,
    allowEmptyStdout: true,
    onSpawn: (spawnedPid) => { pid = spawnedPid; },
  });
  if (!pid) {
    controller.abort();
    throw new Error(`spawn_failed:${role}`);
  }
  sleepers.push({ pid, controller, completion });
  return { identity: { pid, startTime: processStartTime(pid), role } };
}

describe('Issue #928 cutover', () => {
  it('AC1 validates Node22 platform and canonical stable-stringify vectors', () => {
    expect(Number(process.versions.node.split('.')[0])).toBe(22);
    expect(['linux', 'wsl2']).toContain(detectPlatform());
    const fixture = JSON.parse(readFileSync(resolve('scripts/fixtures/cutover/stable-stringify-vectors.json'), 'utf8')) as { vectors: Array<{ value: unknown; canonical: string }> };
    for (const vector of fixture.vectors) expect(stableStringify(vector.value)).toBe(vector.canonical);
  });

  it('AC2 accepts exactly the scheduler-only target registry', () => {
    const bytes = readFileSync(resolve('scripts/orchestrator-side-process-registry.cutover-target.json'));
    const registry = validateSchedulerRegistry(bytes);
    expect(registry.requiredChildIds).toEqual(['pack-review-scheduler']);
    expect(registry.children).toHaveLength(1);
    expect(registry.children[0]?.script).toBe('pr2-foundation/scheduler.ts');
    const invalid = { ...registry, children: [...registry.children, { ...registry.children[0]!, id: 'legacy-extra' }] };
    expect(() => validateSchedulerRegistry(Buffer.from(JSON.stringify(invalid)))).toThrow(/cardinality/);
  });

  it('AC3 imports the three closed store shapes idempotently and rejects unknown fields', () => {
    const root = tempRoot();
    const cases: Array<[StoreId, Record<string, unknown>]> = [
      ['reconcile', { lastTickMs: 1, degradedCi: {}, cycleState: {} }],
      ['reevaluation', { watchEntries: {}, terminalTombstones: {}, lastUpdatedMs: 1 }],
      ['reportStateSeed', { bindingByKey: {}, seededKeys: [], deferredScanKeys: [], githubSnapshot: {}, lastUpdatedMs: 1 }],
    ];
    for (const [storeId, value] of cases) {
      const snapshotPath = join(root, `${storeId}.snapshot.json`);
      const targetPath = join(root, `${storeId}.target.json`);
      writeJson(snapshotPath, value);
      const first = importStore({ epochId: 'e', nonce: 'n', storeId, snapshotPath, targetPath });
      const second = importStore({ epochId: 'e', nonce: 'n', storeId, snapshotPath, targetPath });
      expect(second.targetDigest).toBe(first.targetDigest);
      writeJson(snapshotPath, { ...value, forbidden: true });
      expect(() => importStore({ epochId: 'e', nonce: 'n', storeId, snapshotPath, targetPath })).toThrow(/store_unknown_field/);
    }
  });

  it('AC4 rehearses cordon -> drain -> import -> projection -> CAS -> TypeScript ownership', async () => {
    const root = tempRoot();
    const stateDir = join(root, 'state'); mkdirSync(stateDir);
    const targets = join(root, 'targets'); mkdirSync(targets);
    const projections = join(root, 'projection'); mkdirSync(projections);
    const oldRevisionRoot = join(root, 'old'); mkdirSync(oldRevisionRoot);
    const stagedRegistryPath = join(root, 'staged.json');
    writeFileSync(stagedRegistryPath, readFileSync(resolve('scripts/orchestrator-side-process-registry.cutover-target.json')));
    const snapshotFiles = {
      reconcile: join(root, 'reconcile.json'), reevaluation: join(root, 'reevaluation.json'), reportStateSeed: join(root, 'report.json'),
    };
    writeJson(snapshotFiles.reconcile, { lastTickMs: 1, degradedCi: {}, cycleState: {} });
    writeJson(snapshotFiles.reevaluation, { watchEntries: {}, terminalTombstones: {}, lastUpdatedMs: 1 });
    writeJson(snapshotFiles.reportStateSeed, { bindingByKey: {}, seededKeys: [], deferredScanKeys: [], githubSnapshot: {}, lastUpdatedMs: 1 });
    const old = spawnSleeper('legacy-supervisor');
    const writer = spawnSleeper('legacy-writer');
    const context: ActivationContext = {
      schemaVersion: 1, epochId: 'epoch-928', oldEpochId: '', hostId: 'ci-host', repoRoot: resolve('.'),
      installedCommitSha: '2'.repeat(40), oldRevisionRoot, stateDir, epochAuthorityFile: join(root, 'authority.json'),
      stagedRegistryPath, liveRegistryProjectionPath: join(projections, 'registry.json'), oldSupervisor: old.identity,
      writers: [writer.identity], snapshotFiles,
      targetFiles: { reconcile: join(targets, 'reconcile.json'), reevaluation: join(targets, 'reevaluation.json'), reportStateSeed: join(targets, 'report.json') },
    };
    const result = await runActivationTransaction(context, {
      provePrerequisites: () => undefined,
      startTypeScriptSupervisor: () => undefined,
      proveClaimAuthorityUnchanged: () => undefined,
      proveCycle: () => undefined,
    });
    expect(result.admission.result).toBe('foundation-single-host-adopted');
    expect(result.activation.result).toBe('C1-C18-ts-transfer-pass');
    expect(result.import_claim.result).toBe('imports-and-claim-compatibility-verified');
    expect(result.cycle.result).toBe('rehearsal-and-ts-replacement-proven');
    expect(result.recovery.result).toBe('forward-recovery-boundary-proven');
    expect(result.evidence.result).toBe('single-central-cas-phase-evidence-bound');
    const committed = new JsonEpochAuthority(context.epochAuthorityFile).get(context.epochId)!;
    expect(recoveryDisposition(stateDir, context.epochAuthorityFile, context.epochId, committed.nonce)).toBe('complete');

    const head = 'a'.repeat(40);
    const readySession = {
      id: 'worker-928', name: 'worker-928', sessionId: 'worker-928', role: 'worker', status: 'idle', activity: 'idle',
      prNumber: 928, ownedHeadSha: head,
      reports: [{ reportState: 'ready_for_review', accepted: true, headSha: head, reportedAt: '2026-07-26T00:00:00.000Z' }],
    };
    const snapshot = {
      openPrs: [{ number: 928, headRefOid: head, headCommittedAt: '2026-07-25T23:30:00.000Z', isDraft: false }],
      reviewRuns: [], sessions: [readySession], sessionDetailsById: {},
      ciChecksByPr: { '928': [
        { name: 'Verify orchestrator-pack structure', state: 'SUCCESS' },
        { name: 'PR scope guard', state: 'SUCCESS' },
        { name: 'Run pack contract tests', state: 'SUCCESS' },
        { name: 'Self-architect lint', state: 'SUCCESS' },
      ] },
      requiredCheckNamesByPr: { '928': [] }, requiredCheckLookupFailedByPr: { '928': false },
      tracking: {}, cycleState: {}, capCycleState: {}, repoRoot: resolve('.'),
      nowMs: Date.parse('2026-07-26T00:05:00.000Z'),
    };
    let starts = 0;
    const schedulerOptions = {
      repoRoot: resolve('.'), stateDir, epochId: context.epochId, nonce: committed.nonce,
      epochAuthorityFile: context.epochAuthorityFile, registryPath: context.liveRegistryProjectionPath,
    };
    const deps = {
      collectSnapshot: async () => snapshot as never,
      startReview: async (_options: unknown, action: { prNumber: number; sessionId: string }) => {
        starts += 1;
        expect(action.prNumber).toBe(928);
        expect(action.sessionId).toBe('worker-928');
      },
    };
    const firstTick = await runSchedulerTick(schedulerOptions, deps as never);
    expect(firstTick.attempted).toBe(0);
    const persisted = JSON.parse(readFileSync(join(stateDir, 'orchestrator-review-reconcile-state.json'), 'utf8')) as { cycleState?: Record<string, unknown> };
    snapshot.cycleState = persisted.cycleState ?? {};
    snapshot.nowMs += 16 * 60 * 1000;
    const settledTick = await runSchedulerTick(schedulerOptions, deps as never);
    expect(settledTick.attempted).toBe(1);
    expect(starts).toBe(1);
  });

  it('AC5 central CAS is single-commit and nonce fenced', () => {
    const root = tempRoot();
    const authority = new JsonEpochAuthority(join(root, 'authority.json'));
    const first = core();
    expect(authority.commit('', first)).toEqual(first);
    expect(authority.commit('', first)).toEqual(first);
    expect(() => authority.require(first.epochId, 'wrong')).toThrow(/nonce/);
    expect(() => authority.commit('', { ...first, nonce: 'changed' })).toThrow(/duplicate_conflict/);
  });

  it('AC6 scheduler refuses stale epoch/nonce before attempting work', async () => {
    const root = tempRoot();
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, readFileSync(resolve('scripts/orchestrator-side-process-registry.cutover-target.json')));
    const registryHash = (await import('../lib/cutover/stable-stringify.ts')).sha256Bytes(readFileSync(registryPath));
    const authorityPath = join(root, 'authority.json');
    const authority = new JsonEpochAuthority(authorityPath);
    const committed = { ...core('epoch-scheduler', 'nonce-scheduler'), repoRoot: resolve('.'), registryHash };
    authority.commit('', committed);
    const options = { repoRoot: resolve('.'), epochId: committed.epochId, nonce: committed.nonce, epochAuthorityFile: authorityPath, registryPath };
    expect(() => assertSchedulerEpoch(options)).not.toThrow();
    let collected = false;
    await expect(runSchedulerTick({ ...options, stateDir: root, nonce: 'wrong' }, { collectSnapshot: async () => { collected = true; throw new Error('must_not_collect'); } })).rejects.toThrow(/nonce/);
    expect(collected).toBe(false);
  });

  it('AC7 merged revision has exactly four required PowerShell deletions and no pwsh dispatch in replacement production paths', () => {
    for (const path of [
      'scripts/orchestrator-wake-supervisor.ps1',
      'scripts/lib/Orchestrator-SideProcessSupervisor.ps1',
      'scripts/lib/Review-StartClaim.ps1',
      'scripts/review-start-claim-reaper.ps1',
    ]) expect(existsSync(resolve(path))).toBe(false);
    for (const path of [
      'scripts/orchestrator-cutover-activate.ts',
      'scripts/orchestrator-wake-supervisor.ts',
      'scripts/lib/orchestrator-side-process-supervisor.ts',
      'scripts/pr2-foundation/scheduler.ts',
    ]) expect(readFileSync(resolve(path), 'utf8').toLowerCase()).not.toContain('pwsh');
  });

  it('AC8 target registry remains staged and tracked live registry is not the scheduler-only projection', () => {
    const live = readFileSync(resolve('scripts/orchestrator-side-process-registry.json'), 'utf8');
    const target = readFileSync(resolve('scripts/orchestrator-side-process-registry.cutover-target.json'), 'utf8');
    expect(live).not.toBe(target);
    const parsed = JSON.parse(target);
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children[0].script).toBe('pr2-foundation/scheduler.ts');
  });
});
