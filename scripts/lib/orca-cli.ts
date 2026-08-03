/**
 * Compatibility exports for the working Orca path.
 * New runtime-neutral callers use scripts/runtime/**; legacy callers are moved in #1248.
 */
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
  type OrcaWorktreeCurrent,
} from '../orca-runtime/native.ts';

export {
  closeOrcaTerminal,
  createOrcaTerminal,
  probeOrcaWorktree,
  readOrcaTerminal,
  sendOrcaTerminal,
  submitOrcaTerminalComposer,
  waitOrcaTerminal,
  type OrcaOperationFailure,
  type OrcaTerminalCreateResult,
  type OrcaTerminalReadResult,
  type OrcaWorktreeProbeResult,
} from '../orca-runtime/compat.ts';
