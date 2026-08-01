export const JOURNAL_MARKER_PREFIX = 'opk-create-issue-journal';

export const CYCLE_SCHEMA = 'create-issue-review-cycle/v1' as const;
export const STAGE_SCHEMA = 'create-issue-stage-record/v1' as const;
export const FINAL_SCHEMA = 'create-issue-final-acceptance/v1' as const;

export const PROJECTION_IN_PROGRESS = 'spec-review:in-progress' as const;
export const PROJECTION_ACCEPTED = 'spec-review:accepted' as const;

export const PROJECTION_LABELS = {
  [PROJECTION_IN_PROGRESS]: {
    description: 'create-issue-draft cycle is active',
    color: 'FBCA04',
  },
  [PROJECTION_ACCEPTED]: {
    description: 'create-issue-draft cycle passed aggregate acceptance',
    color: '0E8A16',
  },
} as const;

export type PublicActor =
  | 'opencode-flow-manager'
  | 'cursor-flow-manager'
  | 'codex-flow-manager'
  | 'other-flow-manager';

export type SettledOutcome = 'complete' | 'partial' | 'blocked' | 'incident';
export type ProducerEvidence = 'verified' | 'waived' | 'not-applicable';
export type DeliveryClass = 'immediate' | 'delayed';

export interface GhInvocationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GhTransport {
  runGh(argv: string[]): GhInvocationResult;
}

export interface TrustedComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  userLogin: string;
  authorAssociation: string;
}

export interface CycleEventLogical {
  schema: typeof CYCLE_SCHEMA;
  'event-key': string;
  'cycle-id': string;
  'predecessor-cycle-id': string;
  'source-revision': string;
  tier: string;
  'public-actor': PublicActor;
}

export interface StageEventLogical {
  schema: typeof STAGE_SCHEMA;
  'event-key': string;
  'cycle-id': string;
  stage: string;
  tier: string;
  'source-revision': string;
  'stage-attempt-id': string;
  'policy-version': string;
  'settled-outcome': SettledOutcome;
  'source-count': number;
  'required-source-count': number;
  'producer-evidence': ProducerEvidence;
  'tier-transition': string;
}

export interface FinalEventLogical {
  schema: typeof FINAL_SCHEMA;
  'event-key': string;
  'cycle-id': string;
  tier: string;
  'source-revision': string;
  outcome: 'accepted';
  'contract-version': string;
  'public-actor': PublicActor;
}

export type JournalLogical = CycleEventLogical | StageEventLogical | FinalEventLogical;

export interface ParsedJournalEvent {
  schema: string;
  eventKey: string;
  logical: JournalLogical;
  fingerprint: string;
  commentId: number;
  createdAt: string;
  delivery?: DeliveryClass;
  deliveryFailureClass?: string;
  firstFailureAt?: string;
}

export type LineageDiagnosticCode =
  | 'conflicting-cycle-id'
  | 'non-current-cycle-root'
  | 'orphan-cycle'
  | 'cyclic-cycle-lineage'
  | 'non-current-cycle-fork'
  | 'duplicate-remote-event'
  | 'conflicting-remote-event';

export interface LineageDiagnostic {
  code: LineageDiagnosticCode | 'foreign-comment' | 'edited-comment' | 'malformed-marker' | 'trust-field-incomplete' | 'comments-truncated' | 'public-journal-gap';
  message: string;
  eventKey?: string;
  commentId?: number;
}

export interface CanonicalLineage {
  roots: ParsedJournalEvent[];
  canonicalRoot: ParsedJournalEvent | null;
  head: ParsedJournalEvent | null;
  eventsByKey: Map<string, ParsedJournalEvent>;
  diagnostics: LineageDiagnostic[];
}

export interface CommentCensusOptions {
  pageSize?: number;
  maxPages?: number;
  sentinelProbe?: boolean;
}

export interface CommentCensusResult {
  comments: TrustedComment[];
  commentsComplete: boolean;
  diagnostics: LineageDiagnostic[];
}

export interface StageReceiptCycleBinding {
  cycleId: string;
  sourceRevision: string;
  boundBeforeLaunch: true;
}

export interface ConsumableStageReceipt {
  tier: string;
  stage: string;
  cycleId: string;
  stageAttemptId: string;
  policyVersion: string;
  sourceRevision: string;
  outcome: SettledOutcome;
  reviewerCardinality: number;
  completedSourceCount: number;
  cycleBinding: StageReceiptCycleBinding;
  producerEvidence: ProducerEvidence;
  tierTransition: string;
}

export interface PendingJournalEvent {
  schema: string;
  eventKey: string;
  body: string;
  createdAt: string;
  delivery?: DeliveryClass;
  deliveryFailureClass?: string;
  firstFailureAt?: string;
}

export interface ProjectionSyncResult {
  ok: boolean;
  applied: string[];
  removed: string[];
  pendingRepair: boolean;
  diagnostics: LineageDiagnostic[];
}
