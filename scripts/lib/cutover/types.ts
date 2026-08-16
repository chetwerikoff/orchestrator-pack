export type CutoverStoreId = 'reconcile' | 'reevaluation' | 'reportStateSeed';

export interface ProcessIdentity {
  pid: number;
  startTicks: string;
  cmdline: string[];
}

export interface CutoverStoreSpec {
  id: CutoverStoreId;
  sourcePath: string;
  targetPath: string;
  coveredFields: readonly string[];
}

export interface SnapshotRecord {
  storeId: CutoverStoreId;
  snapshotPath: string;
  snapshotDigest: string;
  sourceVersion: number;
  writerWatermark: string;
  sourceState: 'present' | 'absent';
}

export interface ImportRecord {
  storeId: CutoverStoreId;
  importIdentity: string;
  snapshotDigest: string;
  importTargetDigest: string;
  markerPath: string;
  sourceState: 'present' | 'absent';
}

export interface PhaseRecord {
  sequence: number;
  step: string;
  completedAt: string;
  detailDigest: string;
}

export interface PhaseOneEnvelope {
  schemaVersion: 1;
  epochId: string;
  nonce: string;
  records: PhaseRecord[];
}

export interface EpochCommitCore {
  epochId: string;
  nonce: string;
  hostId: string;
  repoRoot: string;
  installedCommitSha: string;
  snapshotDigests: Record<CutoverStoreId, string>;
  importDigests: Record<CutoverStoreId, string>;
  registryHash: string;
  preCommitLogDigest: string;
  commitAt: string;
}

export interface EpochAuthorityDocument {
  schemaVersion: 1;
  currentEpochId: string | null;
  records: EpochCommitCore[];
}

export interface FollowupRecord extends PhaseRecord {
  epochId: string;
}

export interface TypeScriptSupervisorInertProof {
  result: 'typescript-supervisor-inert';
  statusObserved: boolean;
  supervisorAlive: false;
  childAlive: false;
}

export interface CutoverRecoveryBindings {
  expectedOldEpochId: string | null;
  phaseOnePath: string;
  followupPath: string;
  epochAuthorityPath: string;
  targetRegistryPath: string;
  projectedRegistryPath: string;
  snapshotDir: string;
  supervisorStateDir: string;
  stores: CutoverStoreSpec[];
}

export interface CordonPreparedRecord {
  schemaVersion: 1;
  state: 'preparing';
  epochId: string;
  nonce: string;
  hostId: string;
  repoRoot: string;
  installedCommitSha: string;
  oldInstalledRevisionRoot: string;
  legacySupervisor: ProcessIdentity | null;
  startedAt: string;
  typescriptSupervisorInert: TypeScriptSupervisorInertProof;
  importBegunAt: null;
  preImportTargetDigests: Partial<Record<CutoverStoreId, string>>;
  recoveryBindings: CutoverRecoveryBindings;
}

export interface CordonRecord {
  schemaVersion: 1;
  state: 'active';
  epochId: string;
  nonce: string;
  hostId: string;
  repoRoot: string;
  installedCommitSha: string;
  oldInstalledRevisionRoot: string;
  legacySupervisor: ProcessIdentity | null;
  startedAt: string;
  writersClosed: true;
  noRespawn: true;
  noTypeScriptStart: true;
  typescriptSupervisorInert: TypeScriptSupervisorInertProof;
  importBegunAt: string | null;
  preImportTargetDigests: Partial<Record<CutoverStoreId, string>>;
  recoveryBindings: CutoverRecoveryBindings;
}

export type CordonState = CordonPreparedRecord | CordonRecord;

export interface FoundationHeartbeatEvidence {
  hostId: string;
  installedCommitSha: string;
  observedAt: string;
  active: boolean;
  quarantined?: boolean;
}

export interface FoundationInertObservation {
  registryChanged: boolean;
  supervisorChanged: boolean;
  schedulerRegistered: boolean;
  schedulerRunning: boolean;
  schedulerClaimAcquirer: boolean;
  activationEpochEnforced: boolean;
  liveStoreOpened: boolean;
  legacyStarterDisabled: boolean;
  nonNotificationRuntimeDelta: boolean;
  notificationTypedConfigLive: boolean;
  dormantTypedConfigReaderLive: boolean;
}

export interface GreenfieldFoundationObservation {
  mode: 'greenfield-observed';
  stateRoot: string;
  foundationConfigPath: string;
  foundationConfigPresent: false;
  appStatePath: string;
  appStatePresent: false;
  committedMigrationJournalPaths: [];
  controlPlane: {
    epochAuthorityPath: string;
    epochAuthorityCurrentEpochId: null;
    epochAuthorityRecordCount: 0;
    supervisorStatusPath: string;
    supervisorStatusPresent: boolean;
    supervisorAlive: false;
    childAlive: false;
    singleInstanceLeasePath: string;
    singleInstanceLeasePresent: false;
    legacyWriterCount: 0;
    legacySupervisorCount: 0;
    typescriptSupervisorCount: 0;
    observedHostId: string;
  };
}

export interface FoundationPreflightBase {
  command: 'a\u006f session ls --json';
  sessions: unknown[];
  sanitizerId: string;
}

export interface FoundationArtifactPreflight extends FoundationPreflightBase {
  appStateVersion: string;
}

export interface FoundationRuntimeAdapterPreflight {
  kind: 'runtime-adapter';
  adapterId: string;
  readiness: {
    ready: true;
    workspacePath: string;
    headSha?: string;
    linkedIssue?: number | null;
  };
  observationId: string;
}

export type FoundationPreflight = FoundationArtifactPreflight | FoundationPreflightBase | FoundationRuntimeAdapterPreflight;

export interface FoundationAdmissionEvidence {
  schemaVersion: 1;
  issue: 923;
  foundationMergeCommitSha: string;
  producer: 'orchestrator-pack:foundation-adoption-producer';
  observationDigest: string;
  preflight: FoundationPreflight;
  typedConfig: unknown;
  migrationJournalPaths: string[];
  runtimeCatalog: unknown[];
  inertProof: {
    result: string;
    observations: FoundationInertObservation;
  };
  heartbeats: FoundationHeartbeatEvidence[];
  greenfieldObservation?: GreenfieldFoundationObservation;
}

export interface ActivationPaths {
  stateDir: string;
  cordonPath: string;
  phaseOnePath: string;
  followupPath: string;
  epochAuthorityPath: string;
  targetRegistryPath: string;
  projectedRegistryPath: string;
  snapshotDir: string;
  supervisorStateDir: string;
  foundationEvidencePath: string;
}

export interface ActivationRequest {
  epochId: string;
  expectedOldEpochId: string | null;
  hostId: string;
  repoRoot: string;
  installedCommitSha: string;
  oldInstalledRevisionRoot: string;
  legacySupervisorPid?: number | null;
  knownMemberRoster: Array<{
    hostId: string;
    quarantined?: boolean;
  }>;
  stores: CutoverStoreSpec[];
  paths: ActivationPaths;
}

export interface SchedulerRegistryChild {
  id: 'pr2-scheduler';
  runtime: 'node';
  script: 'pr2-foundation/scheduler.ts';
  sideEffecting: true;
  cadenceSeconds: number;
}

export interface SchedulerRegistry {
  schemaVersion: 2;
  requiredChildIds: ['pr2-scheduler'];
  children: [SchedulerRegistryChild];
}
