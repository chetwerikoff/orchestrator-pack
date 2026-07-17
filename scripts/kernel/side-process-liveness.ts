import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from './subprocess.ts';

export const SIDE_PROCESS_PROGRESS_SCHEMA_VERSION = 2;
export const BOUNDED_EXTERNAL_CALL_SCHEMA = 'bounded-external-call/v1';
export const PENDING_TIMEOUT_EXIT_CODE = 20;
export const BOUNDED_TIMEOUT_EXIT_CODE = 124;

const MAX_TOKEN_LENGTH = 96;
const MAX_ERROR_LENGTH = 240;
const WORK_TOTAL_SENTINEL = 1_000_000;

export interface FleetLivenessChildContract {
  readonly id: string;
  readonly mode: 'wired' | 'exempt';
  readonly maxExternalCallTimeoutMs?: number;
  readonly externalCallKinds?: readonly string[];
  readonly maxLocalComputeGapMs?: number;
  readonly localProgressMode?: string;
  readonly evidence?: readonly string[];
  readonly exemptionReason?: string;
}

export interface FleetLivenessContractDocument {
  readonly schemaVersion: number;
  readonly regressionAnchors: readonly string[];
  readonly sharedTransports: Readonly<Record<string, string>>;
  readonly children: readonly FleetLivenessChildContract[];
}

export interface LivenessProgressRecord extends Record<string, unknown> {
  childId: string;
  lastProgressMs: number;
  phase: string;
  pid: number;
}

export interface ExternalCallRunnerOptions {
  readonly childId: string;
  readonly ownerPid: number;
  readonly callName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly progressDir?: string;
  readonly tickId?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly runner?: (options: RunProcessOptions) => Promise<ProcessResult>;
}

