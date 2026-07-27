import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../../kernel/subprocess.ts';
import { buildEpochCommitCore, FileEpochAuthority, mapCutoverStoreDigests } from './activation-epoch-authority.ts';
import {
  assertCordonRequestBinding,
  fileDigestOrAbsent,
  processAlive,
  readCordon,
  readCordonState,
  readProcessIdentity,
} from './activation-cordon.ts';
import { appendFollowup, appendPhaseOne, finalizePhaseOne, readPhaseOneDetail, verifyPhaseOneDetails, verifyPhaseOneDigest } from './activation-evidence.ts';
import { importSnapshot } from './activation-import.ts';
import { projectRegistry } from './activation-registry-projection.ts';
import { sha256Bytes, sha256Stable } from './stable-stringify.ts';
import type { CordonRecord, FollowupRecord, ActivationRequest, EpochCommitCore, ImportRecord, PhaseOneEnvelope, SnapshotRecord } from './types.ts';
import { readSupervisorStatus, type SupervisorStatus } from '../orchestrator-side-process-supervisor.ts';
import { listPackReviewRuns, type PackReviewRunRecord } from '../pack-review-run-store.ts';
import { packReviewDeliveryNeedsResume } from '../pack-review-delivery.ts';

const DEFAULT_SCHEDULER_DELIVERY_WAIT_MS = 46 * 60_000;
const DEFAULT_SCHEDULER_DELIVERY_POLL_MS = 250;

export interface SchedulerHealthDeliveryObservation {
  result: 'scheduler-health-delivery-observed';
  epochId: string;
  nonce: string;
  installedCommitSha: string;
  observedAt: string;
  supervisor: {
    pid: number;
    childGeneration: number;
    childPid: number | null;
    registryHash: string;
    restartState: 'running' | 'waiting-restart';
  };
  delivery: {
    result: 'scheduler-durable-delivery-observed';
    runId: string;
    prNumber: number;
    headSha: string;
    status: string;
    journalState: 'persisted';
    deliveryOutcomes: PackReviewRunRecord['deliveryOutcomes'];
  };
}

export interface RecoveryBoundary {
  ensureTypeScriptSupervisor(request: ActivationRequest, nonce: string): Promise<{ supervisorPid: number; childGeneration: number }>;
  observeFinalHealthAndDelivery(
    request: ActivationRequest,
    core: EpochCommitCore,
    supervisor: { supervisorPid: number; childGeneration: number },
  ): Promise<SchedulerHealthDeliveryObservation>;
}

function assertCommittedContext(request: ActivationRequest, cordon: CordonRecord, core: EpochCommitCore): void {
  if (
    core.epochId !== cordon.epochId
    || core.nonce !== cordon.nonce
    || core.hostId !== cordon.hostId
    || core.repoRoot !== cordon.repoRoot
    || core.installedCommitSha !== cordon.installedCommitSha
    || request.epochId !== core.epochId
    || request.hostId !== core.hostId
    || request.repoRoot !== core.repoRoot
    || request.installedCommitSha !== core.installedCommitSha
  ) {
    throw new Error('recovery_commit_context_mismatch');
  }
}

export function provePreImportRollbackSafe(request: ActivationRequest): { safe: true; result: 'pre-import-old-revision-restorable' } {
  const cordon = readCordonState(request.paths.cordonPath);
  assertCordonRequestBinding(request, cordon);
  if (cordon.importBegunAt) throw new Error('forward_only_recovery_required');
  for (const store of cordon.recoveryBindings.stores) {
    if (fileDigestOrAbsent(store.targetPath) !== cordon.preImportTargetDigests[store.id]) {
      throw new Error(`preimport_target_changed:${store.id}`);
    }
  }
  return { safe: true, result: 'pre-import-old-revision-restorable' };
}

