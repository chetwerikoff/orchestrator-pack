// Issue #1937 keeps the established state-light implementation unchanged in
// state-light-turn-base.ts and narrows only the public terminal projection for
// the two execute-Issue product-error causes. The underlying observation loop,
// send-once authority, recovery logic, publication, and cleanup remain owned by
// the existing implementation.
export * from './state-light-turn-base.ts';

import {
  runStateLightTurn as runBaseStateLightTurn,
  type StateLightTurnDependencies,
} from './state-light-turn-base.ts';
import type { ExecutionRecoveryProductCause } from './ui-adapter.ts';

const DEFAULT_TIMEOUT_MS = 1_800_000;
const EXECUTION_RECOVERY_CAUSES = new Set<ExecutionRecoveryProductCause>([
  'message_delivery_timed_out',
  'product_network_error',
]);

function projectExecutionRecoveryTerminal(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (
    record.schema === 'turn-result/v1'
    && record.state === 'recovery_required'
    && typeof record.cause === 'string'
    && EXECUTION_RECOVERY_CAUSES.has(record.cause as ExecutionRecoveryProductCause)
  ) {
    return { ...record, scope: 'conversation' };
  }
  return value;
}

function projectStdoutChunk(chunk: unknown): unknown {
  const text = typeof chunk === 'string'
    ? chunk
    : chunk instanceof Uint8Array
      ? Buffer.from(chunk).toString('utf8')
      : undefined;
  if (text === undefined) return chunk;

  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  let changed = false;
  const projected = lines.map((line) => {
    if (!line) return line;
    try {
      const parsed = JSON.parse(line) as unknown;
      const next = projectExecutionRecoveryTerminal(parsed);
      if (next !== parsed) changed = true;
      return next === parsed ? line : JSON.stringify(next);
    } catch {
      return line;
    }
  });
  if (!changed) return chunk;
  return `${projected.join('\n')}${trailingNewline ? '\n' : ''}`;
}

function withPreservedDefaultTimeout(argv: readonly string[]): readonly string[] {
  return argv.includes('--timeout-ms')
    ? argv
    : [...argv, '--timeout-ms', String(DEFAULT_TIMEOUT_MS)];
}

/**
 * Preserve the existing state-light engine while projecting the two new causes
 * onto the already-existing conversation-scoped recovery_required result axis.
 * This does not create a new TurnState, retry path, store, or monitor.
 */
export async function runStateLightTurn(
  argv: readonly string[],
  dependencies: StateLightTurnDependencies = {},
): Promise<number> {
  const originalWrite = process.stdout.write;
  (process.stdout as unknown as { write: (...args: any[]) => boolean }).write = ((
    chunk: unknown,
    ...args: any[]
  ): boolean => (
    originalWrite.call(process.stdout, projectStdoutChunk(chunk) as any, ...args as any)
  )) as (...args: any[]) => boolean;
  try {
    return await runBaseStateLightTurn(withPreservedDefaultTimeout(argv), dependencies);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
  }
}