export interface LivenessCheckpointOptions {
  readonly childId: string;
  readonly ownerPid: number;
  readonly workStep: string;
  readonly progressDir?: string;
  readonly tickId?: string;
  readonly nowMs?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FLEET_LIVENESS_CONTRACT_PATH = resolve(
  moduleDir,
  '..',
  'orchestrator-side-process-liveness-contract.json',
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boundedText(value: unknown, maxLength: number): string {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function sanitizeLivenessToken(value: unknown, fallback = 'unknown'): string {
  const raw = boundedText(value, MAX_TOKEN_LENGTH) || fallback;
  const normalized = raw.replace(/[^A-Za-z0-9_.:-]/g, '_');
  return normalized.slice(0, MAX_TOKEN_LENGTH) || fallback;
}

export function loadFleetLivenessContract(
  contractPath = DEFAULT_FLEET_LIVENESS_CONTRACT_PATH,
): FleetLivenessContractDocument {
  const parsed = JSON.parse(readFileSync(contractPath, 'utf8')) as unknown;
  const record = asRecord(parsed);
  if (!record || !Array.isArray(record.children)) {
    throw new Error(`invalid fleet liveness contract: ${contractPath}`);
  }
  return parsed as FleetLivenessContractDocument;
}

let cachedDefaultContract: FleetLivenessContractDocument | null = null;

function defaultFleetLivenessContract(): FleetLivenessContractDocument {
  cachedDefaultContract ??= loadFleetLivenessContract();
  return cachedDefaultContract;
}

export function findFleetLivenessChildContract(
  childId: string,
  document?: FleetLivenessContractDocument,
): FleetLivenessChildContract | null {
  const resolvedDocument = document ?? defaultFleetLivenessContract();
  return resolvedDocument.children.find((entry) => entry.id === childId) ?? null;
}

export function resolveLivenessProgressPath(progressDir: string, childId: string): string {
  return resolve(progressDir, `${sanitizeLivenessToken(childId)}.progress.json`);
}

export function readLivenessProgressRecord(path: string): LivenessProgressRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const record = asRecord(parsed);
    if (!record) return null;
    return record as LivenessProgressRecord;
  } catch {
    return null;
  }
}

function writeAtomicProgressRecord(path: string, record: LivenessProgressRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function recentOutcomes(existing: Record<string, unknown> | null, ownerPid: number): string[] {
  if (!existing || asInteger(existing.pid) !== ownerPid || !Array.isArray(existing.recentOutcomes)) {
    return [];
  }
  return existing.recentOutcomes
    .filter((value): value is string => typeof value === 'string')
    .slice(-5);
}

function resolveTickId(
  explicitTickId: string | undefined,
  existing: Record<string, unknown> | null,
): string {
  const candidate = explicitTickId
    ?? process.env.AO_SIDE_PROCESS_TICK_ID
    ?? asString(existing?.tickId);
  return candidate ? sanitizeLivenessToken(candidate) : '';
}

function nextWorkCursor(
  existing: Record<string, unknown> | null,
  ownerPid: number,
  tickId: string,
): number {
  if (!existing || asInteger(existing.pid) !== ownerPid) return 1;
  const existingTick = asString(existing.tickId);
  if (tickId && existingTick && existingTick !== tickId) return 1;
  const prior = asInteger(existing.workCursor);
  return Math.max(1, prior + 1);
}

function carryPendingTimeout(
  target: LivenessProgressRecord,
  existing: Record<string, unknown> | null,
  ownerPid: number,
): void {
  if (!existing || asInteger(existing.pid) !== ownerPid || existing.boundedExternalCallPending !== true) {
    return;
  }
  const diagnostic = asRecord(existing.boundedExternalCall);
  if (diagnostic) target.boundedExternalCall = diagnostic;
  target.boundedExternalCallPending = true;
  target.failureClass = 'dependency';
  const lastError = boundedText(existing.lastError, MAX_ERROR_LENGTH);
  if (lastError) target.lastError = lastError;
  const reason = boundedText(existing.reason, MAX_ERROR_LENGTH);
  if (reason) target.reason = reason;
}

export function writeLivenessCheckpoint(options: LivenessCheckpointOptions): LivenessProgressRecord | null {
  const progressDir = options.progressDir ?? process.env.AO_SIDE_PROCESS_PROGRESS_DIR ?? '';
  if (!progressDir || !options.childId || options.ownerPid <= 0) return null;

  const path = resolveLivenessProgressPath(progressDir, options.childId);
  const existing = readLivenessProgressRecord(path);
  const tickId = resolveTickId(options.tickId, existing);
  const cursor = nextWorkCursor(existing, options.ownerPid, tickId);
  const record: LivenessProgressRecord = {
    childId: sanitizeLivenessToken(options.childId),
    lastProgressMs: options.nowMs ?? Date.now(),
    phase: 'external_call',
    pid: options.ownerPid,
    progressSchemaVersion: SIDE_PROCESS_PROGRESS_SCHEMA_VERSION,
    workStep: sanitizeLivenessToken(options.workStep, 'external_call'),
    workCursor: cursor,
    workTotal: Math.max(WORK_TOTAL_SENTINEL, cursor),
  };
  if (tickId) record.tickId = tickId;
  const outcomes = recentOutcomes(existing, options.ownerPid);
  if (outcomes.length > 0) record.recentOutcomes = outcomes;
  carryPendingTimeout(record, existing, options.ownerPid);
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    record[key] = value;
  }
  writeAtomicProgressRecord(path, record);
  return record;
}

export function recordExternalCallTimeout(options: {
  readonly childId: string;
  readonly ownerPid: number;
  readonly callName: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly progressDir?: string;
  readonly tickId?: string;
  readonly nowMs?: number;
}): LivenessProgressRecord | null {
  const callName = sanitizeLivenessToken(options.callName, 'external_call');
  const nowMs = options.nowMs ?? Date.now();
  const message = boundedText(
    `bounded external call timeout: ${callName} after ${Math.max(1, options.timeoutMs)}ms`,
    MAX_ERROR_LENGTH,
  );
  return writeLivenessCheckpoint({
    childId: options.childId,
    ownerPid: options.ownerPid,
    workStep: callName,
    progressDir: options.progressDir,
    tickId: options.tickId,
    nowMs,
    extra: {
      phase: 'external_call_timeout',
      boundedExternalCall: {
        schemaVersion: BOUNDED_EXTERNAL_CALL_SCHEMA,
        callName,
        outcome: 'timeout',
        timeoutMs: Math.max(1, Math.trunc(options.timeoutMs)),
        elapsedMs: Math.max(0, Math.trunc(options.elapsedMs)),
        observedAtMs: nowMs,
      },
      boundedExternalCallPending: true,
      failureClass: 'dependency',
      lastError: message,
      reason: message,
    },
  });
}

export function consumePendingExternalCallTimeout(options: {
  readonly childId: string;
  readonly ownerPid: number;
  readonly progressDir?: string;
}): string | null {
  const progressDir = options.progressDir ?? process.env.AO_SIDE_PROCESS_PROGRESS_DIR ?? '';
  if (!progressDir || !options.childId || options.ownerPid <= 0) return null;
  const path = resolveLivenessProgressPath(progressDir, options.childId);
  const existing = readLivenessProgressRecord(path);
  if (!existing || asInteger(existing.pid) !== options.ownerPid || existing.boundedExternalCallPending !== true) {
    return null;
  }

  const diagnostic = asRecord(existing.boundedExternalCall);
  const callName = sanitizeLivenessToken(diagnostic?.callName, 'external_call');
  const timeoutMs = Math.max(1, asInteger(diagnostic?.timeoutMs, 1));
  const message = boundedText(
    `bounded external call timeout: ${callName} after ${timeoutMs}ms`,
    MAX_ERROR_LENGTH,
  );
  const next: LivenessProgressRecord = {
    ...existing,
    boundedExternalCallPending: false,
    lastError: message,
    reason: message,
  } as LivenessProgressRecord;
  writeAtomicProgressRecord(path, next);
  return message;
}

function effectiveTimeoutMs(
  childId: string,
  requestedTimeoutMs: number | undefined,
  contract: FleetLivenessChildContract | null,
): number | undefined {
  const contractTimeout = contract?.mode === 'wired'
    ? asInteger(contract.maxExternalCallTimeoutMs)
    : 0;
  if (contractTimeout <= 0) return undefined;
  if (requestedTimeoutMs === undefined || requestedTimeoutMs <= 0) return contractTimeout;
  return Math.min(contractTimeout, Math.max(1, Math.trunc(requestedTimeoutMs)));
}

export async function runExternalCallWithLiveness(
  options: ExternalCallRunnerOptions,
): Promise<ProcessResult> {
  const now = options.now ?? Date.now;
  const runner = options.runner ?? runProcess;
  const contract = findFleetLivenessChildContract(options.childId);
  const timeoutMs = effectiveTimeoutMs(options.childId, options.timeoutMs, contract);
  const startedAtMs = now();
  if (contract?.mode === 'wired') {
    writeLivenessCheckpoint({
      childId: options.childId,
      ownerPid: options.ownerPid,
      workStep: `${options.callName}:start`,
      progressDir: options.progressDir,
      tickId: options.tickId,
      nowMs: startedAtMs,
      extra: {
        activeExternalCall: {
          callName: sanitizeLivenessToken(options.callName, 'external_call'),
          timeoutMs,
          startedAtMs,
        },
      },
    });
  }
  const result = await runner({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    inheritParentEnv: true,
    timeoutMs,
    allowEmptyStdout: true,
  });
  const completedAtMs = now();
  const elapsedMs = Math.max(0, completedAtMs - startedAtMs);

  if (result.outcome === 'timeout' || result.timedOut) {
    if (timeoutMs !== undefined) {
      recordExternalCallTimeout({
        childId: options.childId,
        ownerPid: options.ownerPid,
        callName: options.callName,
        timeoutMs,
        elapsedMs,
        progressDir: options.progressDir,
        tickId: options.tickId,
        nowMs: completedAtMs,
      });
    }
    return result;
  }

  if (contract?.mode === 'wired') {
    writeLivenessCheckpoint({
      childId: options.childId,
      ownerPid: options.ownerPid,
      workStep: options.callName,
      progressDir: options.progressDir,
      tickId: options.tickId,
      nowMs: completedAtMs,
      extra: {
        lastExternalCall: {
          callName: sanitizeLivenessToken(options.callName, 'external_call'),
          outcome: sanitizeLivenessToken(result.outcome),
          elapsedMs: Math.trunc(elapsedMs),
        },
      },
    });
  }
  return result;
}

function parseOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? String(args[index + 1]) : '';
}

