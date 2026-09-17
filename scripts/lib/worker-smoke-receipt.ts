import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  isWorkerSmokeCauseFamily,
  isWorkerSmokeScenarioCauseFamily,
  SMOKE_REPORT_PRODUCER,
  scrubSmokeOutput,
  type SmokeReport,
  type WorkerSmokeCauseFamily,
} from './worker-smoke-core.ts';
import type { SmokeLifecycleRegistry } from './worker-smoke-lifecycle-base.ts';
import {
  installStableWorkerSmokeSpawnPatch,
  quarantineUnsupportedHistoricalSmokeRuns,
  smokeRunCwdFromArgv,
} from './worker-smoke-bounded-create.ts';

export const WORKER_SMOKE_RECEIPT_SCHEMA = 'worker-smoke-receipt/v1';
export const WORKER_SMOKE_RUN_FINAL_SCHEMA = 'worker-smoke-run-final/v1';
export const SMOKE_CLOSE_SETTLEMENT_REASON = 'owned_terminal_cleanup' as const;

export interface WorkerSmokeFailureCause {
  phase: 'harness' | 'scenario';
  causeFamily: WorkerSmokeCauseFamily;
  code: string;
  scenarioOrdinal?: number;
  outcome?: NonNullable<SmokeReport['scenarios'][number]['outcome']>;
  action: string;
  expected?: string;
  observed: string;
  resolution?: string;
}

export type WorkerSmokeExecutionMode = 'executed' | 'carry-only';

export interface WorkerSmokeAttemptObservation {
  action: string;
  expected: string;
  outcome: NonNullable<SmokeReport['scenarios'][number]['outcome']>;
  causeFamily?: WorkerSmokeCauseFamily;
}

export interface WorkerSmokeReceipt {
  schema: typeof WORKER_SMOKE_RECEIPT_SCHEMA;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  terminalHandle: string;
  orcaExecutable: string;
  producer: string;
  result: SmokeReport['result'];
  publishedAt: string;
  attemptId?: string;
  runId?: string;
  executionMode?: WorkerSmokeExecutionMode;
  attemptObservations?: WorkerSmokeAttemptObservation[];
  operatorOverrideReason?: string;
  failureCause?: WorkerSmokeFailureCause;
}

export interface WorkerSmokeReceiptWriteOptions {
  attemptId?: string;
  runId?: string;
  executionMode?: WorkerSmokeExecutionMode;
  attemptObservations?: readonly WorkerSmokeAttemptObservation[];
  operatorOverrideReason?: string;
  publishedAt?: string;
}

export type WorkerSmokeRunMode = 'runtime' | 'no_execution';

export interface WorkerSmokeRunFinalEvidence {
  schema: typeof WORKER_SMOKE_RUN_FINAL_SCHEMA;
  runId: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  artifactDir: string;
  mode: WorkerSmokeRunMode;
  terminalState: 'launcher_terminalized';
  result: SmokeReport['result'];
  reportDigest: string;
  report: SmokeReport;
  recordedAtMs: number;
}

export interface SmokeCloseSettlementIdentity {
  settlementId: string;
  settlementReason: typeof SMOKE_CLOSE_SETTLEMENT_REASON;
}

interface CloseReceipt {
  version: 2;
  phase: 'settlement_recorded' | 'closed';
  runId: string;
  terminalHandle: string;
  headSha: string;
  artifactDir: string;
  settlementId: string;
  settlementReason: string;
  settlementAtMs: number;
  closeAttemptedAtMs: number;
  closeOutcome: string;
  recordedAtMs: number;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const workerSmokeEntrypoint = basename(process.argv[1] ?? '') === 'worker-smoke-run.ts';
if (workerSmokeEntrypoint && process.argv[2] === 'run') {
  const argv = process.argv.slice(2);
  const detachedBootstrap = argv.includes('--detach') && !argv.includes('--detached-owner');
  if (!detachedBootstrap) {
    quarantineUnsupportedHistoricalSmokeRuns(smokeRunCwdFromArgv(argv));
    installStableWorkerSmokeSpawnPatch();
  }
}

export function buildSmokeCloseSettlementIdentity(runId: string): SmokeCloseSettlementIdentity {
  const normalizedRunId = runId.trim();
  return {
    settlementId: `${normalizedRunId}:owned-terminal-cleanup`,
    settlementReason: SMOKE_CLOSE_SETTLEMENT_REASON,
  };
}

export function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  renameSync(temporary, path);
}

function writeCreateOnlyJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export const isCleanCloseOutcome = (outcome: string): boolean =>
  outcome === 'closed_owned_handle'
  || outcome === 'closed_owned_handle_already_absent';

export const smokeCloseReceiptPath = (artifactDir: string): string =>
  join(artifactDir, 'close-receipt.json');

export const smokeRunFinalEvidencePath = (artifactDir: string): string =>
  join(artifactDir, 'final-evidence.json');

function smokeReportDigest(report: SmokeReport): string {
  return createHash('sha256').update(JSON.stringify(report), 'utf8').digest('hex');
}

export function writeWorkerSmokeRunFinalEvidence(input: {
  artifactDir: string;
  runId: string;
  mode: WorkerSmokeRunMode;
  report: SmokeReport;
  result?: SmokeReport['result'];
  nowMs?: number;
}): WorkerSmokeRunFinalEvidence {
  const runId = input.runId.trim();
  const artifactDir = resolve(input.artifactDir);
  const report: SmokeReport = {
    ...input.report,
    producer: SMOKE_REPORT_PRODUCER,
  };
  if (!runId || basename(artifactDir) !== runId) throw new Error('worker_smoke_final_run_binding_invalid');
  if (!Number.isSafeInteger(report.issueNumber) || report.issueNumber <= 0
      || !Number.isSafeInteger(report.prNumber) || report.prNumber <= 0
      || !/^[0-9a-f]{40}$/u.test(report.headSha.trim().toLowerCase())) {
    throw new Error('worker_smoke_final_target_binding_invalid');
  }
  const result = input.result ?? report.result;
  if (!['PASS', 'FAIL', 'BLOCKED'].includes(result)) throw new Error('worker_smoke_final_result_invalid');
  const evidence: WorkerSmokeRunFinalEvidence = {
    schema: WORKER_SMOKE_RUN_FINAL_SCHEMA,
    runId,
    issueNumber: report.issueNumber,
    prNumber: report.prNumber,
    headSha: report.headSha.trim().toLowerCase(),
    artifactDir,
    mode: input.mode,
    terminalState: 'launcher_terminalized',
    result,
    reportDigest: smokeReportDigest(report),
    report,
    recordedAtMs: input.nowMs ?? Date.now(),
  };
  writeAtomicJson(smokeRunFinalEvidencePath(artifactDir), evidence);
  return evidence;
}

export function readWorkerSmokeRunFinalEvidence(input: {
  artifactDir: string;
  runId: string;
  issueNumber?: number;
  prNumber?: number;
  headSha?: string;
  mode?: WorkerSmokeRunMode;
}): WorkerSmokeRunFinalEvidence | null {
  const runId = input.runId.trim();
  const artifactDir = resolve(input.artifactDir);
  if (!runId || basename(artifactDir) !== runId) return null;
  const raw = readJson(smokeRunFinalEvidencePath(artifactDir));
  if (!isRecord(raw) || !isRecord(raw.report)) return null;
  const report = raw.report as unknown as SmokeReport;
  const evidence: WorkerSmokeRunFinalEvidence = {
    schema: WORKER_SMOKE_RUN_FINAL_SCHEMA,
    runId: String(raw.runId ?? '').trim(),
    issueNumber: Number(raw.issueNumber),
    prNumber: Number(raw.prNumber),
    headSha: String(raw.headSha ?? '').trim().toLowerCase(),
    artifactDir: String(raw.artifactDir ?? '').trim(),
    mode: raw.mode === 'no_execution' ? 'no_execution' : 'runtime',
    terminalState: 'launcher_terminalized',
    result: raw.result as SmokeReport['result'],
    reportDigest: String(raw.reportDigest ?? '').trim().toLowerCase(),
    report,
    recordedAtMs: Number(raw.recordedAtMs),
  };
  if (
    raw.schema !== WORKER_SMOKE_RUN_FINAL_SCHEMA
    || raw.terminalState !== 'launcher_terminalized'
    || (raw.mode !== 'runtime' && raw.mode !== 'no_execution')
    || !['PASS', 'FAIL', 'BLOCKED'].includes(String(raw.result ?? ''))
    || evidence.runId !== runId
    || resolve(evidence.artifactDir) !== artifactDir
    || !Number.isSafeInteger(evidence.issueNumber) || evidence.issueNumber <= 0
    || !Number.isSafeInteger(evidence.prNumber) || evidence.prNumber <= 0
    || !/^[0-9a-f]{40}$/u.test(evidence.headSha)
    || !/^[0-9a-f]{64}$/u.test(evidence.reportDigest)
    || !Number.isFinite(evidence.recordedAtMs)
    || report.issueNumber !== evidence.issueNumber
    || report.prNumber !== evidence.prNumber
    || report.headSha?.trim().toLowerCase() !== evidence.headSha
    || report.producer !== SMOKE_REPORT_PRODUCER
    || smokeReportDigest(report) !== evidence.reportDigest
    || (input.issueNumber !== undefined && evidence.issueNumber !== input.issueNumber)
    || (input.prNumber !== undefined && evidence.prNumber !== input.prNumber)
    || (input.headSha !== undefined && evidence.headSha !== input.headSha.trim().toLowerCase())
    || (input.mode !== undefined && evidence.mode !== input.mode)
  ) return null;
  return evidence;
}

