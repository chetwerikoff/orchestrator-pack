import { createOrcaRuntimeAdapter } from '../orca-runtime/adapter.ts';
import {
  ORCA_SMOKE_CONTROL_PLANE_CODES,
  ORCA_WORKER_SMOKE_CONTRACT_EVIDENCE_DIR,
  findExecutableOnPath,
  isOrcaSmokeControlPlaneCode,
  orcaExecutableLooksAvailable,
  resolveOrcaExecutable,
  resolveOrcaOperation,
  type OrcaJsonResponse,
  type OrcaRunOptions,
  type OrcaTerminalCreateResult,
  type OrcaTerminalReadResult,
  type OrcaWorktreeProbeResult,
} from '../orca-runtime/transport.ts';

export {
  ORCA_SMOKE_CONTROL_PLANE_CODES,
  ORCA_WORKER_SMOKE_CONTRACT_EVIDENCE_DIR,
  findExecutableOnPath,
  isOrcaSmokeControlPlaneCode,
  orcaExecutableLooksAvailable,
  resolveOrcaExecutable,
  resolveOrcaOperation,
};

export type {
  OrcaJsonResponse,
  OrcaLocalOutcomeCategory,
  OrcaOperationFailure,
  OrcaOperationName,
  OrcaRunOptions,
  OrcaSmokeControlPlaneCode,
  OrcaTerminalCreateResult,
  OrcaTerminalHandle,
  OrcaTerminalReadResult,
  OrcaWorktreeCurrent,
  OrcaWorktreeProbeResult,
} from '../orca-runtime/transport.ts';

export function runOrcaJson<T>(
  args: readonly string[],
  options: OrcaRunOptions = {},
): OrcaJsonResponse<T> {
  return createOrcaRuntimeAdapter(options).runJson<T>(args);
}

export function probeOrcaWorktree(
  cwd: string,
  options: Pick<OrcaRunOptions, 'executable' | 'runner' | 'timeoutMs'> = {},
): OrcaWorktreeProbeResult {
  return createOrcaRuntimeAdapter({ cwd, ...options }).probeWorktree(cwd, options);
}

export function createOrcaTerminal(input: {
  readonly cwd: string;
  readonly title: string;
  readonly command: string;
  readonly worktree?: string;
  readonly executable?: string;
  readonly runner?: OrcaRunOptions['runner'];
  readonly timeoutMs?: number;
}): OrcaTerminalCreateResult {
  return createOrcaRuntimeAdapter(input).createTerminal(input);
}

export function sendOrcaTerminal(
  handle: string,
  text: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return createOrcaRuntimeAdapter(options).sendTerminal(handle, text);
}

export function submitOrcaTerminalComposer(
  handle: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return createOrcaRuntimeAdapter(options).submitTerminal(handle);
}

export function readOrcaTerminal(
  handle: string,
  options: OrcaRunOptions & { readonly cursor?: number; readonly limit?: number } = {},
): OrcaJsonResponse<OrcaTerminalReadResult> {
  return createOrcaRuntimeAdapter(options).readTerminal(handle, options);
}

export function waitOrcaTerminal(
  handle: string,
  input: OrcaRunOptions & { readonly for: 'exit' | 'tui-idle'; readonly timeoutMs: number },
): OrcaJsonResponse {
  return createOrcaRuntimeAdapter(input).waitTerminal(handle, input);
}

export function closeOrcaTerminal(
  handle: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return createOrcaRuntimeAdapter(options).closeTerminal(handle);
}
