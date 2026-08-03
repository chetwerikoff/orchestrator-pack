/**
 * Task-caller compatibility surface.
 *
 * Production callers (no injected runner) route lifecycle operations through
 * scripts/runtime/**. Focused transport tests keep the historical fake-runner
 * seam so they can exercise exact Orca wire classifications without inventing
 * runtime identities; that injection is not available to production callers.
 */
import {
  closeOrcaTerminal as closeRuntimeTerminal,
  createOrcaTerminal as createRuntimeTerminal,
  probeOrcaWorktree as probeRuntimeWorktree,
  readOrcaTerminal as readRuntimeTerminal,
  sendOrcaTerminal as sendRuntimeTerminal,
  submitOrcaTerminalComposer as submitRuntimeTerminalComposer,
  waitOrcaTerminal as waitRuntimeTerminal,
} from '../runtime/task-compat.ts';
import {
  closeOrcaTerminal as closeNativeTerminal,
  createOrcaTerminal as createNativeTerminal,
  probeOrcaWorktree as probeNativeWorktree,
  readOrcaTerminal as readNativeTerminal,
  sendOrcaTerminal as sendNativeTerminal,
  submitOrcaTerminalComposer as submitNativeTerminalComposer,
  waitOrcaTerminal as waitNativeTerminal,
  type OrcaOperationFailure,
  type OrcaTerminalCreateResult,
  type OrcaWorktreeProbeResult,
} from '../orca-runtime/compat.ts';
import type {
  OrcaJsonResponse,
  OrcaRunOptions,
  OrcaTerminalReadResult,
} from '../orca-runtime/native.ts';

type RuntimeCreateInput = Parameters<typeof createRuntimeTerminal>[0];

export { RuntimeTaskCompatibilityFacade } from '../runtime/task-compat.ts';

export function probeOrcaWorktree(
  cwd: string,
  options: OrcaRunOptions = {},
): OrcaWorktreeProbeResult {
  return options.runner
    ? probeNativeWorktree(cwd, options)
    : probeRuntimeWorktree(cwd, options);
}

export function createOrcaTerminal(input: RuntimeCreateInput): OrcaTerminalCreateResult {
  return input.runner ? createNativeTerminal(input) : createRuntimeTerminal(input);
}

export function sendOrcaTerminal(
  handle: string,
  text: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return options.runner
    ? sendNativeTerminal(handle, text, options)
    : sendRuntimeTerminal(handle, text, options);
}

export function submitOrcaTerminalComposer(
  handle: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return options.runner
    ? submitNativeTerminalComposer(handle, options)
    : submitRuntimeTerminalComposer(handle, options);
}

export function readOrcaTerminal(
  handle: string,
  options: OrcaRunOptions & { readonly cursor?: number; readonly limit?: number } = {},
): OrcaJsonResponse<OrcaTerminalReadResult> {
  return options.runner
    ? readNativeTerminal(handle, options)
    : readRuntimeTerminal(handle, options);
}

export function waitOrcaTerminal(
  handle: string,
  input: OrcaRunOptions & { readonly for: 'exit' | 'tui-idle'; readonly timeoutMs: number },
): OrcaJsonResponse {
  return input.runner
    ? waitNativeTerminal(handle, input)
    : waitRuntimeTerminal(handle, input);
}

export function closeOrcaTerminal(
  handle: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return options.runner
    ? closeNativeTerminal(handle, options)
    : closeRuntimeTerminal(handle, options);
}

export {
  closeNativeTerminal as closeOrcaTerminalNative,
  createNativeTerminal as createOrcaTerminalNative,
  probeNativeWorktree as probeOrcaWorktreeNative,
  readNativeTerminal as readOrcaTerminalNative,
  sendNativeTerminal as sendOrcaTerminalNative,
  submitNativeTerminalComposer as submitOrcaTerminalComposerNative,
  waitNativeTerminal as waitOrcaTerminalNative,
  type OrcaOperationFailure,
  type OrcaTerminalCreateResult,
  type OrcaWorktreeProbeResult,
};

export {
  ORCA_SMOKE_CONTROL_PLANE_CODES,
  ORCA_WORKER_SMOKE_CONTRACT_EVIDENCE_DIR,
  findExecutableOnPath,
  isOrcaSmokeControlPlaneCode,
  orcaExecutableLooksAvailable,
  resolveOrcaExecutable,
  resolveOrcaOperation,
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaLocalOutcomeCategory,
  type OrcaOperationName,
  type OrcaRunOptions,
  type OrcaSmokeControlPlaneCode,
  type OrcaTerminalHandle,
  type OrcaTerminalReadResult,
  type OrcaWorktreeCurrent,
} from '../orca-runtime/native.ts';
