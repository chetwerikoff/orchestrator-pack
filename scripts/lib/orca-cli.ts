/**
 * Task-caller compatibility exports.
 *
 * Ordinary worker/smoke callers keep their stable surface while lifecycle
 * operations are routed through scripts/runtime/**. Runtime-native helpers are
 * retained only for focused transport tests and executable provenance.
 */
export {
  RuntimeTaskCompatibilityFacade,
  closeOrcaTerminal,
  createOrcaTerminal,
  probeOrcaWorktree,
  readOrcaTerminal,
  sendOrcaTerminal,
  submitOrcaTerminalComposer,
  waitOrcaTerminal,
} from '../runtime/task-compat.ts';

export {
  closeOrcaTerminal as closeOrcaTerminalNative,
  createOrcaTerminal as createOrcaTerminalNative,
  isOrcaSmokeControlPlaneCode,
  probeOrcaWorktree as probeOrcaWorktreeNative,
  readOrcaTerminal as readOrcaTerminalNative,
  sendOrcaTerminal as sendOrcaTerminalNative,
  submitOrcaTerminalComposer as submitOrcaTerminalComposerNative,
  waitOrcaTerminal as waitOrcaTerminalNative,
  type OrcaOperationFailure,
  type OrcaTerminalCreateResult,
  type OrcaWorktreeProbeResult,
} from '../orca-runtime/compat.ts';

export {
  ORCA_SMOKE_CONTROL_PLANE_CODES,
  ORCA_WORKER_SMOKE_CONTRACT_EVIDENCE_DIR,
  findExecutableOnPath,
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
