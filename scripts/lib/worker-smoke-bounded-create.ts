import {
  createOrcaTerminal,
  type OrcaRunOptions,
  type OrcaTerminalHandle,
} from './orca-cli.ts';
import { SMOKE_CREATE_TIMEOUT_MS } from './worker-smoke-lifecycle.ts';

export type BoundedOrcaCreateResult =
  | {
    ok: true;
    terminal: OrcaTerminalHandle;
    elapsedMs: number;
  }
  | {
    ok: false;
    reason: string;
    errorCode: string;
    ambiguousUnbound: boolean;
    elapsedMs: number;
  };

/**
 * Preserve the worker-smoke bounded-create contract while routing the side
 * effect through the selected runtime adapter. The caller still reserves its
 * existing pack lifecycle claim before invoking this function.
 */
export function createBoundedOrcaTerminal(input: {
  cwd: string;
  title: string;
  command: string;
  executable?: string;
  timeoutMs?: number;
  now?: () => number;
  runner?: OrcaRunOptions['runner'];
}): BoundedOrcaCreateResult {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const created = createOrcaTerminal({
    cwd: input.cwd,
    title: input.title,
    command: input.command,
    executable: input.executable,
    timeoutMs: input.timeoutMs ?? SMOKE_CREATE_TIMEOUT_MS,
    runner: input.runner,
  });
  const elapsedMs = Math.max(0, now() - startedAt);
  if (!created.ok) {
    return {
      ok: false,
      reason: created.reason,
      errorCode: created.errorCode ?? created.reason ?? 'terminal_create_failed',
      ambiguousUnbound: true,
      elapsedMs,
    };
  }
  return { ok: true, terminal: created.terminal, elapsedMs };
}