function followups(pathName: string): FollowupRecord[] {
  if (!existsSync(pathName)) return [];
  const rows = JSON.parse(readFileSync(pathName, 'utf8')) as FollowupRecord[];
  if (!Array.isArray(rows)) throw new Error('followup_invalid');
  rows.forEach((row, index) => {
    if (row.sequence !== index + 1) throw new Error('followup_sequence_invalid');
  });
  return rows;
}

function appendIfMissing(pathName: string, epochId: string, step: string, detail: unknown): void {
  if (followups(pathName).some((row) => row.epochId === epochId && row.step === step)) return;
  appendFollowup(pathName, epochId, step, detail);
}

function liveSupervisorStatus(request: ActivationRequest, nonce: string): SupervisorStatus | null {
  const status = readSupervisorStatus({ stateDir: request.paths.supervisorStateDir });
  if (!status) return null;
  let identity;
  try {
    identity = readProcessIdentity(status.supervisorPid);
  } catch {
    return null;
  }
  if (identity.startTicks !== status.supervisorStartTicks) return null;
  if (status.epochId !== request.epochId || status.nonce !== nonce) throw new Error('recovery_supervisor_context_conflict');
  if (status.restartState === 'refused') throw new Error(`recovery_supervisor_refused:${status.refusalReason ?? 'unknown'}`);
  if (status.restartState === 'stopping') throw new Error('recovery_supervisor_stopping');
  return status;
}

function readySupervisorStatus(request: ActivationRequest, nonce: string): { supervisorPid: number; childGeneration: number } | null {
  const status = liveSupervisorStatus(request, nonce);
  if (!status || !status.registryHash || status.childGeneration < 1) return null;
  if (status.restartState === 'running') {
    if (status.childPid === null || !processAlive(status.childPid)) return null;
  } else if (status.restartState !== 'waiting-restart') {
    return null;
  }
  return { supervisorPid: status.supervisorPid, childGeneration: status.childGeneration };
}

async function waitForSupervisor(request: ActivationRequest, nonce: string): Promise<{ supervisorPid: number; childGeneration: number }> {
  const deadline = Date.now() + 10_000;
  do {
    const ready = readySupervisorStatus(request, nonce);
    if (ready) return ready;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('recovery_supervisor_not_ready');
}

export function findCompletedSchedulerDelivery(core: EpochCommitCore, storeRoot?: string): PackReviewRunRecord | null {
  const committedAt = Date.parse(core.commitAt);
  if (!Number.isFinite(committedAt)) throw new Error('recovery_commit_timestamp_invalid');
  const runs = listPackReviewRuns({
    projectId: 'orchestrator-pack',
    ...(storeRoot ? { storeRoot } : {}),
  });
  return runs.find((run) =>
    run.surface === 'pr2-scheduler'
    && run.startReason === 'scheduler'
    && run.headSha === run.targetSha
    && Date.parse(run.createdAt) >= committedAt
    && run.journalOutcome?.state === 'persisted'
    && run.githubReviewReconciliation?.phase === 'complete'
    && run.deliveryOutcomes?.requiredStatus?.state === 'succeeded'
    && run.deliveryOutcomes?.workerNotification?.state === 'delivered'
    && !packReviewDeliveryNeedsResume(run)) ?? null;
}

function observedSupervisorStatus(
  request: ActivationRequest,
  core: EpochCommitCore,
  supervisor: { supervisorPid: number; childGeneration: number },
): SupervisorStatus | null {
  const status = liveSupervisorStatus(request, core.nonce);
  if (
    !status
    || status.supervisorPid !== supervisor.supervisorPid
    || status.childGeneration < supervisor.childGeneration
    || status.registryHash !== core.registryHash
  ) return null;
  if (status.restartState === 'running') {
    if (status.childPid === null || !processAlive(status.childPid)) return null;
    return status;
  }
  return status.restartState === 'waiting-restart' ? status : null;
}

export async function observeSchedulerHealthAndDelivery(
  request: ActivationRequest,
  core: EpochCommitCore,
  supervisor: { supervisorPid: number; childGeneration: number },
  storeRoot?: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SchedulerHealthDeliveryObservation> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCHEDULER_DELIVERY_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_SCHEDULER_DELIVERY_POLL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('scheduler_delivery_wait_invalid');
  }
  const deadline = Date.now() + timeoutMs;
  let lastStatus: SupervisorStatus | null = null;
  let delivered: PackReviewRunRecord | null = null;
  do {
    lastStatus = observedSupervisorStatus(request, core, supervisor);
    delivered = findCompletedSchedulerDelivery(core, storeRoot);
    if (lastStatus && delivered) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);

  if (!delivered) throw new Error('scheduler_delivery_not_observed');
  if (!lastStatus) throw new Error('scheduler_health_not_observed');
  return {
    result: 'scheduler-health-delivery-observed',
    epochId: core.epochId,
    nonce: core.nonce,
    installedCommitSha: core.installedCommitSha,
    observedAt: new Date().toISOString(),
    supervisor: {
      pid: lastStatus.supervisorPid,
      childGeneration: lastStatus.childGeneration,
      childPid: lastStatus.childPid,
      registryHash: lastStatus.registryHash!,
      restartState: lastStatus.restartState as 'running' | 'waiting-restart',
    },
    delivery: {
      result: 'scheduler-durable-delivery-observed',
      runId: delivered.runId,
      prNumber: delivered.prNumber,
      headSha: delivered.headSha,
      status: delivered.status,
      journalState: 'persisted',
      deliveryOutcomes: delivered.deliveryOutcomes,
    },
  };
}

