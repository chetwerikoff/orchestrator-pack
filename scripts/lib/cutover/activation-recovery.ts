import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../../kernel/subprocess.ts';
import { FileEpochAuthority } from './activation-epoch-authority.ts';
import { fileDigestOrAbsent, processAlive, readCordon } from './activation-cordon.ts';
import { appendFollowup, verifyPhaseOneDigest } from './activation-evidence.ts';
import { projectRegistry } from './activation-registry-projection.ts';
import type { FollowupRecord, ActivationRequest } from './types.ts';
import { readSupervisorStatus } from '../orchestrator-side-process-supervisor.ts';

export interface RecoveryBoundary {
  ensureTypeScriptSupervisor(request: ActivationRequest, nonce: string): Promise<{ supervisorPid: number; childGeneration: number }>;
}

export function provePreImportRollbackSafe(request: ActivationRequest): { safe: true; result: 'pre-import-old-revision-restorable' } {
  const cordon = readCordon(request.paths.cordonPath);
  if (cordon.importBegunAt) throw new Error('forward_only_recovery_required');
  for (const store of request.stores) {
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

function readySupervisorStatus(request: ActivationRequest, nonce: string): { supervisorPid: number; childGeneration: number } | null {
  const status = readSupervisorStatus({ stateDir: request.paths.supervisorStateDir });
  if (
    status
    && status.epochId === request.epochId
    && status.nonce === nonce
    && status.restartState === 'running'
    && processAlive(status.supervisorPid)
    && status.registryHash
    && status.childPid !== null
    && processAlive(status.childPid)
    && status.childGeneration >= 1
  ) {
    return { supervisorPid: status.supervisorPid, childGeneration: status.childGeneration };
  }
  return null;
}

async function waitForSupervisor(request: ActivationRequest, nonce: string): Promise<{ supervisorPid: number; childGeneration: number }> {
  const deadline = Date.now() + 10_000;
  do {
    const status = readSupervisorStatus({ stateDir: request.paths.supervisorStateDir });
    if (status?.restartState === 'refused') throw new Error(`recovery_supervisor_refused:${status.refusalReason ?? 'unknown'}`);
    const ready = readySupervisorStatus(request, nonce);
    if (ready) return ready;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('recovery_supervisor_not_ready');
}

export const productionRecoveryBoundary: RecoveryBoundary = {
  ensureTypeScriptSupervisor: async (request, nonce) => {
    const ready = readySupervisorStatus(request, nonce);
    if (ready) return ready;
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
};

export async function recoverCommittedCutover(
  request: ActivationRequest,
  boundary: RecoveryBoundary = productionRecoveryBoundary,
): Promise<{ result: 'forward-repair-ready'; epochId: string; nonce: string; supervisorPid: number; childGeneration: number }> {
  if (!existsSync(request.paths.cordonPath)) throw new Error('cordon_missing');
  const cordon = readCordon(request.paths.cordonPath);
  if (!cordon.importBegunAt) throw new Error('commit_recovery_before_import_boundary');
  const authority = new FileEpochAuthority(request.paths.epochAuthorityPath);
  const core = authority.verify(request.epochId, cordon.nonce);
  verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);
  const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);
  if (projection.registryHash !== core.registryHash) throw new Error('recovery_registry_hash_mismatch');
  appendIfMissing(request.paths.followupPath, request.epochId, 'committed-registry-reprojected', projection);
  const supervisor = await boundary.ensureTypeScriptSupervisor(request, cordon.nonce);
  appendIfMissing(request.paths.followupPath, request.epochId, 'typescript-supervisor-started', { supervisorPid: supervisor.supervisorPid });
  appendIfMissing(request.paths.followupPath, request.epochId, 'scheduler-owned', { supervisorPid: supervisor.supervisorPid, childGeneration: supervisor.childGeneration });
  appendIfMissing(request.paths.followupPath, request.epochId, 'activation-complete', { recovered: true });
  return { result: 'forward-repair-ready', epochId: request.epochId, nonce: cordon.nonce, ...supervisor };
}