export type CloseReceiptRead =
  | { state: 'missing' | 'invalid' }
  | { state: 'settlement_recorded' | 'closed'; receipt: CloseReceipt };

export function readCloseReceipt(
  artifactDir: string,
  registry: SmokeLifecycleRegistry,
): CloseReceiptRead {
  if (!existsSync(smokeCloseReceiptPath(artifactDir))) return { state: 'missing' };
  const value = readJson(smokeCloseReceiptPath(artifactDir));
  if (!isRecord(value)) return { state: 'invalid' };
  const receipt: CloseReceipt = {
    version: 2,
    phase: value.phase === 'closed' ? 'closed' : 'settlement_recorded',
    runId: String(value.runId ?? '').trim(),
    terminalHandle: String(value.terminalHandle ?? '').trim(),
    headSha: String(value.headSha ?? '').trim().toLowerCase(),
    artifactDir: String(value.artifactDir ?? '').trim(),
    settlementId: String(value.settlementId ?? '').trim(),
    settlementReason: String(value.settlementReason ?? '').trim(),
    settlementAtMs: Number(value.settlementAtMs),
    closeAttemptedAtMs: Number(value.closeAttemptedAtMs),
    closeOutcome: String(value.closeOutcome ?? '').trim(),
    recordedAtMs: Number(value.recordedAtMs),
  };
  const expectedSettlement = buildSmokeCloseSettlementIdentity(registry.runId);
  if (
    Number(value.version) !== 2
    || (value.phase !== 'settlement_recorded' && value.phase !== 'closed')
    || receipt.runId !== registry.runId
    || receipt.terminalHandle !== registry.terminalHandle
    || receipt.headSha !== registry.headSha
    || resolve(receipt.artifactDir) !== resolve(registry.artifactDir)
    || receipt.settlementId !== expectedSettlement.settlementId
    || receipt.settlementReason !== expectedSettlement.settlementReason
    || !Number.isFinite(receipt.settlementAtMs)
    || !Number.isFinite(receipt.closeAttemptedAtMs)
    || receipt.closeAttemptedAtMs !== registry.closeAttemptedAtMs
    || receipt.settlementAtMs > receipt.closeAttemptedAtMs
    || !Number.isFinite(receipt.recordedAtMs)
    || (receipt.phase === 'settlement_recorded' && (
      receipt.closeOutcome !== ''
      || receipt.recordedAtMs !== receipt.settlementAtMs
      || receipt.recordedAtMs > receipt.closeAttemptedAtMs
    ))
    || (receipt.phase === 'closed' && (
      !isCleanCloseOutcome(receipt.closeOutcome)
      || receipt.recordedAtMs < receipt.closeAttemptedAtMs
    ))
  ) return { state: 'invalid' };
  return { state: receipt.phase, receipt };
}