export const productionRecoveryBoundary: RecoveryBoundary = {
  ensureTypeScriptSupervisor: async (request, nonce) => {
    const ready = readySupervisorStatus(request, nonce);
    if (ready) return ready;
    if (liveSupervisorStatus(request, nonce)) return waitForSupervisor(request, nonce);
    const entry = path.join(request.repoRoot, 'scripts', 'orchestrator-wake-supervisor.ts');
    const result = await runProcess({
      command: process.execPath,
      args: [
        '--experimental-strip-types', entry, 'run', '--detach',
        '--state-dir', request.paths.supervisorStateDir,
        '--repo-root', request.repoRoot,
        '--epoch-authority', request.paths.epochAuthorityPath,
        '--epoch-id', request.epochId,
        '--nonce', nonce,
        '--target-registry', request.paths.targetRegistryPath,
        '--projected-registry', request.paths.projectedRegistryPath,
      ],
      cwd: request.repoRoot,
      inheritParentEnv: true,
      allowEmptyStdout: false,
      timeoutMs: 15_000,
    });
    if (!result.ok) throw new Error(`recovery_supervisor_start_failed:${result.stderr || result.error || result.exitCode}`);
    const payload = JSON.parse(result.stdout) as { pid?: unknown };
    const pid = Number(payload.pid);
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('recovery_supervisor_pid_invalid');
    return waitForSupervisor(request, nonce);
  },
  observeFinalHealthAndDelivery: observeSchedulerHealthAndDelivery,
};

const REQUIRED_PREIMPORT_STEPS = [
  'admission',
  'cordon',
  'writer-drain',
  'legacy-supervisor-and-writers-terminated',
  'snapshots',
  'import-begun',
] as const;

function readPhaseOne(pathName: string, epochId: string, nonce: string): PhaseOneEnvelope {
  if (!existsSync(pathName)) throw new Error('phase_one_missing');
  const envelope = JSON.parse(readFileSync(pathName, 'utf8')) as PhaseOneEnvelope;
  if (envelope.schemaVersion !== 1 || envelope.epochId !== epochId || envelope.nonce !== nonce || !Array.isArray(envelope.records)) {
    throw new Error('phase_one_envelope_mismatch');
  }
  envelope.records.forEach((record, index) => {
    if (record.sequence !== index + 1) throw new Error('phase_one_sequence_invalid');
  });
  return envelope;
}

