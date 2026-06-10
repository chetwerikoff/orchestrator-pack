export type ReadKind = 'file' | 'diff' | 'log';

export type ReadEntry = {
  path?: string;
  lines: number;
  kind: ReadKind;
  isCodeClass?: boolean;
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
};

export type SessionContext = {
  surface: 'cursor' | 'claude';
  reviewerPath?: boolean;
  env?: Record<string, string | undefined>;
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
  codeClass: boolean;
  selfAttestedDelegation: boolean;
  machineObservedDelegation: boolean;
  exceptedReason: boolean;
  editExempt: boolean;
};

export declare const T1_VOLUME_FLOOR: 400;
export declare const DIFF_LOG_FLOOR: 200;
export declare const T2_MIN_FILES: 3;
export declare const SURFACES: readonly ['cursor', 'claude'];

export declare function normalizeReads(value: unknown): ReadEntry[];
export declare function aggregateDelegableFileLines(reads: ReadEntry[]): number;
export declare function aggregateDiffLogLines(reads: ReadEntry[]): number;
export declare function countDelegableFiles(reads: ReadEntry[]): number;
export declare function didAskTriggerFire(reads: ReadEntry[]): TriggerDetail;
export declare function isReviewerPathSession(session: SessionContext): boolean;
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
export declare function summarizeAuditVerdicts(verdicts: AuditVerdict[]): {
  delegableTriggerUnits: number;
  flaggedUnits: number;
  flaggedReadLines: number;
  residualNonCompliance: number;
};
export declare function readMetricEventIds(artifactPath: string): Set<string>;
export declare function appendMetricRecord(
  artifactPath: string,
  record: Record<string, unknown>,
): { appended: boolean; duplicate: boolean; artifactPath: string };
export declare function loadMetricWindowSummary(artifactPath: string): Record<string, unknown>;
export declare function evaluateStopAudit(payload: Record<string, unknown>): Record<string, unknown>;
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
export declare function resolveAuditArtifactDefaultPath(): string;
