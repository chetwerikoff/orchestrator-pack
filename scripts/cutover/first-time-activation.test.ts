import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activateCutover, type ActivationBoundary } from '../lib/cutover/activation-transaction.ts';
import { FileEpochAuthority } from '../lib/cutover/activation-epoch-authority.ts';
import { foundationEvidenceDigest, verifyFoundationEvidenceDigest } from '../lib/cutover/activation-evidence.ts';
import type { ActivationRequest, FoundationAdmissionEvidence } from '../lib/cutover/types.ts';

const roots: string[] = [];

function fixture(): { request: ActivationRequest; boundary: ActivationBoundary; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opk-1422-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const supervisorStateDir = path.join(stateDir, 'supervisor');
  mkdirSync(supervisorStateDir, { recursive: true });
  const targetRegistryPath = path.join(root, 'registry.json');
  writeFileSync(targetRegistryPath, JSON.stringify({
    schemaVersion: 2,
    requiredChildIds: ['pr2-scheduler'],
    children: [{ id: 'pr2-scheduler', runtime: 'node', script: 'pr2-foundation/scheduler.ts', sideEffecting: true, cadenceSeconds: 5 }],
  }));
  const stores = (['reconcile', 'reevaluation', 'reportStateSeed'] as const).map((id) => {
    const sourcePath = path.join(root, `${id}-source.json`);
    const targetPath = path.join(root, `${id}-target.json`);
    const value = id === 'reconcile'
      ? { lastTickMs: 1, degradedCi: {}, cycleState: {} }
      : id === 'reevaluation'
        ? { watchEntries: {}, terminalTombstones: {}, lastUpdatedMs: 2 }
        : { bindingByKey: {}, seededKeys: [], deferredScanKeys: [], githubSnapshot: {}, lastUpdatedMs: 3 };
    writeFileSync(sourcePath, `${JSON.stringify(value)}\n`);
    return {
      id,
      sourcePath,
      targetPath,
      coveredFields: id === 'reconcile'
        ? ['lastTickMs', 'degradedCi', 'cycleState']
        : id === 'reevaluation'
          ? ['watchEntries', 'terminalTombstones', 'lastUpdatedMs']
          : ['bindingByKey', 'seededKeys', 'deferredScanKeys', 'githubSnapshot', 'lastUpdatedMs'],
    };
  });
  const request: ActivationRequest = {
    epochId: 'greenfield-1422',
    expectedOldEpochId: null,
    hostId: 'test-host',
    repoRoot: root,
    installedCommitSha: 'a'.repeat(40),
    oldInstalledRevisionRoot: root,
    legacySupervisorPid: 0,
    knownMemberRoster: [{ hostId: 'test-host' }],
    stores,
    paths: {
      stateDir,
      cordonPath: path.join(stateDir, 'cordon.json'),
      phaseOnePath: path.join(stateDir, 'phase-one.json'),
      followupPath: path.join(stateDir, 'followups.json'),
      epochAuthorityPath: path.join(stateDir, 'epoch-authority.json'),
      targetRegistryPath,
      projectedRegistryPath: path.join(stateDir, 'projected-registry.json'),
      snapshotDir: path.join(root, 'snapshots'),
      supervisorStateDir,
      foundationEvidencePath: path.join(stateDir, 'foundation-923-adoption.json'),
    },
  };
  const boundary: ActivationBoundary = {
    preflight: () => ({ result: 'node22-linux-wsl2-preflight-pass', repoRoot: root, oldInstalledRevisionRoot: root, platform: 'linux', nodeMajor: 22 }),
    proveFoundationAdoption: () => ({
      result: 'foundation-evidence-verified',
      evidencePath: request.paths.foundationEvidencePath,
      localHostId: request.hostId,
      oldInstalledCommitSha: request.installedCommitSha,
      heartbeatObservedAt: new Date().toISOString(),
      migrationJournalCount: 1,
      preflightSanitizerId: 'sha256:test',
      activationMode: 'greenfield',
      writerWatermark: 'sha256:observed-empty-writer-set',
    }),
    resolveBaseAndClosure: () => ({ baseRef: 'base', closure: { inputTree: 'tree', referenceCount: 0 } }),
    readLegacySupervisor: () => { throw new Error('legacy_path_should_not_run'); },
    captureLegacyWriters: () => [],
    drainLegacyWriters: async () => { throw new Error('legacy_path_should_not_run'); },
    terminateLegacyProcesses: async () => { throw new Error('legacy_path_should_not_run'); },
    verifyLegacyProcessesGone: () => { throw new Error('legacy_path_should_not_run'); },
    startTypeScriptSupervisor: async () => ({ supervisorPid: 1422, childGeneration: 1 }),
    observeFinalHealthAndDelivery: async () => ({
      result: 'scheduler-health-delivery-observed',
      epochId: request.epochId,
      nonce: 'nonce',
      installedCommitSha: request.installedCommitSha,
      observedAt: new Date().toISOString(),
      supervisor: { pid: 1422, childGeneration: 1, childPid: 1423, registryHash: 'sha256:registry', restartState: 'running' },
      delivery: { result: 'scheduler-durable-delivery-observed', runId: 'run', prNumber: 1422, headSha: 'b'.repeat(40), status: 'ok', journalState: 'persisted', deliveryOutcomes: {} },
    }),
  };
  return { request, boundary, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue 1422 first-time activation', () => {
  it('commits through the existing transaction without entering legacy handover', async () => {
    const { request, boundary } = fixture();
    const result = await activateCutover(request, boundary);
    expect((result as { cutover: { admission: { result: string } } }).cutover.admission.result).toBe('foundation-single-host-adopted');
    expect(new FileEpochAuthority(request.paths.epochAuthorityPath).read().currentEpochId).toBe(request.epochId);
    expect(JSON.parse(readFileSync(request.paths.cordonPath, 'utf8')).legacySupervisor).toBeNull();
    expect(existsSync(request.paths.epochAuthorityPath)).toBe(true);
  });

  it('rejects mutated producer evidence before activation', () => {
    const evidence = {
      schemaVersion: 1,
      issue: 923,
      foundationMergeCommitSha: 'b'.repeat(40),
      producer: 'orchestrator-pack:foundation-adoption-producer',
      preflight: { command: 'a\u006f session ls --json', appStateVersion: '0.10.3', sessions: [], sanitizerId: 'sha256:test' },
      typedConfig: {},
      migrationJournalPaths: ['journal.json'],
      runtimeCatalog: [],
      inertProof: { result: 'live-acquirers-unchanged' },
      heartbeats: [],
    } satisfies Omit<FoundationAdmissionEvidence, 'observationDigest'>;
    const signed = { ...evidence, observationDigest: foundationEvidenceDigest(evidence) };
    expect(() => verifyFoundationEvidenceDigest({ ...signed, typedConfig: { changed: true } })).toThrow('foundation_evidence_observation_digest_invalid');
  });
});