function parsePositiveIntegerOption(args: readonly string[], name: string, fallback: number): number {
  const raw = parseOption(args, name);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function resolveCliIdentity(args: readonly string[]): {
  childId: string;
  ownerPid: number;
  tickId: string;
  progressDir: string;
} {
  return {
    childId: sanitizeLivenessToken(
      parseOption(args, '--child-id') || process.env.AO_SIDE_PROCESS_CHILD_ID,
      'unknown',
    ),
    ownerPid: parsePositiveIntegerOption(
      args,
      '--owner-pid',
      asInteger(process.env.AO_SIDE_PROCESS_OWNER_PID, process.ppid),
    ),
    tickId: parseOption(args, '--tick-id') || process.env.AO_SIDE_PROCESS_TICK_ID || '',
    progressDir: parseOption(args, '--progress-dir') || process.env.AO_SIDE_PROCESS_PROGRESS_DIR || '',
  };
}

function exitCodeForResult(result: ProcessResult): number {
  if (result.outcome === 'timeout' || result.timedOut) return BOUNDED_TIMEOUT_EXIT_CODE;
  if (result.outcome === 'spawn-failure') return 127;
  if (result.exitCode !== null) return result.exitCode;
  return result.ok ? 0 : 1;
}

async function runCallCli(args: readonly string[]): Promise<number> {
  const separator = args.indexOf('--');
  if (separator < 0 || separator + 1 >= args.length) {
    throw new Error('call requires `-- <command> [args...]`');
  }
  const identity = resolveCliIdentity(args.slice(0, separator));
  const command = String(args[separator + 1]);
  const commandArgs = args.slice(separator + 2);
  const callName = parseOption(args.slice(0, separator), '--call-name') || command;
  const requestedTimeoutMs = parsePositiveIntegerOption(
    args.slice(0, separator),
    '--timeout-ms',
    0,
  );
  const result = await runExternalCallWithLiveness({
    ...identity,
    callName,
    command,
    args: commandArgs,
    timeoutMs: requestedTimeoutMs > 0 ? requestedTimeoutMs : undefined,
  });
  if (result.outcome === 'timeout' || result.timedOut) {
    const contract = findFleetLivenessChildContract(identity.childId);
    const timeoutMs = effectiveTimeoutMs(identity.childId, requestedTimeoutMs || undefined, contract) ?? 0;
    process.stderr.write(
      `bounded external call timeout: ${sanitizeLivenessToken(callName)} after ${timeoutMs}ms\n`,
    );
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error && !result.stderr) process.stderr.write(`${boundedText(result.error, MAX_ERROR_LENGTH)}\n`);
  }
  return exitCodeForResult(result);
}

function runCheckpointCli(args: readonly string[]): number {
  const identity = resolveCliIdentity(args);
  const workStep = parseOption(args, '--work-step') || 'checkpoint';
  const contract = findFleetLivenessChildContract(identity.childId);
  if (contract?.mode === 'wired') {
    writeLivenessCheckpoint({ ...identity, workStep });
  }
  return 0;
}

function runConsumeTimeoutCli(args: readonly string[]): number {
  const identity = resolveCliIdentity(args);
  const message = consumePendingExternalCallTimeout(identity);
  if (!message) return 0;
  process.stdout.write(`${message}\n`);
  return PENDING_TIMEOUT_EXIT_CODE;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? '';
  switch (command) {
    case 'call':
      return runCallCli(argv.slice(1));
    case 'checkpoint':
      return runCheckpointCli(argv.slice(1));
    case 'consume-timeout':
      return runConsumeTimeoutCli(argv.slice(1));
    case 'contract':
      process.stdout.write(`${JSON.stringify(loadFleetLivenessContract())}\n`);
      return 0;
    default:
      throw new Error(`unknown side-process-liveness command: ${command || '<empty>'}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${boundedText(message, MAX_ERROR_LENGTH)}\n`);
    process.exitCode = 1;
  }
}
