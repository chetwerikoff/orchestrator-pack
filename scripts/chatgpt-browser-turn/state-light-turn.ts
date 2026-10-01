// Issue #1937 keeps the established state-light implementation unchanged in
// state-light-turn-base.ts and narrows only the public terminal projection for
// the four execute-Issue product-error causes. The underlying observation loop,
// send-once authority, recovery logic, publication, and cleanup remain owned by
// the existing implementation.
export * from './state-light-turn-base.ts';

import {
  runStateLightTurn as runBaseStateLightTurn,
  type StateLightTurnDependencies,
} from './state-light-turn-base.ts';
import {
  enterExecutionRecoveryProductWallScope,
  type ExecutionRecoveryProductCause,
} from './ui-adapter.ts';
import { writeChatBinding } from './chat-bindings.ts';

const DEFAULT_TIMEOUT_MS = 1_800_000;
const EXECUTION_RECOVERY_CAUSES = new Set<ExecutionRecoveryProductCause>([
  'message_delivery_timed_out',
  'product_network_error',
  'message_stream_error',
  'stream_recovery_polling_timed_out',
  'product_error_banner',
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

function recordChatBindings(chunk: unknown): void {
  const text = typeof chunk === 'string'
    ? chunk
    : chunk instanceof Uint8Array
      ? Buffer.from(chunk).toString('utf8')
      : undefined;
  if (text === undefined) return;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed?.schema === 'turn-result/v1' && typeof parsed.conversation_id === 'string') {
        writeChatBinding(parsed.conversation_id, process.cwd());
      }
    } catch {
      // Routing data is best-effort and never alters the turn result.
    }
  }
}

function withPreservedDefaultTimeout(argv: readonly string[]): readonly string[] {
  return argv.includes('--timeout-ms')
    ? argv
    : [...argv, '--timeout-ms', String(DEFAULT_TIMEOUT_MS)];
}

/**
 * Preserve the existing state-light engine while projecting all reserved execution
 * recovery causes onto the already-existing conversation-scoped recovery_required result axis.
 * This does not create a new TurnState, retry path, store, or monitor.
 */
export async function runStateLightTurn(
  argv: readonly string[],
  dependencies: StateLightTurnDependencies & { readonly recordChatBinding?: boolean } = {},
): Promise<number> {
  const { recordChatBinding = false, ...baseDependencies } = dependencies;
  const leaveRecoveryScope = enterExecutionRecoveryProductWallScope();
  const originalWrite = process.stdout.write;
  try {
    (process.stdout as unknown as { write: (...args: any[]) => boolean }).write = ((
      chunk: unknown,
      ...args: any[]
    ): boolean => {
      if (recordChatBinding) recordChatBindings(chunk);
      return originalWrite.call(process.stdout, projectStdoutChunk(chunk) as any, ...args as any);
    }) as (...args: any[]) => boolean;
    return await runBaseStateLightTurn(withPreservedDefaultTimeout(argv), baseDependencies);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
    leaveRecoveryScope();
  }
}