export function recordCloseReceipt(input: {
  artifactDir: string;
  registry: SmokeLifecycleRegistry;
  settlementId: string;
  settlementReason: string;
  settlementAtMs: number;
  closeOutcome: string;
  nowMs: number;
}): boolean {
  if (!isCleanCloseOutcome(input.closeOutcome)) return false;
  const terminalHandle = input.registry.terminalHandle;
  if (!terminalHandle) return false;
  const expectedSettlement = buildSmokeCloseSettlementIdentity(input.registry.runId);
  if (
    input.settlementId !== expectedSettlement.settlementId
    || input.settlementReason !== expectedSettlement.settlementReason
  ) return false;
  try {
    const current = readCloseReceipt(input.artifactDir, input.registry);
    if (
      current.state !== 'settlement_recorded'
      || current.receipt.settlementId !== input.settlementId
      || current.receipt.settlementReason !== input.settlementReason
      || current.receipt.settlementAtMs !== input.settlementAtMs
      || input.nowMs < current.receipt.closeAttemptedAtMs
    ) return false;
    writeAtomicJson(smokeCloseReceiptPath(input.artifactDir), {
      ...current.receipt,
      phase: 'closed',
      closeOutcome: input.closeOutcome,
      recordedAtMs: input.nowMs,
    } satisfies CloseReceipt);
    return true;
  } catch {
    return false;
  }
}

function receiptRoot(): string {
  return process.env.WORKER_SMOKE_RECEIPT_ROOT
    ?? join(homedir(), '.local', 'state', 'orchestrator-pack-wake-supervisor', 'worker-smoke-receipts');
}

function receiptKey(prNumber: number, headSha: string): string {
  return `pr-${prNumber}|${headSha.trim().toLowerCase()}`;
}

function legacyReceiptPath(prNumber: number, headSha: string): string {
  return join(receiptRoot(), `${receiptKey(prNumber, headSha)}.json`);
}

function validAttemptId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value);
}

function attemptReceiptPath(prNumber: number, headSha: string, attemptId: string): string {
  if (!validAttemptId(attemptId)) throw new Error('worker_smoke_receipt_attempt_id_invalid');
  return join(receiptRoot(), `${receiptKey(prNumber, headSha)}|${attemptId}.json`);
}

function explicitResolution(observed: string): string | undefined {
  const match = observed.match(/(?:^|;)resolution=([A-Za-z0-9._:-]{1,160})(?:;|$)/u);
  return match?.[1];
}

export function deriveWorkerSmokeFailureCause(
  report: SmokeReport,
): WorkerSmokeFailureCause | undefined {
  if (report.result === 'PASS') return undefined;
  const terminalRows = report.scenarios
    .map((scenario, index) => ({ scenario, index }))
    .filter(({ scenario }) => scenario.outcome === 'fail' || scenario.outcome === 'blocked');
  const selected = terminalRows.length === 1 ? terminalRows[0] : undefined;
  const structuredScenarioFamily = selected && isWorkerSmokeScenarioCauseFamily(selected.scenario.causeFamily)
    ? selected.scenario.causeFamily
    : undefined;
  const reportFamily = isWorkerSmokeCauseFamily(report.causeFamily) ? report.causeFamily : undefined;
  const explicitHarnessFamily = reportFamily && !isWorkerSmokeScenarioCauseFamily(reportFamily)
    ? reportFamily
    : undefined;
  const scenarioOwned = Boolean(selected && !explicitHarnessFamily);
  const causeFamily: WorkerSmokeCauseFamily = terminalRows.length > 1
    ? 'unknown'
    : explicitHarnessFamily ?? structuredScenarioFamily ?? (scenarioOwned ? 'unknown' : reportFamily ?? 'unknown');
  const action = scenarioOwned ? selected!.scenario.action.trim() : 'worker smoke harness';
  const expected = scenarioOwned ? selected!.scenario.expected.trim() : undefined;
  const observed = selected?.scenario.observed?.trim() || `result:${report.result.toLowerCase()}`;
  const resolution = explicitResolution(observed);
  return {
    phase: scenarioOwned ? 'scenario' : 'harness',
    causeFamily,
    code: causeFamily,
    ...(scenarioOwned && selected ? { scenarioOrdinal: selected.index + 1 } : {}),
    ...(selected?.scenario.outcome ? { outcome: selected.scenario.outcome } : {}),
    action,
    ...(scenarioOwned && expected ? { expected } : {}),
    observed,
    ...(resolution ? { resolution } : {}),
  };
}

