import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivationCore, PhaseOneEnvelope } from './types.ts';
import { JsonEpochAuthority } from './activation-epoch-authority.ts';
import { sealPhaseOne } from './activation-evidence.ts';
import { verifyRegistryHash } from './activation-registry-projection.ts';

export type RecoveryDisposition = 'pre-import-rollback-allowed' | 'forward-only-pre-cas' | 'forward-only-post-cas' | 'complete';

export function recoveryDisposition(stateDir: string, epochAuthorityFile: string, epochId: string, nonce: string): RecoveryDisposition {
  const phasePath = join(stateDir, 'cutover-phase1.json');
  const phase = existsSync(phasePath) ? JSON.parse(readFileSync(phasePath, 'utf8')) as PhaseOneEnvelope : null;
  const authority = new JsonEpochAuthority(epochAuthorityFile);
  const core = authority.get(epochId);
  if (!phase?.importBegunAt && !core) return 'pre-import-rollback-allowed';
  if (!core) return 'forward-only-pre-cas';
  if (core.nonce !== nonce) throw new Error('recovery_nonce_mismatch');
  if (!phase) throw new Error('recovery_phase1_missing');
  if (sealPhaseOne(phase) !== core.preCommitLogDigest) throw new Error('recovery_precommit_digest_mismatch');
  const required = ['registry-reprojected', 'ts-supervisor-started', 'scheduler-owned'];
  const seen = new Set(authority.followUps(epochId).map((row) => row.step));
  return required.every((step) => seen.has(step)) ? 'complete' : 'forward-only-post-cas';
}

export function verifyCommittedProjection(core: ActivationCore, path: string): void {
  verifyRegistryHash(path, core.registryHash);
}
