/**
 * Task-caller compatibility exports.
 *
 * Ordinary worker/smoke callers keep their stable surface while every lifecycle
 * operation is routed through scripts/runtime/**. Runtime-native helpers remain
 * exported only for focused transport tests and executable provenance.
 */
export {
  ORCA_SMOKE_CONTROL_PLANE_CODES,
  ORCA_WORKER_SMOKE_CONTRACT_EVIDENCE_DIR,
  RuntimeTaskCompatibilityFacade,
  closeOrcaTerminal,
  createOrcaTerminal,
  isOrcaSmokeControlPlaneCode,
  probeOrcaWorktree,
  readOrcaTerminal,
  sendOrcaTerminal,
  submitOrcaTerminalComposer,
  waitOrcaTerminal,
  type OrcaJsonResponse,
  type OrcaLocalOutcomeCategory,
  type OrcaOperationFailure,
  type OrcaOperationName,
  type OrcaSmokeControlPlaneCode,
  type OrcaTerminalCreateResult,
  type OrcaTerminalHandle,
  type OrcaTerminalReadResult,
  type OrcaWorktreeProbeResult,
} from '../runtime/task-compat.ts';

export {
  findExecutableOnPath,
  orcaExecutableLooksAvailable,
  resolveOrcaExecutable,
  resolveOrcaOperation,
  runOrcaJson,
  type OrcaRunOptions,
  type OrcaWorktreeCurrent,
} from '../orca-runtime/native.ts';