const CARRIED_OBSERVED_PATTERN = /^carried PASS from head [0-9a-f]{40} comment \d+; not freshly executed on [0-9a-f]{40}$/u;

function freshAttemptObservationsFromReport(report: SmokeReport): WorkerSmokeAttemptObservation[] {
  return report.scenarios.flatMap((scenario) => {
    if (!scenario.outcome || scenario.outcome === 'skipped') return [];
    if (CARRIED_OBSERVED_PATTERN.test(String(scenario.observed ?? '').trim())) return [];
    const action = scenario.action.trim();
    const expected = scenario.expected.trim();
    if (!action || !expected) return [];
    const causeFamily = scenario.outcome === 'pass'
      ? undefined
      : isWorkerSmokeScenarioCauseFamily(scenario.causeFamily)
        ? scenario.causeFamily
        : 'unknown';
    return [{
      action,
      expected,
      outcome: scenario.outcome,
      ...(causeFamily ? { causeFamily } : {}),
    }];
  });
}

function normalizeAttemptObservations(
  observations: readonly WorkerSmokeAttemptObservation[],
): WorkerSmokeAttemptObservation[] {
  return observations.map((observation) => {
    const action = observation.action.trim();
    const expected = observation.expected.trim();
    if (!action || !expected || !['pass', 'fail', 'blocked'].includes(observation.outcome)) {
      throw new Error('worker_smoke_receipt_attempt_observation_invalid');
    }
    const nonPass = observation.outcome !== 'pass';
    const causeFamily = nonPass
      ? isWorkerSmokeScenarioCauseFamily(observation.causeFamily)
        ? observation.causeFamily
        : 'unknown'
      : undefined;
    return {
      action,
      expected,
      outcome: observation.outcome,
      ...(causeFamily ? { causeFamily } : {}),
    };
  });
}

export function validateWorkerSmokeOperatorOverrideReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error('worker_smoke_operator_override_blank');
  if (Buffer.byteLength(normalized, 'utf8') > 256) throw new Error('worker_smoke_operator_override_too_large');
  if (scrubSmokeOutput(normalized) !== normalized) throw new Error('worker_smoke_operator_override_contains_secret');
  return normalized;
}

function markWrapperReportWritten(): void {
  const path = process.env.WORKER_SMOKE_WRAPPER_STATE_FILE?.trim();
  if (!path) return;
  try {
    writeFileSync(path, 'report_written\n', 'utf8');
  } catch {
    // Wrapper fallback remains available if this best-effort marker cannot be written.
  }
}

export function writeWorkerSmokeReceipt(
  report: SmokeReport,
  options: WorkerSmokeReceiptWriteOptions = {},
): WorkerSmokeReceipt {
  const attemptId = String(options.attemptId ?? '').trim() || randomUUID();
  if (!validAttemptId(attemptId)) throw new Error('worker_smoke_receipt_attempt_id_invalid');
  const runId = String(options.runId ?? '').trim() || undefined;
  if (runId && !validAttemptId(runId)) throw new Error('worker_smoke_receipt_run_id_invalid');
  if (runId && runId !== attemptId) throw new Error('worker_smoke_receipt_run_attempt_mismatch');
  const executionMode = options.executionMode ?? (runId ? 'executed' : 'carry-only');
  if (executionMode === 'executed' && !runId) throw new Error('worker_smoke_receipt_executed_requires_run_id');
  if (executionMode === 'executed' && report.result === 'PASS' && !report.terminalHandle?.trim()) {
    throw new Error('worker_smoke_receipt_executed_pass_requires_terminal_handle');
  }
  const overrideReason = validateWorkerSmokeOperatorOverrideReason(options.operatorOverrideReason);
  const observations = normalizeAttemptObservations(
    options.attemptObservations ?? freshAttemptObservationsFromReport(report),
  );
  const failureCause = deriveWorkerSmokeFailureCause(report);
  const receipt: WorkerSmokeReceipt = {
    schema: WORKER_SMOKE_RECEIPT_SCHEMA,
    issueNumber: report.issueNumber,
    prNumber: report.prNumber,
    headSha: report.headSha.trim().toLowerCase(),
    terminalHandle: String(report.terminalHandle ?? '').trim(),
    orcaExecutable: String(report.orcaExecutable ?? '').trim(),
    producer: report.producer ?? SMOKE_REPORT_PRODUCER,
    result: report.result,
    publishedAt: options.publishedAt ?? new Date().toISOString(),
    attemptId,
    ...(runId ? { runId } : {}),
    executionMode,
    attemptObservations: observations,
    ...(overrideReason ? { operatorOverrideReason: overrideReason } : {}),
    ...(failureCause ? { failureCause } : {}),
  };
  mkdirSync(receiptRoot(), { recursive: true });
  writeCreateOnlyJson(attemptReceiptPath(report.prNumber, report.headSha, attemptId), receipt);
  markWrapperReportWritten();
  return receipt;
}