function assertForwardRecoveryPrefix(pathName: string, epochId: string, nonce: string): void {
  const envelope = readPhaseOne(pathName, epochId, nonce);
  const steps = envelope.records.map((row) => row.step);
  for (let index = 0; index < REQUIRED_PREIMPORT_STEPS.length; index += 1) {
    if (steps[index] !== REQUIRED_PREIMPORT_STEPS[index]) {
      throw new Error(`precas_recovery_evidence_incomplete:${REQUIRED_PREIMPORT_STEPS[index]}`);
    }
  }
  const allowed = new Set([...REQUIRED_PREIMPORT_STEPS, 'imports', 'registry-projected']);
  if (steps.some((step) => !allowed.has(step))) throw new Error('precas_recovery_phase_unknown');
  if (steps.filter((step) => step === 'imports').length > 1 || steps.filter((step) => step === 'registry-projected').length > 1) {
    throw new Error('precas_recovery_phase_duplicate');
  }
  const importsIndex = steps.indexOf('imports');
  const projectionIndex = steps.indexOf('registry-projected');
  if (projectionIndex >= 0 && (importsIndex < 0 || projectionIndex < importsIndex)) throw new Error('precas_recovery_phase_order_invalid');
}

function ensurePhaseOneStep(pathName: string, epochId: string, nonce: string, step: string, detail: unknown): void {
  const envelope = readPhaseOne(pathName, epochId, nonce);
  const existing = envelope.records.find((row) => row.step === step);
  const expectedDigest = sha256Stable(detail);
  if (existing) {
    if (existing.detailDigest !== expectedDigest) throw new Error(`precas_recovery_detail_mismatch:${step}`);
    readPhaseOneDetail(pathName, epochId, nonce, step);
    return;
  }
  appendPhaseOne(pathName, epochId, nonce, step, detail);
}

function recoverySnapshots(request: ActivationRequest, nonce: string): SnapshotRecord[] {
  const persisted = readPhaseOneDetail(request.paths.phaseOnePath, request.epochId, nonce, 'snapshots');
  if (!Array.isArray(persisted) || persisted.length !== request.stores.length) throw new Error('precas_snapshot_evidence_invalid');
  const rows = persisted as Array<Partial<SnapshotRecord>>;
  return request.stores.map((spec) => {
    const matches = rows.filter((row) => row.storeId === spec.id);
    if (matches.length !== 1) throw new Error(`precas_snapshot_evidence_invalid:${spec.id}`);
    const row = matches[0]!;
    const snapshotPath = path.join(request.paths.snapshotDir, `${spec.id}.snapshot.json`);
    if (
      row.snapshotPath !== snapshotPath
      || typeof row.snapshotDigest !== 'string'
      || !row.snapshotDigest.startsWith('sha256:')
      || !Number.isInteger(row.sourceVersion)
      || Number(row.sourceVersion) <= 0
      || typeof row.writerWatermark !== 'string'
      || !row.writerWatermark.trim()
    ) {
      throw new Error(`precas_snapshot_evidence_invalid:${spec.id}`);
    }
    if (!existsSync(snapshotPath)) throw new Error(`precas_snapshot_missing:${spec.id}`);
    const bytes = readFileSync(snapshotPath);
    if (sha256Bytes(bytes) !== row.snapshotDigest) throw new Error(`precas_snapshot_digest_mismatch:${spec.id}`);
    const parsed = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown };
    const sourceVersion = Number(parsed.schemaVersion ?? 1);
    if (!Number.isInteger(sourceVersion) || sourceVersion <= 0 || sourceVersion !== row.sourceVersion) {
      throw new Error(`precas_snapshot_version_mismatch:${spec.id}`);
    }
    return {
      storeId: spec.id,
      snapshotPath,
      snapshotDigest: row.snapshotDigest,
      sourceVersion,
      writerWatermark: row.writerWatermark,
    };
  });
}

