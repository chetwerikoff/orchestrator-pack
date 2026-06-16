export type ReadKind = 'file' | 'diff' | 'log' | 'external' | 'fetched';

export type ReadEntry = {
  path?: string;
  lines: number;
  kind: ReadKind;
  isCodeClass?: boolean;
  fenceSignal?: boolean;
  capturedCommit?: string;
  classifierManifestHash?: string;
  surface?: string;
  readDiscriminator?: string;
  canonicalPath?: string;
  unitKey?: string;
};

export type ReadClassificationResult = {
  read: ReadEntry;
  classification: string;
  exclusionRecord?: Record<string, unknown>;
  delegable: boolean;
  excludedFromDenominator: boolean;
};

export type AuditBlockingFailure = {
  status: string;
  artifact?: Record<string, unknown>;
};

export type EditEntry = {
  path?: string;
};

export type CoworkerEvent = {
  kind: 'coworker_ask' | 'ask';
  profile?: string;
};

export type WorkUnit = {
  key: string;
  inboundRequestId: string;
  reads: ReadEntry[];
  edits?: EditEntry[];
  shellCommands?: string[];
  coworkerEvents?: CoworkerEvent[];
  statusText?: string;
  codeClassGated?: boolean;
  capturedCommit?: string;
  classifierManifestHash?: string;
};

export type ReviewSignal = {
  present?: boolean;
  isReviewExecution?: boolean;
  kind?: string;
  source?: string;
};

export type HookWiringFingerprint = {
  wrapper?: string;
  wrapperHash?: string;
  commandShape?: string;
};

export type SessionContext = {
  surface: 'cursor' | 'claude';
  reviewerPath?: boolean;
  env?: Record<string, string | undefined>;
  reviewSignal?: ReviewSignal;
  hookWiringFingerprint?: HookWiringFingerprint;
  checkoutCommit?: string;
  trackedPathsOverride?: Set<string>;
};

export type TriggerDetail = {
  fired: boolean;
  t1: boolean;
  t2: boolean;
  diffLog: boolean;
  fileLines: number;
  fileCount: number;
  diffLogLines: number;
};

export type AuditVerdict = {
  workUnitKey: string;
  inboundRequestId: string;
  surface: string;
  triggerFired: boolean;
  excludedFromDenominator: boolean;
  inDenominator: boolean;
  flagged: boolean;
  trigger: TriggerDetail;
  reviewerPath: boolean;
  reviewSignalState?: string;
  auditSchemaVersion?: number;
  hookWiringFingerprint?: HookWiringFingerprint;
  codeClass: boolean;
  allIndexServed?: boolean;
  readClassifications?: ReadClassificationResult[];
  indexServedExcludedLines?: number;
  blockingFailure?: AuditBlockingFailure;
  selfAttestedDelegation: boolean;
  machineObservedDelegation: boolean;
  exceptedReason: boolean;
  editExempt: boolean;
};

export declare const T1_VOLUME_FLOOR: 400;
export declare const DIFF_LOG_FLOOR: 200;
export declare const T2_MIN_FILES: 3;
export declare const SURFACES: readonly ['cursor', 'claude'];
export declare const AUDIT_SCHEMA_VERSION: 3;
export declare const REVIEW_HOOK_CAPABILITY_RECORD_PATH: string;

export type CapturedReadEntry = ReadEntry;

