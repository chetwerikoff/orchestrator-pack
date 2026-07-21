import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from '../kernel/subprocess.ts';

export const DISPATCH_OUTCOME_DISPATCHED = 'dispatched' as const;
export const DISPATCH_OUTCOME_SEND_FAILED = 'send_failed' as const;
export const DISPATCH_OUTCOME_IN_FLIGHT = 'dispatch_in_flight' as const;
export const DISPATCH_OUTCOME_UNKNOWN = 'dispatch_unknown' as const;
export const DRAFT_STATE_AUTO_SUBMITTED = 'auto_submitted' as const;
export const DRAFT_STATE_DRAFT_PRESENT = 'draft_present' as const;
export const DELIVERY_PATH_PENDING_DRAFT = 'pending-draft' as const;
export const DELIVERY_PATH_SELF_SUBMITTED = 'self-submitted' as const;

export interface NotificationMessageShape {
  charLength: number;
  lineCount: number;
  multiline: boolean;
  deliveryPath: typeof DELIVERY_PATH_PENDING_DRAFT | typeof DELIVERY_PATH_SELF_SUBMITTED;
}

export interface DispatchJournalRecord extends Record<string, unknown> {
  deliveryId: string;
  sessionId: string;
  deliveredAtMs: number;
  source: string;
  sourceKey: string;
  deliveryPath: string;
  messageShape: { charLength: number; lineCount: number };
  dispatchOutcome: string;
  draftState: string;
  deterministicKey?: string;
  findingsHash?: string;
}

export type DispatchJournal = Record<string, unknown>;

type CanonicalAdmitResult =
  | { ok: true; journal: DispatchJournal; record: DispatchJournalRecord }
  | { ok: false; reason: string; journal: DispatchJournal; backpressure?: boolean };

type CanonicalFinalizeResult =
  | {
    ok: true;
    journal: DispatchJournal;
    record: DispatchJournalRecord;
    evicted: boolean;
  }
  | { ok: false; reason: string; journal: DispatchJournal };

const CANONICAL_DISPATCH_CLI = fileURLToPath(
  new URL('../../docs/worker-message-dispatch-observe.mjs', import.meta.url),
);

function parseCanonicalOutput(text: string, subcommand: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`canonical_dispatch_${subcommand}_no_json`);
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(
      `canonical_dispatch_${subcommand}_invalid_json:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function invokeCanonicalDispatch<T>(subcommand: string, payload: unknown): T {
  const root = mkdtempSync(join(tmpdir(), 'opk-pr2-dispatch-'));
  const inputFile = join(root, 'input.json');
  const outputFile = join(root, 'output.json');
  try {
    writeFileSync(inputFile, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    const result = runProcessSync({
      command: process.execPath,
      args: [
        CANONICAL_DISPATCH_CLI,
        subcommand,
        '--input-file',
        inputFile,
        '--output-file',
        outputFile,
      ],
      inheritParentEnv: true,
    });
    if (!result.ok) {
      const detail = result.stderr || result.error || result.stdout || result.outcome;
      throw new Error(`canonical_dispatch_${subcommand}_failed:${detail}`);
    }
    return parseCanonicalOutput(readFileSync(outputFile, 'utf8'), subcommand) as T;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Exact bridge to the canonical dispatch classifier. Keeping this call out of
 * the live adapter prevents a second independently evolving byte contract.
 */
export function deriveMessageShape(message: string, senderSessionId = ''): NotificationMessageShape {
  return invokeCanonicalDispatch<NotificationMessageShape>('classify', {
    message,
    senderSessionId,
  });
}

/**
 * Invoke the canonical bounded journal admission implementation. This retains
 * compaction, capacity/backpressure, withPendingDispatchFence, and the exact
 * historical record shape consumed by the existing reconciler.
 */
export function admitDispatchJournalRecord(
  journal: DispatchJournal,
  record: DispatchJournalRecord,
  nowMs = Date.now(),
): CanonicalAdmitResult {
  return invokeCanonicalDispatch<CanonicalAdmitResult>('journal-admit', {
    journal,
    record,
    nowMs,
  });
}

/**
 * Invoke the canonical fence transition/finalization implementation rather
 * than maintaining a TypeScript fork of advanceDispatchFenceLifecycle.
 */
export function finalizeDispatchJournalRecord(
  journal: DispatchJournal,
  deliveryId: string,
  dispatchOutcome: string,
  nowMs = Date.now(),
  draftState = '',
): CanonicalFinalizeResult {
  return invokeCanonicalDispatch<CanonicalFinalizeResult>('journal-finalize', {
    journal,
    deliveryId,
    dispatchOutcome,
    nowMs,
    draftState,
  });
}
