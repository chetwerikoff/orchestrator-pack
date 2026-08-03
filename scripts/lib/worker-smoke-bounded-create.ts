import type { spawnSync } from 'node:child_process';
import {
  createOrcaTerminal,
  resolveOrcaExecutable,
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

export function createBoundedOrcaTerminal(input: {
  cwd: string;
  title: string;
  command: string;
  executable?: string;
  timeoutMs?: number;
  now?: () => number;
  runner?: typeof spawnSync;
}): BoundedOrcaCreateResult {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const created = createOrcaTerminal({
    cwd: input.cwd,
    title: input.title,
    command: input.command,
    executable: input.executable ?? resolveOrcaExecutable(),
    runner: input.runner,
    timeoutMs: input.timeoutMs ?? SMOKE_CREATE_TIMEOUT_MS,
  });
  const elapsedMs = Math.max(0, now() - startedAt);
  if (!created.ok) {
    return {
      ok: false,
      reason: created.reason,
      errorCode: created.errorCode === 'orca_operation_timeout'
        ? 'orca_create_timeout'
        : created.errorCode ?? 'terminal_create_failed',
      ambiguousUnbound: true,
      elapsedMs,
    };
  }
  return { ok: true, terminal: created.terminal, elapsedMs };
}