function parseWorkerSmokeFailureCause(raw: unknown): WorkerSmokeFailureCause | undefined {
  if (!isRecord(raw)) return undefined;
  const phase = raw.phase === 'harness' || raw.phase === 'scenario' ? raw.phase : undefined;
  const causeFamily = isWorkerSmokeCauseFamily(raw.causeFamily) ? raw.causeFamily : undefined;
  const code = String(raw.code ?? '').trim();
  const action = String(raw.action ?? '').trim();
  const observed = String(raw.observed ?? '').trim();
  const expected = String(raw.expected ?? '').trim() || undefined;
  const scenarioOrdinal = raw.scenarioOrdinal === undefined ? undefined : Number(raw.scenarioOrdinal);
  const outcome = typeof raw.outcome === 'string' && ['pass', 'fail', 'blocked'].includes(raw.outcome)
    ? raw.outcome as WorkerSmokeFailureCause['outcome']
    : undefined;
  const resolution = String(raw.resolution ?? '').trim() || undefined;
  if (!phase || !causeFamily || code !== causeFamily || !action || !observed) return undefined;
  if (phase === 'scenario') {
    if (!Number.isSafeInteger(scenarioOrdinal) || Number(scenarioOrdinal) <= 0 || !expected || !outcome) return undefined;
  } else if (scenarioOrdinal !== undefined || expected !== undefined) {
    return undefined;
  }
  return {
    phase,
    causeFamily,
    code,
    ...(scenarioOrdinal !== undefined ? { scenarioOrdinal } : {}),
    ...(outcome ? { outcome } : {}),
    action,
    ...(expected ? { expected } : {}),
    observed,
    ...(resolution ? { resolution } : {}),
  };
}

