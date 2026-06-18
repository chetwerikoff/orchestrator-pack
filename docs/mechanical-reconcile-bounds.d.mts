export declare const MECHANICAL_PIPE_BUFFER_BYTES: number;
export declare const MECHANICAL_TRANSPORT_ENVELOPE_BYTES: number;
export declare const MECHANICAL_STORAGE_CEILING_BYTES: number;
export declare const MECHANICAL_ENCODING_EXPANSION_FACTOR: number;

export declare const FENCE_LIFECYCLE_PENDING: 'pending';
export declare const FENCE_LIFECYCLE_COMPLETED: 'completed';
export declare const FENCE_LIFECYCLE_FAILED_UNCERTAIN: 'failed-uncertain';

export declare const DISPATCH_OUTCOME_IN_FLIGHT: 'dispatch_in_flight';
export declare const DISPATCH_OUTCOME_DISPATCHED: 'dispatched';
export declare const DISPATCH_OUTCOME_SEND_FAILED: 'send_failed';
export declare const DISPATCH_OUTCOME_UNKNOWN: 'dispatch_unknown';

export declare const SUBMIT_STATE_SUBMITTED: 'submitted';
export declare const SUBMIT_STATE_ESCALATED: 'escalated';

export declare const FAILED_DELIVERY_UNRESOLVED: 'unresolved';
export declare const FAILED_DELIVERY_RESOLVED: 'resolved';
export declare const FAILED_DELIVERY_AUDITED_CLOSED: 'audited_closed';

export declare const SUBMIT_DELIVERY_RETENTION_MS: number;
export declare const DISPATCH_JOURNAL_RETENTION_MS: number;
export declare const MECHANICAL_AUDIT_RETAIN: number;

export declare function estimateSerializedUtf8Bytes(value: unknown): number;
export declare function maxChildOutputBytesForStorage(storageBytes: number): number;
export declare function storageBytesWithinTransportEnvelope(childOutputBytes: number): boolean;
export declare function interpretDispatchFenceLifecycle(
  record: Record<string, unknown> | null | undefined,
): string;
export declare function interpretSubmitTrackingLifecycle(
  record: Record<string, unknown> | null | undefined,
): string;
export declare function isSubmitDeliveryEvictable(
  record: Record<string, unknown>,
  nowMs: number,
): boolean;
export declare function isFailedDeliveryEvictable(
  record: Record<string, unknown>,
  nowMs: number,
): boolean;
export declare function isDispatchJournalEntryEvictable(
  record: Record<string, unknown>,
  nowMs: number,
): boolean;
export declare function compactWorkerMessageSubmitTracking(
  tracking: Record<string, unknown>,
  nowMs: number,
): { tracking: Record<string, unknown>; evicted: string[] };
export declare function compactDispatchJournal(
  journal: Record<string, unknown>,
  nowMs: number,
): { journal: Record<string, unknown>; evicted: string[] };
export declare function evaluateDispatchJournalAdmission(
  journal: Record<string, unknown>,
  candidateRecord: Record<string, unknown>,
  ceilingBytes?: number,
): Record<string, unknown>;
export declare function evaluateSubmitTrackingCapacity(
  tracking: Record<string, unknown>,
  ceilingBytes?: number,
): Record<string, unknown>;
export declare function convergeOversizedReconcileState(input: {
  tracking: Record<string, unknown>;
  journal?: Record<string, unknown>;
  nowMs: number;
}): Record<string, unknown>;
export declare function parseCompleteJsonText(text: string): unknown;
export declare function assertTransportEnvelope(text: string, envelopeBytes?: number): number;
export declare function withPendingDispatchFence(
  record: Record<string, unknown>,
): Record<string, unknown>;
export declare function advanceDispatchFenceLifecycle(
  record: Record<string, unknown>,
  dispatchOutcome: string,
): Record<string, unknown>;
export declare function stableTransportFingerprint(payload: Record<string, unknown>): string;
