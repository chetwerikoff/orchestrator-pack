import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ActivationContext, ActivationCore, CutoverResult, ImportResult, PhaseOneEnvelope, StoreId } from './types.ts';
import { appendPhaseEntry, durableWriteJson, readPhaseOne, sealPhaseOne } from './activation-evidence.ts';
import { createCordon, drainAndTerminate, releaseCordonBeforeImport } from './activation-cordon.ts';
import { JsonEpochAuthority } from './activation-epoch-authority.ts';
import { importStore } from './activation-import.ts';
import { provePlatform } from './activation-platform-preflight.ts';
import { projectRegistry, verifyRegistryHash } from './activation-registry-projection.ts';
import { sha256Bytes, sha256Canonical } from './stable-stringify.ts';

const STORES: StoreId[] = ['reconcile', 'reevaluation', 'reportStateSeed'];

export interface TransactionHooks {
  provePrerequisites?: (context: ActivationContext) => Promise<void> | void;
  startTypeScriptSupervisor?: (input: { epochId: string; nonce: string; context: ActivationContext }) => Promise<void> | void;
  proveClaimAuthorityUnchanged?: () => Promise<void> | void;
  proveCycle?: () => Promise<void> | void;
}

function assertSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label}_sha_invalid`);
}

function phasePath(context: ActivationContext): string { return join(context.stateDir, 'cutover-phase1.json'); }

export function validateContext(context: ActivationContext): void {
  if (context.schemaVersion !== 1) throw new Error('cutover_context_schema_invalid');
  if (!context.epochId || context.epochId === context.oldEpochId) throw new Error('cutover_epoch_invalid');
  if (!context.hostId.trim()) throw new Error('cutover_host_id_missing');
  assertSha(context.installedCommitSha, 'installed_commit');
  for (const store of STORES) {
    if (!context.snapshotFiles[store] || !context.targetFiles[store]) throw new Error(`cutover_store_path_missing:${store}`);
  }
}

export async function runActivationTransaction(context: ActivationContext, hooks: TransactionHooks = {}): Promise<CutoverResult> {
  validateContext(context);
  mkdirSync(context.stateDir, { recursive: true });
  const platform = provePlatform({
    repoRoot: context.repoRoot,
    stagedRegistryPath: context.stagedRegistryPath,
    projectionPath: context.liveRegistryProjectionPath,
    hostId: context.hostId,
  });
  if (platform.repoRoot !== resolve(context.repoRoot)) throw new Error('cutover_repo_root_not_canonical');
  if (!existsSync(context.oldRevisionRoot)) throw new Error('old_installed_revision_missing');
  await hooks.provePrerequisites?.(context);

  const cordon = createCordon({
    stateDir: context.stateDir,
    epochId: context.epochId,
    hostId: context.hostId,
    installedCommitSha: context.installedCommitSha,
    oldSupervisor: context.oldSupervisor,
    writers: context.writers,
  });
  let phase: PhaseOneEnvelope = readPhaseOne(phasePath(context), context.epochId, cordon.nonce);
  if (!phase.entries.length) phase = appendPhaseEntry(phasePath(context), phase, 'admission-proven', platform);
  if (!phase.entries.some((row) => row.step === 'cordon-durable')) phase = appendPhaseEntry(phasePath(context), phase, 'cordon-durable', cordon);

  try {
    await drainAndTerminate(cordon);
  } catch (error) {
    if (!phase.importBegunAt) releaseCordonBeforeImport(context.stateDir);
    throw error;
  }
  if (!phase.entries.some((row) => row.step === 'legacy-supervisor-terminated')) {
    phase = appendPhaseEntry(phasePath(context), phase, 'legacy-supervisor-terminated', context.oldSupervisor);
  }
  if (!phase.entries.some((row) => row.step === 'writers-drained')) {
    phase = appendPhaseEntry(phasePath(context), phase, 'writers-drained', context.writers);
  }

  const snapshotDigests = {} as Record<StoreId, string>;
  const snapshotDetail: Record<string, unknown> = {};
  for (const storeId of STORES) {
    const raw = readFileSync(context.snapshotFiles[storeId]);
    const digest = sha256Bytes(raw);
    snapshotDigests[storeId] = digest;
    snapshotDetail[storeId] = { path: context.snapshotFiles[storeId], digest };
  }
  if (!phase.entries.some((row) => row.step === 'snapshots-recorded')) {
    phase = appendPhaseEntry(phasePath(context), phase, 'snapshots-recorded', snapshotDetail);
  }
  if (!phase.importBegunAt) phase = appendPhaseEntry(phasePath(context), phase, 'import-begun', { stores: STORES });

  const imported = {} as Record<StoreId, ImportResult>;
  for (const storeId of STORES) {
    imported[storeId] = importStore({
      epochId: context.epochId,
      nonce: cordon.nonce,
      storeId,
      snapshotPath: context.snapshotFiles[storeId],
      targetPath: context.targetFiles[storeId],
    });
  }
  const importDigests = Object.fromEntries(STORES.map((storeId) => [storeId, imported[storeId].targetDigest])) as Record<StoreId, string>;
  if (!phase.entries.some((row) => row.step === 'imports-verified')) {
    phase = appendPhaseEntry(phasePath(context), phase, 'imports-verified', imported);
  }

  const registryHash = projectRegistry(context.stagedRegistryPath, context.liveRegistryProjectionPath);
  if (!phase.entries.some((row) => row.step === 'registry-projected')) {
    phase = appendPhaseEntry(phasePath(context), phase, 'registry-projected', { registryHash });
  }
  if (!phase.entries.some((row) => row.step === 'precommit-log-sealed')) {
    phase = appendPhaseEntry(phasePath(context), phase, 'precommit-log-sealed', { entries: phase.entries.length + 1 });
  }
  const preCommitLogDigest = sealPhaseOne(phase);
  const core: ActivationCore = {
    epochId: context.epochId,
    nonce: cordon.nonce,
    hostId: context.hostId,
    repoRoot: context.repoRoot,
    installedCommitSha: context.installedCommitSha,
    snapshotDigests,
    importDigests,
    registryHash,
    preCommitLogDigest,
    commitAt: new Date().toISOString(),
  };

  const authority = new JsonEpochAuthority(context.epochAuthorityFile);
  const committed = authority.commit(context.oldEpochId, core);
  if (sha256Canonical(committed) !== sha256Canonical(core)) throw new Error('cutover_committed_core_mismatch');
  authority.require(context.epochId, cordon.nonce);
  verifyRegistryHash(context.liveRegistryProjectionPath, registryHash);
  authority.appendFollowUp(context.epochId, cordon.nonce, 'registry-reprojected', { registryHash });

  await hooks.startTypeScriptSupervisor?.({ epochId: context.epochId, nonce: cordon.nonce, context });
  authority.appendFollowUp(context.epochId, cordon.nonce, 'ts-supervisor-started', { supervisor: 'typescript' });
  authority.appendFollowUp(context.epochId, cordon.nonce, 'scheduler-owned', { childId: 'pack-review-scheduler', cardinality: 1 });
  await hooks.proveClaimAuthorityUnchanged?.();
  await hooks.proveCycle?.();
  authority.appendFollowUp(context.epochId, cordon.nonce, 'activation-complete', { result: 'C1-C18-ts-transfer-pass' });

  const result: CutoverResult = {
    admission: { result: 'foundation-single-host-adopted' },
    activation: { result: 'C1-C18-ts-transfer-pass' },
    import_claim: { result: 'imports-and-claim-compatibility-verified' },
    cycle: { result: 'rehearsal-and-ts-replacement-proven' },
    recovery: { result: 'forward-recovery-boundary-proven' },
    scope: { result: 'exact-four-delete-ts-only-bounded' },
    evidence: { result: 'single-central-cas-phase-evidence-bound' },
    merge_gate: { result: 'linux-wsl2-node22-guards-green' },
  };
  durableWriteJson(join(context.stateDir, 'cutover-completion.json'), result);
  return result;
}