function parseWorkerSmokeReceipt(
  raw: unknown,
  prNumber: number,
  headSha: string,
): WorkerSmokeReceipt | null {
  if (!isRecord(raw) || raw.schema !== WORKER_SMOKE_RECEIPT_SCHEMA) return null;
  const normalizedHead = headSha.trim().toLowerCase();
  if (Number(raw.prNumber) !== prNumber || String(raw.headSha ?? '').trim().toLowerCase() !== normalizedHead) return null;
  if (!Number.isSafeInteger(Number(raw.issueNumber)) || Number(raw.issueNumber) <= 0) return null;
  if (!['PASS', 'FAIL', 'BLOCKED'].includes(String(raw.result ?? ''))) return null;
  const publishedAt = String(raw.publishedAt ?? '').trim();
  if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) return null;
  const attemptId = String(raw.attemptId ?? '').trim() || undefined;
  const runId = String(raw.runId ?? '').trim() || undefined;
  if (attemptId && !validAttemptId(attemptId)) return null;
  if (runId && (!attemptId || !validAttemptId(runId) || runId !== attemptId)) return null;
  const executionMode = raw.executionMode === 'executed' || raw.executionMode === 'carry-only'
    ? raw.executionMode
    : undefined;
  if (attemptId && !executionMode) return null;
  const terminalHandle = String(raw.terminalHandle ?? '').trim();
  if (attemptId && executionMode === 'executed' && !runId) return null;
  if (attemptId && executionMode === 'executed' && raw.result === 'PASS' && !terminalHandle) return null;
  let attemptObservations: WorkerSmokeAttemptObservation[] | undefined;
  if (attemptId) {
    if (!Array.isArray(raw.attemptObservations)) return null;
    try {
      attemptObservations = normalizeAttemptObservations(raw.attemptObservations as WorkerSmokeAttemptObservation[]);
    } catch {
      return null;
    }
  }
  let operatorOverrideReason: string | undefined;
  if (raw.operatorOverrideReason !== undefined) {
    if (typeof raw.operatorOverrideReason !== 'string') return null;
    try {
      operatorOverrideReason = validateWorkerSmokeOperatorOverrideReason(raw.operatorOverrideReason);
    } catch {
      return null;
    }
  }
  let failureCause: WorkerSmokeFailureCause | undefined;
  if (raw.failureCause !== undefined) {
    failureCause = parseWorkerSmokeFailureCause(raw.failureCause);
    if (!failureCause) return null;
  }
  const parsed: WorkerSmokeReceipt = {
    schema: WORKER_SMOKE_RECEIPT_SCHEMA,
    issueNumber: Number(raw.issueNumber),
    prNumber,
    headSha: normalizedHead,
    terminalHandle,
    orcaExecutable: String(raw.orcaExecutable ?? '').trim(),
    producer: String(raw.producer ?? '').trim(),
    result: raw.result as SmokeReport['result'],
    publishedAt,
    ...(attemptId ? { attemptId } : {}),
    ...(runId ? { runId } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(attemptObservations ? { attemptObservations } : {}),
    ...(operatorOverrideReason ? { operatorOverrideReason } : {}),
    ...(failureCause ? { failureCause } : {}),
  };
  return parsed;
}

function readReceiptFile(path: string, prNumber: number, headSha: string): WorkerSmokeReceipt | null {
  return parseWorkerSmokeReceipt(readJson(path), prNumber, headSha);
}

function compareReceipts(left: WorkerSmokeReceipt, right: WorkerSmokeReceipt): number {
  const byPublishedAt = Date.parse(left.publishedAt) - Date.parse(right.publishedAt);
  if (byPublishedAt !== 0) return byPublishedAt;
  return String(left.attemptId ?? '').localeCompare(String(right.attemptId ?? ''));
}

export function listWorkerSmokeReceipts(prNumber: number, headSha: string): WorkerSmokeReceipt[] {
  const root = receiptRoot();
  const receipts: WorkerSmokeReceipt[] = [];
  const legacy = readReceiptFile(legacyReceiptPath(prNumber, headSha), prNumber, headSha);
  if (legacy) receipts.push(legacy);
  if (existsSync(root)) {
    const prefix = `${receiptKey(prNumber, headSha)}|`;
    for (const entry of readdirSync(root).sort()) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
      const receipt = readReceiptFile(join(root, entry), prNumber, headSha);
      if (!receipt?.attemptId) continue;
      const fileAttemptId = entry.slice(prefix.length, -'.json'.length);
      if (receipt.attemptId !== fileAttemptId) continue;
      receipts.push(receipt);
    }
  }
  return receipts.sort(compareReceipts);
}

export function readWorkerSmokeReceipt(prNumber: number, headSha: string): WorkerSmokeReceipt | null {
  return listWorkerSmokeReceipts(prNumber, headSha).at(-1) ?? null;
}

export function readWorkerSmokeReceiptForAttempt(
  prNumber: number,
  headSha: string,
  attemptId: string,
): WorkerSmokeReceipt | null {
  const normalizedAttemptId = attemptId.trim();
  if (!validAttemptId(normalizedAttemptId)) return null;
  return readReceiptFile(
    attemptReceiptPath(prNumber, headSha, normalizedAttemptId),
    prNumber,
    headSha,
  );
}

export function latestWorkerSmokeAttemptObservation(
  receipts: readonly WorkerSmokeReceipt[],
  action: string,
  expected: string,
): WorkerSmokeAttemptObservation | undefined {
  const targetAction = action.trim();
  const targetExpected = expected.trim();
  let latest: WorkerSmokeAttemptObservation | undefined;
  for (const receipt of [...receipts].sort(compareReceipts)) {
    for (const observation of receipt.attemptObservations ?? []) {
      if (observation.action === targetAction && observation.expected === targetExpected) {
        latest = observation;
      }
    }
  }
  return latest;
}

