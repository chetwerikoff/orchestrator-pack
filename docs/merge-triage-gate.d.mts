export declare const TRIAGE_SCHEMA_VERSION: number;
export declare const TERMINAL_AT_CAP_OPEN_FINDINGS: string;
export declare const TERMINAL_CLEAN_EARLY_STOP: string;
export declare const TERMINAL_MERGE_TRIAGE_CLEARED: string;
export declare const VERDICT_BLOCK: string;
export declare const VERDICT_DEFER: string;
export declare const VERDICT_PENDING_ARCHITECT: string;
export declare const VERDICT_PENDING_OPERATOR: string;
export declare const VERDICT_ACK_RESET: string;
export declare const DEFAULT_MARKER_FILE: string;

export interface MergeTriageFinding {
  id?: string;
  fingerprint?: string;
  title?: string;
  body?: string;
  details?: string;
  category?: string;
  type?: string;
  status?: string;
  headSha?: string;
  head_sha?: string;
  targetSha?: string;
  runId?: string;
}

export interface MergeTriageClassification {
  findingId: string;
  fingerprint: string;
  verdict: string;
  reason: string;
  normalizedText: string;
  normalizedTextHash: string;
  matchedBlockMarkers: string[];
  matchedDeferMarkers: string[];
  matchedMarkers: string[];
  conditionalVeto: boolean;
}

export interface MergeTriageClearance {
  schema_version: number;
  terminal: string;
  pr_number: number;
  head_sha: string;
  source_terminal_ref?: Record<string, unknown> | null;
  gate_run_id: string;
  marker_list_version: number;
  marker_list_hash: string;
  open_findings_snapshot_hash: string;
  emitted_at_utc?: string;
  cleared_at_utc?: string;
}

export interface MergeTriageGateResult {
  ok: boolean;
  ran: boolean;
  reason?: string;
  aggregate?: string;
  gateRunId?: string;
  classifications?: MergeTriageClassification[];
  clearance?: MergeTriageClearance | null;
  pendingArchitect?: Array<Record<string, unknown>>;
  blockDelivery?: Array<Record<string, unknown>>;
  catalogPath?: string;
}

export interface MergePolicyResult {
  allow: boolean;
  reason: string;
}

export declare function sha256(value: unknown): string;
export declare function normalizeTriageText(value: unknown): string;
export declare function buildFindingText(finding: MergeTriageFinding): string;
export interface MergeTriageMarkerList {
  schemaVersion: number;
  blockMarkers: string[];
  deferMarkers: string[];
  conditionalQualifierStems: string[];
  unconditionalBlockMarkers: string[];
  denylistPathMarkers: string[];
  markerListHash: string;
  markerFile: string;
}

export declare function loadMarkerList(markerFile?: string): MergeTriageMarkerList;
export declare function classifyFinding(
  finding: MergeTriageFinding,
  markerList?: Record<string, unknown>,
): MergeTriageClassification;
export declare function resolveStateRoot(input?: Record<string, unknown>): string;
export declare function ensureDir(dir: string): void;
export declare function readPackFindingStore(input?: {
  projectPath?: string;
  prNumber?: number;
  headSha?: string;
}): MergeTriageFinding[];
export declare function computeOpenFindingsSnapshotHash(
  findings: MergeTriageFinding[],
  classifications?: MergeTriageClassification[] | null,
): string;
export declare function runMergeTriageGate(input?: Record<string, unknown>): MergeTriageGateResult;
export declare function evaluateMergePolicy(input?: Record<string, unknown>): MergePolicyResult;
export declare function readArchitectInbox(input?: Record<string, unknown>): {
  pending: Array<Record<string, unknown>>;
};
export declare function issueArchitectProvenanceToken(input?: Record<string, unknown>): Record<string, unknown>;
export declare function fileWorkerAppeal(input?: Record<string, unknown>): Record<string, unknown>;
export declare function adjudicateArchitectFinding(input?: Record<string, unknown>): Record<string, unknown>;
export declare function acknowledgeArchitectPermissiveBudget(input?: Record<string, unknown>): Record<string, unknown>;
