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

function compatibilityCreateErrorCode(value: string | undefined): string {
  if (value === 'runtime_timeout' || value === 'orca_operation_timeout') {
    return 'orca_create_timeout';
  }
  return value ?? 'terminal_create_failed';
}

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
    const sourceCode = created.errorCode ?? created.reason;
    return {
      ok: false,
      reason: created.reason,
      errorCode: compatibilityCreateErrorCode(sourceCode),
      ambiguousUnbound: true,
      elapsedMs,
    };
  }
  return { ok: true, terminal: created.terminal, elapsedMs };
}