export interface WorkerSmokeBlockedRetryAdmission {
  allowed: boolean;
  reason?: 'smoke_blocked_precondition_unchanged';
  blockedTuples: Array<{ action: string; expected: string; causeFamily: WorkerSmokeCauseFamily }>;
}

export function evaluateSameHeadBlockedRetryAdmission(input: {
  receipts: readonly WorkerSmokeReceipt[];
  selectedScenarios: readonly Pick<SmokeReport['scenarios'][number], 'action' | 'expected'>[];
  operatorOverrideReason?: string;
}): WorkerSmokeBlockedRetryAdmission {
  const blockedTuples = input.selectedScenarios.flatMap((scenario) => {
    const action = scenario.action.trim();
    const expected = scenario.expected.trim();
    const latest = latestWorkerSmokeAttemptObservation(input.receipts, action, expected);
    if (
      latest?.outcome === 'blocked'
      && (latest.causeFamily === 'scenario_precondition_unavailable'
        || latest.causeFamily === 'scenario_evidence_missing')
    ) {
      return [{ action, expected, causeFamily: latest.causeFamily }];
    }
    return [];
  });
  if (blockedTuples.length === 0) return { allowed: true, blockedTuples };
  if (input.operatorOverrideReason !== undefined) {
    validateWorkerSmokeOperatorOverrideReason(input.operatorOverrideReason);
    return { allowed: true, blockedTuples };
  }
  return { allowed: false, reason: 'smoke_blocked_precondition_unchanged', blockedTuples };
}

function legacyReceiptForExactTarget(prNumber: number, headSha: string): WorkerSmokeReceipt | null {
  const receipt = readReceiptFile(legacyReceiptPath(prNumber, headSha), prNumber, headSha);
  return receipt?.attemptId ? null : receipt;
}

export function workerSmokeReceiptMatchesReport(receipt: WorkerSmokeReceipt, report: SmokeReport): boolean {
  const expectedFailureCause = deriveWorkerSmokeFailureCause(report);
  return receipt.producer === SMOKE_REPORT_PRODUCER
    && receipt.issueNumber === report.issueNumber
    && receipt.prNumber === report.prNumber
    && receipt.headSha === report.headSha.trim().toLowerCase()
    && receipt.terminalHandle === String(report.terminalHandle ?? '').trim()
    && receipt.orcaExecutable === String(report.orcaExecutable ?? '').trim()
    && receipt.result === report.result
    && JSON.stringify(receipt.failureCause ?? null) === JSON.stringify(expectedFailureCause ?? null);
}

export function verifySmokeRunReceipt(
  report: SmokeReport,
  attemptId?: string,
  runId?: string,
): boolean {
  const normalizedAttemptId = attemptId?.trim();
  const receipt = normalizedAttemptId
    ? readWorkerSmokeReceiptForAttempt(report.prNumber, report.headSha, normalizedAttemptId)
    : legacyReceiptForExactTarget(report.prNumber, report.headSha);
  if (!receipt) return false;
  if (normalizedAttemptId && receipt.attemptId !== normalizedAttemptId) return false;
  if (receipt.runId) {
    if (receipt.runId !== receipt.attemptId) return false;
    if (runId !== undefined && receipt.runId !== runId.trim()) return false;
  } else if (runId !== undefined && runId.trim()) {
    return false;
  }
  if (receipt.attemptId && receipt.executionMode === 'executed' && !receipt.runId) return false;
  if (receipt.attemptId && receipt.executionMode === 'executed' && receipt.result === 'PASS' && !receipt.terminalHandle) return false;
  return workerSmokeReceiptMatchesReport(receipt, report);
}

export function verifySmokeReportReceiptProvenance(report: SmokeReport): boolean {
  const candidates = listWorkerSmokeReceipts(report.prNumber, report.headSha)
    .filter((receipt) => workerSmokeReceiptMatchesReport(receipt, report));
  if (candidates.length !== 1) return false;
  const receipt = candidates[0]!;
  return receipt.attemptId
    ? verifySmokeRunReceipt(report, receipt.attemptId, receipt.runId)
    : verifySmokeRunReceipt(report);
}