function completePreCasRecovery(request: ActivationRequest, cordon: CordonRecord, authority: FileEpochAuthority): EpochCommitCore {
  const nonce = cordon.nonce;
  assertForwardRecoveryPrefix(request.paths.phaseOnePath, request.epochId, nonce);
  verifyPhaseOneDetails(request.paths.phaseOnePath, request.epochId, nonce);
  const snapshots = recoverySnapshots(request, nonce);
  const imports: ImportRecord[] = request.stores.map((spec) => importSnapshot({
    epochId: request.epochId,
    nonce,
    spec,
    snapshot: snapshots.find((row) => row.storeId === spec.id)!,
  }));
  ensurePhaseOneStep(request.paths.phaseOnePath, request.epochId, nonce, 'imports', imports);
  const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);
  ensurePhaseOneStep(request.paths.phaseOnePath, request.epochId, nonce, 'registry-projected', projection);
  const phaseOne = finalizePhaseOne(request.paths.phaseOnePath, request.epochId, nonce);
  const core = buildEpochCommitCore({
    epochId: cordon.epochId,
    nonce,
    hostId: cordon.hostId,
    repoRoot: cordon.repoRoot,
    installedCommitSha: cordon.installedCommitSha,
    snapshotDigests: mapCutoverStoreDigests(snapshots, (row) => row.snapshotDigest),
    importDigests: mapCutoverStoreDigests(imports, (row) => row.importTargetDigest),
    registryHash: projection.registryHash,
    preCommitLogDigest: phaseOne.digest,
  });
  authority.commit(request.expectedOldEpochId, core);
  return authority.verify(request.epochId, nonce);
}

export async function recoverCommittedCutover(
  request: ActivationRequest,
  boundary: RecoveryBoundary = productionRecoveryBoundary,
): Promise<{ result: 'forward-repair-ready'; epochId: string; nonce: string; supervisorPid: number; childGeneration: number }> {
  if (!existsSync(request.paths.cordonPath)) throw new Error('cordon_missing');
  const cordon = readCordon(request.paths.cordonPath);
  assertCordonRequestBinding(request, cordon);
  if (!cordon.importBegunAt) throw new Error('commit_recovery_before_import_boundary');
  const authority = new FileEpochAuthority(request.paths.epochAuthorityPath);
  const document = authority.read();
  let core: EpochCommitCore;
  if (document.currentEpochId === request.epochId) {
    core = authority.verify(request.epochId, cordon.nonce);
  } else {
    if (document.currentEpochId !== cordon.recoveryBindings.expectedOldEpochId || document.records.some((row) => row.epochId === request.epochId)) {
      throw new Error('epoch_cas_conflict');
    }
    core = completePreCasRecovery(request, cordon, authority);
  }
  assertCommittedContext(request, cordon, core);
  verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);
  const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);
  if (projection.registryHash !== core.registryHash) throw new Error('recovery_registry_hash_mismatch');
  appendIfMissing(request.paths.followupPath, request.epochId, 'committed-registry-reprojected', projection);
  const supervisor = await boundary.ensureTypeScriptSupervisor(request, cordon.nonce);
  appendIfMissing(request.paths.followupPath, request.epochId, 'typescript-supervisor-started', { supervisorPid: supervisor.supervisorPid });
  appendIfMissing(request.paths.followupPath, request.epochId, 'scheduler-owned', { supervisorPid: supervisor.supervisorPid, childGeneration: supervisor.childGeneration });
  appendIfMissing(request.paths.followupPath, request.epochId, 'machine-local-completion-fsync-confirmed', {
    followupPath: path.resolve(request.paths.followupPath),
    durability: 'file-fsync-atomic-rename-parent-fsync',
  });
  appendIfMissing(request.paths.followupPath, request.epochId, 'final-step-timestamp-recorded', { observedAt: new Date().toISOString() });
  const observation = await boundary.observeFinalHealthAndDelivery(request, core, supervisor);
  appendIfMissing(request.paths.followupPath, request.epochId, 'final-health-delivery-observed', observation);
  appendIfMissing(request.paths.followupPath, request.epochId, 'activation-complete', { recovered: true });
  return { result: 'forward-repair-ready', epochId: request.epochId, nonce: cordon.nonce, ...supervisor };
}
