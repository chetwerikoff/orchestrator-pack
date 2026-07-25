export const CUTOVER_SCHEMA_VERSION = 1 as const;

export type StoreId = 'reconcile' | 'reevaluation' | 'reportStateSeed';
export type CutoverStep =
  | 'admission-proven'
  | 'cordon-durable'
  | 'legacy-supervisor-terminated'
  | 'writers-drained'
  | 'snapshots-recorded'
  | 'import-begun'
  | 'imports-verified'
  | 'registry-projected'
  | 'precommit-log-sealed';

export interface ProcessIdentity {
  pid: number;
  startTime: string;
  role: string;
}

export interface ActivationContext {
  schemaVersion: typeof CUTOVER_SCHEMA_VERSION;
  epochId: string;
  oldEpochId: string;
  hostId: string;
  repoRoot: string;
  installedCommitSha: string;
  oldRevisionRoot: string;
  stateDir: string;
  epochAuthorityFile: string;
  stagedRegistryPath: string;
  liveRegistryProjectionPath: string;
  oldSupervisor: ProcessIdentity;
  writers: ProcessIdentity[];
  snapshotFiles: Record<StoreId, string>;
  targetFiles: Record<StoreId, string>;
}

export interface PhaseEntry {
  sequence: number;
  step: CutoverStep;
  completedAt: string;
  detailDigest: string;
}

export interface PhaseOneEnvelope {
  schemaVersion: typeof CUTOVER_SCHEMA_VERSION;
  epochId: string;
  nonce: string;
  entries: PhaseEntry[];
  importBegunAt?: string;
}

export interface ActivationCore {
  epochId: string;
  nonce: string;
  hostId: string;
  repoRoot: string;
  installedCommitSha: string;
  snapshotDigests: Record<StoreId, string>;
  importDigests: Record<StoreId, string>;
  registryHash: string;
  preCommitLogDigest: string;
  commitAt: string;
}

export interface ActivationFollowUp {
  epochId: string;
  sequence: number;
  step: string;
  completedAt: string;
  detailDigest: string;
}

export interface EpochDocument {
  schemaVersion: typeof CUTOVER_SCHEMA_VERSION;
  currentEpochId: string;
  coreByEpoch: Record<string, ActivationCore>;
  followUpsByEpoch: Record<string, ActivationFollowUp[]>;
}

export interface RegistryChild {
  id: string;
  script: string;
  sideEffecting: boolean;
  sideEffectLockFile?: string;
  requiresOrchestratorSession: boolean;
  passProjectId: boolean;
  cadenceSeconds: number;
  stallGraceMultiplier: number;
  extraArgs?: string[];
}

export interface SchedulerRegistry {
  schemaVersion: 1;
  requiredChildIds: string[];
  children: RegistryChild[];
}

export interface ImportResult {
  storeId: StoreId;
  snapshotDigest: string;
  importIdentity: string;
  targetDigest: string;
}

export interface CutoverResult {
  admission: { result: 'foundation-single-host-adopted' };
  activation: { result: 'C1-C18-ts-transfer-pass' };
  import_claim: { result: 'imports-and-claim-compatibility-verified' };
  cycle: { result: 'rehearsal-and-ts-replacement-proven' };
  recovery: { result: 'forward-recovery-boundary-proven' };
  scope: { result: 'exact-four-delete-ts-only-bounded' };
  evidence: { result: 'single-central-cas-phase-evidence-bound' };
  merge_gate: { result: 'linux-wsl2-node22-guards-green' };
}
