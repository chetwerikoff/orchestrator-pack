import { createHash } from 'node:crypto';
import type {
  RuntimeDispatchResult,
  RuntimeResult,
  RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import type { OrcaJsonResponse } from './transport.ts';

const CONFIRMED_GONE_CODES = new Set([
  'terminal_handle_stale',
  'terminal_not_found',
  'terminal_lookup_empty',
  'channel_stale_handle',
  'channel_lookup_empty',
]);

export type NativeCursor = string | number | null;

export type TerminalRow = {
  readonly handle: string;
  readonly worktreePath: string;
  readonly title?: string;
  readonly tabId?: string;
  readonly leafId?: string;
};

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function opaqueHash(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

export function identityKey(identity: RuntimeWorkerIdentity): string {
  return `${identity.id}\u0000${identity.generation}`;
}

export function success<T>(value: T): RuntimeResult<T> {
  return { status: 'ok', value };
}

export function failure<T>(
  status: Exclude<RuntimeResult<T>['status'], 'ok'>,
  reason: string,
): RuntimeResult<T> {
  return { status, reason } as RuntimeResult<T>;
}

export function nativeReason(response: OrcaJsonResponse): string {
  return response.error?.code ?? response.error?.message ?? 'orca_operation_failed';
}

export function confirmedGone(response: OrcaJsonResponse): boolean {
  return CONFIRMED_GONE_CODES.has(response.error?.code ?? '');
}

function parseNativeCursor(value: unknown): NativeCursor | undefined {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return undefined;
}

export function parseBoundedOutputPayload(payload: unknown):
  | { readonly ok: true; readonly lines: readonly string[]; readonly nativeCursor: NativeCursor }
  | { readonly ok: false; readonly reason: string } {
  const result = object(payload);
  const terminal = object(result?.terminal);
  const linesValue = result?.lines ?? terminal?.tail;
  const hasCursor = Boolean(result && 'nextCursor' in result)
    || Boolean(terminal && 'nextCursor' in terminal);
  const cursorValue = result && 'nextCursor' in result
    ? result.nextCursor
    : terminal?.nextCursor;
  if (!Array.isArray(linesValue) || linesValue.some((line) => typeof line !== 'string') || !hasCursor) {
    return { ok: false, reason: 'orca_read_invalid_response_shape' };
  }
  const nativeCursor = parseNativeCursor(cursorValue);
  if (nativeCursor === undefined) {
    return { ok: false, reason: 'orca_read_invalid_response_shape' };
  }
  return { ok: true, lines: linesValue as string[], nativeCursor };
}

export function parseTerminalRows(payload: unknown):
  | { readonly ok: true; readonly rows: readonly TerminalRow[] }
  | { readonly ok: false; readonly reason: string } {
  const result = object(payload);
  if (!result || !Array.isArray(result.terminals)) {
    return { ok: false, reason: 'orca_terminal_list_unsupported' };
  }
  const rows: TerminalRow[] = [];
  for (const value of result.terminals) {
    const row = object(value);
    const handle = typeof row?.handle === 'string' ? row.handle.trim() : '';
    const worktreePath = typeof row?.worktreePath === 'string' ? row.worktreePath.trim() : '';
    if (!handle || !worktreePath) {
      return { ok: false, reason: 'orca_terminal_list_unsupported' };
    }
    rows.push({
      handle,
      worktreePath,
      ...(typeof row?.title === 'string' ? { title: row.title } : {}),
      ...(typeof row?.tabId === 'string' ? { tabId: row.tabId } : {}),
      ...(typeof row?.leafId === 'string' ? { leafId: row.leafId } : {}),
    });
  }
  return { ok: true, rows };
}

export function dispatchResult(response: OrcaJsonResponse): RuntimeDispatchResult {
  if (response.ok) return { status: 'dispatched', attempts: 1 };
  const code = response.error?.code ?? '';
  const ambiguous = code === 'orca_operation_timeout'
    || response.outcomeCategory === 'empty_stdout'
    || response.outcomeCategory === 'invalid_json';
  return {
    status: ambiguous ? 'dispatch_unknown' : 'send_failed',
    attempts: 1,
    reason: nativeReason(response),
  };
}