export declare function normalizeReads(value: unknown): ReadEntry[];
export declare function aggregateDelegableFileLines(reads: ReadEntry[]): number;
export declare function aggregateDiffLogLines(reads: ReadEntry[]): number;
export declare function countDelegableFiles(reads: ReadEntry[]): number;
export declare function didAskTriggerFire(reads: ReadEntry[]): TriggerDetail;
export declare function normalizeReviewSignal(value: unknown): { present: boolean; source: string; trusted: boolean; undecidable: boolean };
export declare function isReviewerPathSession(session: SessionContext): boolean;
export declare function reviewMarkerState(session: SessionContext): string;
export declare function isCodeClassUnit(unit: WorkUnit): boolean;
export declare function hasExceptedReason(statusText: string | undefined): boolean;
export declare function hasSelfAttestedDelegation(unit: WorkUnit): boolean;
export declare function hasMachineObservedDelegation(unit: WorkUnit): boolean;
export declare function hasEditInUnit(unit: WorkUnit): boolean;
export declare function auditWorkUnit(unit: WorkUnit, session: SessionContext): AuditVerdict;
export declare function auditWorkUnits(
  units: WorkUnit[],
  session: SessionContext,
): AuditVerdict[];
export declare function partitionEventsIntoWorkUnits(
  events: Array<Record<string, unknown>>,
): WorkUnit[];
export declare function computeDenominatorCause(verdicts: AuditVerdict[]): string;
export declare function summarizeAuditVerdicts(verdicts: AuditVerdict[]): {
  delegableTriggerUnits: number;
  flaggedUnits: number;
  flaggedReadLines: number;
  residualNonCompliance: number;
  denominatorCause: string;
  denominatorEmptyCause?: string;
};
export declare function readMetricEventIds(artifactPath: string): Set<string>;
export declare function appendMetricRecord(
  artifactPath: string,
  record: Record<string, unknown>,
): { appended: boolean; duplicate: boolean; artifactPath: string };
export declare function currentAuditCodeHashes(): Record<string, string>;
export declare function currentHookWiringFingerprint(): HookWiringFingerprint;
export declare function loadReviewHookCapability(recordPath?: string): Record<string, unknown>;
export declare function loadMetricWindowSummary(artifactPath: string, options?: { capabilityRecordPath?: string }): Record<string, unknown>;
export declare function evaluateStopAudit(
  payload: Record<string, unknown>,
  options?: { skipPopulate?: boolean },
): Record<string, unknown>;
export declare function runStopAudit(payload: Record<string, unknown>): Record<string, unknown>;
export declare function normalizeStopHookPayload(
  hookPayload: Record<string, unknown>,
): Record<string, unknown>;
export declare function isCodeClassPath(filePath: string | undefined): boolean;
export declare function countTextLines(text: string): number;
export declare function countFileLinesFromDisk(
  filePath: string,
  offset?: number,
  limit?: number,
): number;
export declare function normalizeShellCommandForAudit(command: string): string;
export declare function matchesCoworkerAskCommand(command: string): boolean;
export declare function resolveReadToolPath(input: Record<string, unknown>): string | undefined;
export declare function measureReadToolLines(
  input: Record<string, unknown>,
  capturedOutput?: unknown,
): number;
export declare function extractToolResultText(value: unknown): string;
export declare function measureShellDiffLogLines(command: string, capturedOutput?: unknown): number;
export declare function isInboundUserRequest(record: unknown): boolean;
export declare function buildTranscriptToolResultIndex(
  records: Array<Record<string, unknown>>,
): Map<string, string>;
export declare function parseTranscriptJsonl(transcriptPath: string): Array<Record<string, unknown>>;
export declare function toolUseToAuditEvents(
  toolName: string,
  input: Record<string, unknown>,
  inboundRequestId: string,
  options?: { shellOutput?: unknown; toolOutput?: unknown },
): Array<Record<string, unknown>>;
export declare function extractEventsFromTranscriptRecords(
  records: Array<Record<string, unknown>>,
  options?: {
    generationId?: string;
    conversationId?: string;
    statusText?: string;
    workUnitIndex?: number;
  },
): {
  events: Array<Record<string, unknown>>;
  workUnits: WorkUnit[];
  eventId?: string;
  workUnitKey?: string;
};
export declare function extractEventsFromTranscript(
  transcriptPath: string,
  options?: {
    generationId?: string;
    conversationId?: string;
    statusText?: string;
    workUnitIndex?: number;
  },
): {
  events: Array<Record<string, unknown>>;
  workUnits: WorkUnit[];
  eventId?: string;
  workUnitKey?: string;
};
export declare function populateStopAuditPayload(
  rawPayload: Record<string, unknown>,
): Record<string, unknown>;
export declare function resolveAuditWorkUnits(
  payload: Record<string, unknown>,
): WorkUnit[];
export declare function resolveAuditArtifactDefaultPath(): string;
