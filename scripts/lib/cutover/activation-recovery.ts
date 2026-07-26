import { existsSync } from 'node:fs';
import { FileEpochAuthority } from './activation-epoch-authority.ts';
import { fileDigestOrAbsent, readCordon } from './activation-cordon.ts';
import { appendFollowup, verifyPhaseOneDigest } from './activation-evidence.ts';
import { projectRegistry } from './activation-registry-projection.ts';
import type { ActivationRequest } from './types.ts';

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

export function recoverCommittedCutover(request: ActivationRequest): { result: 'forward-repair-ready'; epochId: string; nonce: string } {
  if (!existsSync(request.paths.cordonPath)) throw new Error('cordon_missing');
  const cordon = readCordon(request.paths.cordonPath);
  if (!cordon.importBegunAt) throw new Error('commit_recovery_before_import_boundary');
  const authority = new FileEpochAuthority(request.paths.epochAuthorityPath);
  const core = authority.verify(request.epochId, cordon.nonce);
  verifyPhaseOneDigest(request.paths.phaseOnePath, request.epochId, cordon.nonce, core.preCommitLogDigest);
  const projection = projectRegistry(request.paths.targetRegistryPath, request.paths.projectedRegistryPath);
  if (projection.registryHash !== core.registryHash) throw new Error('recovery_registry_hash_mismatch');
  appendFollowup(request.paths.followupPath, request.epochId, 'recovery-registry-reprojected', projection);
  return { result: 'forward-repair-ready', epochId: request.epochId, nonce: cordon.nonce };
}
