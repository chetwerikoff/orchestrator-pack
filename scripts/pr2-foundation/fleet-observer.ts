import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  RUNTIME_LIVENESS_RESULTS,
  sameRuntimeWorker,
  runtimeFailure,
  type RuntimeAdapter,
  type RuntimeBoundedOutput,
  type RuntimeCallOptions,
  type RuntimeLiveness,
  type RuntimeLivenessResult,
  type RuntimeObservationToken,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
  type RuntimeWorkerProvenance,
} from '../runtime/contracts.ts';
import type { FleetAssignmentBinding } from './fleet-assignment-binding.ts';

export const MAX_UNITS = 256 as const;
export const MAX_SNAPSHOT_BYTES = 1_048_576 as const;
export const DEFAULT_LIVELOCK_TICKS = 60 as const;
export const DEFAULT_PHASE_BUDGET_MS = 5_000 as const;
export const DEFAULT_MAX_CONCURRENCY = 8 as const;
export const MAX_CONCURRENCY = 32 as const;
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const OBSERVER_CLASSES = ['busy', 'livelock', 'idle', 'exempt', 'unknown'] as const;
export type ObserverClass = (typeof OBSERVER_CLASSES)[number];
export type ExceptionKind = 'HELD' | 'FOREIGN' | 'OWED' | 'STANDDOWN';
export type TransitionKind = 'unit-appeared' | 'unit-disappeared' | 'class-changed';

type MaybePromise<T> = T | PromiseLike<T>;
type RecordValue = Record<string, unknown>;

export interface FleetObserverSource {
  listWorkers(input: { readonly workspace?: 'active' | string }, options?: RuntimeCallOptions): MaybePromise<RuntimeResult<readonly RuntimeWorker[]>>;
  findWorker(identity: RuntimeWorkerIdentity, options?: RuntimeCallOptions): MaybePromise<RuntimeResult<RuntimeWorker | null>>;
  readBoundedOutput(input: {
    readonly worker: RuntimeWorkerIdentity;
    readonly previousToken?: RuntimeObservationToken | null;
    readonly limit?: number;
  }, options?: RuntimeCallOptions): MaybePromise<RuntimeResult<RuntimeBoundedOutput>>;
  liveness(input: {
    readonly worker: RuntimeWorkerIdentity;
    readonly observationWindowMs: number;
  }, options?: RuntimeCallOptions): MaybePromise<RuntimeLivenessResult>;
}

export type RuntimeNeutralFleetSource = Pick<RuntimeAdapter, 'listWorkers' | 'findWorker' | 'readBoundedOutput' | 'liveness'>;

export interface FleetObserverConfig {
  readonly schemaVersion: 1;
  readonly livelockTicks: number;
  readonly phaseBudgetMs?: number;
  readonly maxConcurrency: number;
  readonly exceptions: readonly FleetObserverException[];
}

export interface FleetObserverException {
  readonly kind: ExceptionKind;
  readonly schedulerGeneration: string;
  readonly unitRef: string;
}

export interface ProbeOutcomes {
  readonly output: 'valid' | 'failed' | 'expired';
  readonly liveness: RuntimeLiveness | 'failed' | 'expired';
}

export interface CensusRow {
  readonly unitRef: string;
  readonly provenance: RuntimeWorkerProvenance;
  readonly class: ObserverClass;
  readonly reason: string;
  readonly probes: ProbeOutcomes;
  readonly livelockStreak: number;
}

export interface FleetTransition {
  readonly type: TransitionKind;
  readonly unitRef: string;
  readonly tickSequence: number;
  readonly reason: string;
  readonly fromClass?: ObserverClass;
  readonly toClass?: ObserverClass;
}

export interface FleetProgress {
  readonly type: 'tick-complete' | 'tick-failed';
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
  readonly at: string;
  readonly reason?: string;
}

export interface FleetObserverContinuityRow {
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly unitRef: string;
  readonly class: ObserverClass | null;
  readonly livelockStreak: number;
  readonly hasBaseline: boolean;
  readonly outputDigest: string | null;
}

export interface FleetObserverSnapshot {
  readonly schemaVersion: 1;
  readonly commitStatus: 'complete';
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly configuredBudgetMs: number | null;
  readonly effectiveBudgetMs: number;
  readonly settlementReserveMs: number;
  readonly maxUnits: 256;
  readonly maxSnapshotBytes: 1_048_576;
  readonly result: 'complete' | 'failed';
  readonly census: readonly CensusRow[];
  readonly transitions: readonly FleetTransition[];
  readonly progress: readonly FleetProgress[];
  /** Present only for bounded-child continuity mode. Contains no runtime-private identity. */
  readonly activationLineage?: string;
  readonly continuity?: readonly FleetObserverContinuityRow[];
}

export interface FleetObserverTickInput {
  readonly schedulerIntervalMs: number;
  readonly tickSequence?: number;
  readonly phaseStartMs?: number;
}

export interface FleetObserverResult {
  readonly result: 'census-published-observer-only' | 'observer-failed';
  readonly status: 'complete' | 'failed';
  readonly reason?: string;
  readonly snapshotCommitted: boolean;
  readonly snapshotPath: string;
  readonly schedulerGeneration: string;
  readonly tickSequence: number;
  readonly effectiveBudgetMs: number;
  readonly schedulerReturnedWithinBudget: boolean;
  readonly staleCompletionRejected: boolean;
  readonly fleetCapFailClosed: boolean;
  readonly goneSemanticsClosed: boolean;
  readonly exceptionCollisionRejected: boolean;
  readonly zeroActuation: true;
  readonly snapshot?: FleetObserverSnapshot;
}

interface InMemoryUnit {
  readonly identity: RuntimeWorkerIdentity;
  readonly unitRef: string;
  readonly provenance: RuntimeWorkerProvenance;
  assignmentId?: string;
  assignmentGeneration?: number;
  token: RuntimeObservationToken | null;
  hasBaseline: boolean;
  outputDigest: string | null;
  livelockStreak: number;
  class: ObserverClass | null;
  present: boolean;
}

interface ParsedSnapshotResult { snapshot: FleetObserverSnapshot | null; rawBytes: string | null }

type ConfigResult = { readonly ok: true; readonly config: FleetObserverConfig } | { readonly ok: false; readonly reason: string };
interface BoundedCall<T> { readonly completed: boolean; readonly value?: T }

const UNIT_REF_PATTERN = /^u-[0-9]{1,9}$/u;
const GENERATION_PATTERN = /^sg-[A-Za-z0-9._~-]{1,80}$/u;
const REASON_PATTERN = /^[a-z0-9-]{1,80}$/u;
const LINEAGE_PATTERN = /^al-[a-f0-9]{16,64}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const EXCEPTION_KINDS = new Set<ExceptionKind>(['HELD', 'FOREIGN', 'OWED', 'STANDDOWN']);
const UNKNOWN_ROW_REASONS = new Set([
  'identity-contradiction', 'observation-failed', 'phase-budget-expired', 'liveness-unknown',
  'missing-output-baseline', 'busy-without-progress', 'unsupported-liveness', 'contradictory-gone',
]);
const SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'commitStatus', 'schedulerGeneration', 'tickSequence', 'startedAt', 'completedAt',
  'configuredBudgetMs', 'effectiveBudgetMs', 'settlementReserveMs', 'maxUnits', 'maxSnapshotBytes',
  'result', 'census', 'transitions', 'progress', 'activationLineage', 'continuity',
]);

function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hasOnlyKeys(value: RecordValue, keys: Set<string>): boolean { return Object.keys(value).every((key) => keys.has(key)); }
function positiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function boundedString(value: unknown, pattern: RegExp): value is string { return typeof value === 'string' && pattern.test(value); }
function sameIdentity(left: RuntimeWorkerIdentity, right: RuntimeWorkerIdentity): boolean { return sameRuntimeWorker(left, right); }
function sameLogicalWorker(left: RuntimeWorkerIdentity, right: RuntimeWorkerIdentity): boolean { return left.runtime === right.runtime && left.id === right.id; }
function iso(ms: number): string { return new Date(ms).toISOString(); }
function outputDigest(lines: readonly string[]): string { return createHash('sha256').update(JSON.stringify(lines), 'utf8').digest('hex'); }

function effectiveBudget(config: FleetObserverConfig, schedulerIntervalMs: number) {
  const interval = Math.max(1, Math.floor(schedulerIntervalMs));
  const effectiveBudgetMs = Math.min(config.phaseBudgetMs ?? DEFAULT_PHASE_BUDGET_MS, Math.max(1, Math.floor(interval / 4)));
  return {
    configuredBudgetMs: config.phaseBudgetMs ?? null,
    effectiveBudgetMs,
    settlementReserveMs: Math.min(250, Math.max(1, Math.floor(effectiveBudgetMs / 5))),
  };
}

function defaultConfig(): FleetObserverConfig {
  return { schemaVersion: 1, livelockTicks: DEFAULT_LIVELOCK_TICKS, maxConcurrency: DEFAULT_MAX_CONCURRENCY, exceptions: [] };
}

function parseConfigValue(raw: unknown): ConfigResult {
  if (raw === undefined) return { ok: true, config: defaultConfig() };
  if (!isRecord(raw) || !hasOnlyKeys(raw, new Set(['schemaVersion', 'livelockTicks', 'phaseBudgetMs', 'maxConcurrency', 'exceptions']))) return { ok: false, reason: 'invalid-config' };
  if (raw.schemaVersion !== 1) return { ok: false, reason: 'invalid-config-schema' };
  if (raw.livelockTicks !== undefined && !positiveInteger(raw.livelockTicks)) return { ok: false, reason: 'invalid-livelock-threshold' };
  if (raw.phaseBudgetMs !== undefined && !positiveInteger(raw.phaseBudgetMs)) return { ok: false, reason: 'invalid-phase-budget' };
  if (raw.maxConcurrency !== undefined && (typeof raw.maxConcurrency !== 'number' || !Number.isInteger(raw.maxConcurrency) || raw.maxConcurrency < 1 || raw.maxConcurrency > MAX_CONCURRENCY)) return { ok: false, reason: 'invalid-max-concurrency' };
  const exceptions = raw.exceptions ?? [];
  if (!Array.isArray(exceptions)) return { ok: false, reason: 'invalid-exceptions' };
  const seen = new Set<string>();
  const parsed: FleetObserverException[] = [];
  for (const candidate of exceptions) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, new Set(['kind', 'schedulerGeneration', 'unitRef']))
      || !EXCEPTION_KINDS.has(candidate.kind as ExceptionKind)
      || !boundedString(candidate.schedulerGeneration, GENERATION_PATTERN)
      || !boundedString(candidate.unitRef, UNIT_REF_PATTERN)) return { ok: false, reason: 'invalid-exception' };
    const key = `${candidate.schedulerGeneration}\u0000${candidate.unitRef}`;
    if (seen.has(key)) return { ok: false, reason: 'duplicate-exception' };
    seen.add(key);
    parsed.push({ kind: candidate.kind as ExceptionKind, schedulerGeneration: candidate.schedulerGeneration, unitRef: candidate.unitRef });
  }
  return {
    ok: true,
    config: {
      schemaVersion: 1,
      livelockTicks: raw.livelockTicks as number | undefined ?? DEFAULT_LIVELOCK_TICKS,
      ...(raw.phaseBudgetMs === undefined ? {} : { phaseBudgetMs: raw.phaseBudgetMs as number }),
      maxConcurrency: raw.maxConcurrency as number | undefined ?? DEFAULT_MAX_CONCURRENCY,
      exceptions: parsed,
    },
  };
}

function validCensus(candidate: unknown): candidate is CensusRow {
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, new Set(['unitRef', 'provenance', 'class', 'reason', 'probes', 'livelockStreak']))
    || !boundedString(candidate.unitRef, UNIT_REF_PATTERN)
    || (candidate.provenance !== 'internal' && candidate.provenance !== 'external')
    || !OBSERVER_CLASSES.includes(candidate.class as ObserverClass)
    || !boundedString(candidate.reason, REASON_PATTERN)
    || !isRecord(candidate.probes) || !hasOnlyKeys(candidate.probes, new Set(['output', 'liveness']))
    || !['valid', 'failed', 'expired'].includes(String(candidate.probes.output))
    || ![...RUNTIME_LIVENESS_RESULTS, 'failed', 'expired'].includes(String(candidate.probes.liveness))
    || !Number.isInteger(candidate.livelockStreak) || Number(candidate.livelockStreak) < 0) return false;
  const row = candidate as unknown as CensusRow;
  if ((row.class === 'busy' || row.class === 'livelock') && (row.probes.output !== 'valid' || row.probes.liveness !== 'busy')) return false;
  if (row.class === 'idle' && (row.probes.output !== 'valid' || row.probes.liveness !== 'idle')) return false;
  if (row.class === 'exempt' && (row.probes.output !== 'valid' || !['busy', 'idle'].includes(row.probes.liveness))) return false;
  if (row.class === 'unknown' && !UNKNOWN_ROW_REASONS.has(row.reason)) return false;
  return true;
}

function validContinuity(value: unknown): value is FleetObserverContinuityRow {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['assignmentId', 'assignmentGeneration', 'unitRef', 'class', 'livelockStreak', 'hasBaseline', 'outputDigest']))) return false;
  return typeof value.assignmentId === 'string' && value.assignmentId.length > 0 && value.assignmentId.length <= 160
    && positiveInteger(value.assignmentGeneration)
    && boundedString(value.unitRef, UNIT_REF_PATTERN)
    && (value.class === null || OBSERVER_CLASSES.includes(value.class as ObserverClass))
    && Number.isInteger(value.livelockStreak) && Number(value.livelockStreak) >= 0
    && typeof value.hasBaseline === 'boolean'
    && (value.outputDigest === null || boundedString(value.outputDigest, DIGEST_PATTERN));
}

function parseSnapshot(rawBytes: string): FleetObserverSnapshot | null {
  if (Buffer.byteLength(rawBytes, 'utf8') > MAX_SNAPSHOT_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(rawBytes); } catch { return null; }
  if (!isRecord(value) || !hasOnlyKeys(value, SNAPSHOT_KEYS)) return null;
  if (value.schemaVersion !== 1 || value.commitStatus !== 'complete' || !boundedString(value.schedulerGeneration, GENERATION_PATTERN)
    || !positiveInteger(value.tickSequence) || typeof value.startedAt !== 'string' || typeof value.completedAt !== 'string'
    || (value.configuredBudgetMs !== null && !positiveInteger(value.configuredBudgetMs)) || !positiveInteger(value.effectiveBudgetMs)
    || !positiveInteger(value.settlementReserveMs) || value.maxUnits !== MAX_UNITS || value.maxSnapshotBytes !== MAX_SNAPSHOT_BYTES
    || (value.result !== 'complete' && value.result !== 'failed') || !Array.isArray(value.census)
    || !Array.isArray(value.transitions) || !Array.isArray(value.progress) || value.census.length > MAX_UNITS
    || value.transitions.length > MAX_UNITS || value.progress.length > MAX_UNITS) return null;
  if (value.activationLineage !== undefined && !boundedString(value.activationLineage, LINEAGE_PATTERN)) return null;
  if (value.continuity !== undefined && (!Array.isArray(value.continuity) || value.continuity.length > MAX_UNITS || !value.continuity.every(validContinuity))) return null;
  if (Array.isArray(value.continuity)) {
    const unitRefs = new Set<string>();
    const assignments = new Set<string>();
    for (const row of value.continuity as FleetObserverContinuityRow[]) {
      const assignmentKey = `${row.assignmentId}\u0000${row.assignmentGeneration}`;
      if (unitRefs.has(row.unitRef) || assignments.has(assignmentKey)) return null;
      unitRefs.add(row.unitRef);
      assignments.add(assignmentKey);
    }
  }
  const started = Date.parse(value.startedAt); const completed = Date.parse(value.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || Number(value.settlementReserveMs) > Number(value.effectiveBudgetMs)) return null;
  const refs = new Set<string>();
  for (const row of value.census) {
    if (!validCensus(row) || refs.has(row.unitRef as string)) return null;
    refs.add(row.unitRef as string);
  }
  const transitionKeys = new Set<string>();
  for (const raw of value.transitions) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, new Set(['type', 'unitRef', 'tickSequence', 'reason', 'fromClass', 'toClass']))
      || !['unit-appeared', 'unit-disappeared', 'class-changed'].includes(String(raw.type))
      || !boundedString(raw.unitRef, UNIT_REF_PATTERN) || !positiveInteger(raw.tickSequence)
      || Number(raw.tickSequence) > Number(value.tickSequence)
      || !boundedString(raw.reason, REASON_PATTERN)
      || (raw.fromClass !== undefined && !OBSERVER_CLASSES.includes(raw.fromClass as ObserverClass))
      || (raw.toClass !== undefined && !OBSERVER_CLASSES.includes(raw.toClass as ObserverClass))) return null;
    if (raw.type === 'class-changed'
      ? raw.fromClass === undefined || raw.toClass === undefined || raw.fromClass === raw.toClass
      : raw.fromClass !== undefined || raw.toClass !== undefined) return null;
    const key = JSON.stringify([raw.type, raw.unitRef, raw.tickSequence, raw.reason, raw.fromClass ?? null, raw.toClass ?? null]);
    if (transitionKeys.has(key)) return null;
    transitionKeys.add(key);
  }
  const progressKeys = new Set<string>();
  const progress = value.progress as unknown[];
  for (const raw of progress) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, new Set(['type', 'schedulerGeneration', 'tickSequence', 'at', 'reason']))
      || (raw.type !== 'tick-complete' && raw.type !== 'tick-failed')
      || raw.schedulerGeneration !== value.schedulerGeneration || !boundedString(raw.schedulerGeneration, GENERATION_PATTERN)
      || !positiveInteger(raw.tickSequence) || Number(raw.tickSequence) > Number(value.tickSequence)
      || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))
      || (raw.reason !== undefined && !boundedString(raw.reason, REASON_PATTERN))
      || (raw.type === 'tick-complete' && raw.reason !== undefined)
      || (raw.type === 'tick-failed' && raw.reason === undefined)) return null;
    const key = JSON.stringify([raw.type, raw.schedulerGeneration, raw.tickSequence, raw.reason ?? null]);
    if (progressKeys.has(key)) return null;
    progressKeys.add(key);
  }
  const terminalProgress = progress.filter((raw) => isRecord(raw) && raw.tickSequence === value.tickSequence);
  const last = progress.at(-1);
  if (terminalProgress.length !== 1 || !isRecord(last) || last.tickSequence !== value.tickSequence
    || last.schedulerGeneration !== value.schedulerGeneration
    || (value.result === 'complete' && last.type !== 'tick-complete')
    || (value.result === 'failed' && last.type !== 'tick-failed')) return null;
  return value as unknown as FleetObserverSnapshot;
}

function readSnapshot(file: string): ParsedSnapshotResult {
  if (!existsSync(file)) return { snapshot: null, rawBytes: null };
  try {
    const rawBytes = readFileSync(file, 'utf8');
    return { snapshot: parseSnapshot(rawBytes), rawBytes };
  } catch { return { snapshot: null, rawBytes: null }; }
}

export function isAcceptedFleetSnapshot(rawBytes: string): boolean { return parseSnapshot(rawBytes) !== null; }
export function serializeFleetSnapshot(snapshot: FleetObserverSnapshot): string { return `${JSON.stringify(snapshot, null, 2)}\n`; }
export function snapshotByteLength(snapshot: FleetObserverSnapshot): number { return Buffer.byteLength(serializeFleetSnapshot(snapshot), 'utf8'); }
export function calculateFleetObserverBudget(config: { readonly phaseBudgetMs?: number }, schedulerIntervalMs: number) {
  return effectiveBudget({ ...defaultConfig(), ...config }, schedulerIntervalMs);
}

function defaultSnapshotPath(): string {
  const base = process.env.OPK_SIDE_PROCESS_STATE_DIR?.trim() || path.join(os.homedir(), '.orchestrator-pack', 'state');
  return path.join(base, 'fleet-observer-snapshot.json');
}

function generateGeneration(): string { return `sg-${randomBytes(12).toString('hex')}`; }

function configFromFile(file?: string): ConfigResult {
  if (!file || !existsSync(file)) return { ok: true, config: defaultConfig() };
  try { return parseConfigValue(JSON.parse(readFileSync(file, 'utf8')) as unknown); } catch { return { ok: false, reason: 'invalid-config' }; }
}

function outputShapeValid(value: RuntimeBoundedOutput, expected: RuntimeWorkerIdentity): boolean {
  return sameIdentity(value.worker, expected) && Array.isArray(value.lines) && value.lines.every((line) => typeof line === 'string')
    && isRecord(value.observationToken) && hasOnlyKeys(value.observationToken as unknown as RecordValue, new Set(['opaque']))
    && typeof value.observationToken.opaque === 'string' && typeof value.changed === 'boolean'
    && ['running', 'exited', 'unknown'].includes(value.terminalState);
}

function livenessShapeValid(value: RuntimeLivenessResult, expected: RuntimeWorkerIdentity): boolean {
  return RUNTIME_LIVENESS_RESULTS.includes(value.status) && sameIdentity(value.worker, expected);
}

async function beforeDeadline<T>(action: () => MaybePromise<T>, deadlineMs: number, now: () => number): Promise<BoundedCall<T>> {
  const remaining = Math.floor(deadlineMs - now());
  if (remaining <= 0) return { completed: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedCall<T>>((resolve) => { timer = setTimeout(() => resolve({ completed: false }), remaining); });
  const operation = Promise.resolve().then(action).then((value): BoundedCall<T> => now() <= deadlineMs ? { completed: true, value } : { completed: false }).catch(() => ({ completed: true, value: undefined as T }));
  const result = await Promise.race([operation, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

function atomicCommit(file: string, snapshot: FleetObserverSnapshot): boolean {
  const bytes = serializeFleetSnapshot(snapshot);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_SNAPSHOT_BYTES) return false;
  const directory = path.dirname(file); mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(temporary, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const readBack = readFileSync(file, 'utf8');
    return readBack === bytes && isAcceptedFleetSnapshot(readBack);
  } catch {
    rmSync(temporary, { force: true });
    return false;
  }
}

export interface FleetObserverOptions {
  readonly source: FleetObserverSource;
  readonly config?: unknown;
  readonly configPath?: string;
  readonly snapshotPath?: string;
  readonly generationFactory?: () => string;
  readonly now?: () => number;
  /** Hash/digest of the current activation epoch. Enables bounded-child continuity. */
  readonly activationLineage?: string;
  /** Exact current assignment/runtime bindings; raw worker identity is never persisted. */
  readonly assignmentBindings?: readonly FleetAssignmentBinding[];
}

export class FleetObserver {
  readonly source: FleetObserverSource;
  readonly snapshotPath: string;
  readonly schedulerGeneration: string;
  readonly #configPath?: string;
  readonly #inlineConfig?: unknown;
  readonly #now: () => number;
  readonly #activationLineage?: string;
  readonly #assignmentBindings: readonly FleetAssignmentBinding[];
  readonly #states = new Map<string, InMemoryUnit>();
  readonly #restoredContinuity: readonly FleetObserverContinuityRow[];
  #tickSequence = 0;
  #unitCounter = 0;
  #latestRequestedSequence = 0;
  #cancelVersion = 0;
  #exceptionCollisionRejected = false;

  constructor(options: FleetObserverOptions) {
    this.source = options.source;
    this.snapshotPath = options.snapshotPath ?? defaultSnapshotPath();
    this.#configPath = options.configPath;
    this.#inlineConfig = options.config;
    this.#now = options.now ?? Date.now;
    this.#activationLineage = options.activationLineage;
    this.#assignmentBindings = options.assignmentBindings ?? [];
    const previous = readSnapshot(this.snapshotPath).snapshot;
    const continueLineage = Boolean(this.#activationLineage && previous?.activationLineage === this.#activationLineage);
    if (continueLineage && previous) {
      this.schedulerGeneration = previous.schedulerGeneration;
      this.#tickSequence = previous.tickSequence;
      this.#latestRequestedSequence = previous.tickSequence;
      this.#restoredContinuity = previous.continuity ?? [];
    } else {
      this.#restoredContinuity = [];
      const forbidden = new Set([previous?.schedulerGeneration].filter(Boolean));
      let generated = '';
      for (let attempt = 0; attempt < 16; attempt += 1) {
        generated = (options.generationFactory ?? generateGeneration)();
        if (boundedString(generated, GENERATION_PATTERN) && !forbidden.has(generated)) break;
        generated = '';
      }
      if (!generated) throw new Error('invalid-scheduler-generation');
      this.schedulerGeneration = generated;
    }
  }

  getEffectiveBudgetMs(schedulerIntervalMs: number): number {
    const parsed = this.#readConfig();
    return effectiveBudget(parsed.ok ? parsed.config : defaultConfig(), schedulerIntervalMs).effectiveBudgetMs;
  }

  cancel(): void { this.#cancelVersion += 1; }

  #readConfig(): ConfigResult {
    if (this.#inlineConfig !== undefined) return parseConfigValue(this.#inlineConfig);
    return configFromFile(this.#configPath);
  }

  #nextUnitRef(): string { this.#unitCounter += 1; return `u-${String(this.#unitCounter).padStart(6, '0')}`; }

  #restore(workers: readonly RuntimeWorker[]): boolean {
    if (!this.#activationLineage || this.#restoredContinuity.length === 0 || this.#states.size > 0) return true;
    const used = new Set<string>();
    for (const binding of this.#assignmentBindings) {
      const worker = workers.find((candidate) => sameIdentity(candidate.identity, binding.worker));
      if (!worker) continue;
      const prior = this.#restoredContinuity.find((row) => row.assignmentId === binding.assignmentId && row.assignmentGeneration === binding.assignmentGeneration);
      if (!prior) continue;
      if (prior.unitRef !== binding.unitRef || used.has(prior.unitRef)) return false;
      used.add(prior.unitRef);
      const numeric = Number(prior.unitRef.slice(2)); if (Number.isInteger(numeric)) this.#unitCounter = Math.max(this.#unitCounter, numeric);
      this.#states.set(this.#identityKey(worker.identity), {
        identity: worker.identity, unitRef: prior.unitRef, provenance: worker.provenance,
        assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration,
        token: null, hasBaseline: prior.hasBaseline, outputDigest: prior.outputDigest,
        livelockStreak: prior.livelockStreak, class: prior.class, present: true,
      });
    }
    return true;
  }

  #identityKey(identity: RuntimeWorkerIdentity): string { return JSON.stringify([identity.runtime, identity.id, identity.generation]); }

  #binding(identity: RuntimeWorkerIdentity): FleetAssignmentBinding | null {
    const matches = this.#assignmentBindings.filter((binding) => sameIdentity(binding.worker, identity));
    return matches.length === 1 ? matches[0]! : null;
  }

  #ensureState(worker: RuntimeWorker): InMemoryUnit | null {
    const key = this.#identityKey(worker.identity);
    const existing = this.#states.get(key);
    if (existing) { existing.present = true; return existing; }
    for (const [otherKey, other] of this.#states) {
      if (sameLogicalWorker(other.identity, worker.identity) && !sameIdentity(other.identity, worker.identity)) {
        this.#states.delete(otherKey);
      }
    }
    const binding = this.#binding(worker.identity);
    const unitRef = binding?.unitRef ?? this.#nextUnitRef();
    if ([...this.#states.values()].some((state) => state.unitRef === unitRef)) return null;
    const numeric = Number(unitRef.slice(2)); if (Number.isInteger(numeric)) this.#unitCounter = Math.max(this.#unitCounter, numeric);
    const state: InMemoryUnit = {
      identity: worker.identity, unitRef, provenance: worker.provenance,
      ...(binding ? { assignmentId: binding.assignmentId, assignmentGeneration: binding.assignmentGeneration } : {}),
      token: null, hasBaseline: false, outputDigest: null, livelockStreak: 0, class: null, present: true,
    };
    this.#states.set(key, state); return state;
  }

  async #probe(state: InMemoryUnit, config: FleetObserverConfig, deadlineMs: number): Promise<CensusRow | null> {
    const now = this.#now;
    const identityCheck = await beforeDeadline(() => this.source.findWorker(state.identity, { timeoutMs: Math.max(1, deadlineMs - now()) }), deadlineMs, now);
    if (!identityCheck.completed || !identityCheck.value || identityCheck.value.status !== 'ok') {
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'unknown', reason: 'phase-budget-expired', probes: { output: 'expired', liveness: 'expired' }, livelockStreak: state.livelockStreak };
    }
    if (identityCheck.value.value === null || !sameIdentity(identityCheck.value.value.identity, state.identity)) {
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'unknown', reason: 'identity-contradiction', probes: { output: 'failed', liveness: 'failed' }, livelockStreak: state.livelockStreak };
    }
    const output = await beforeDeadline(() => this.source.readBoundedOutput({ worker: state.identity, previousToken: state.token, limit: 128 }, { timeoutMs: Math.max(1, deadlineMs - now()) }), deadlineMs, now);
    const live = await beforeDeadline(() => this.source.liveness({ worker: state.identity, observationWindowMs: 1 }, { timeoutMs: Math.max(1, deadlineMs - now()) }), deadlineMs, now);
    if (!output.completed || !live.completed) {
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'unknown', reason: 'phase-budget-expired', probes: { output: output.completed ? 'failed' : 'expired', liveness: live.completed ? 'failed' : 'expired' }, livelockStreak: state.livelockStreak };
    }
    if (!output.value || output.value.status !== 'ok' || !outputShapeValid(output.value.value, state.identity)
      || !live.value || !livenessShapeValid(live.value, state.identity)) {
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'unknown', reason: 'observation-failed', probes: { output: 'failed', liveness: 'failed' }, livelockStreak: state.livelockStreak };
    }
    const out = output.value.value; const liveness = live.value.status; const digest = outputDigest(out.lines);
    if (liveness === 'gone') {
      if (out.terminalState === 'exited') return null;
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'unknown', reason: 'contradictory-gone', probes: { output: 'valid', liveness: 'gone' }, livelockStreak: state.livelockStreak };
    }
    if (liveness === 'unknown') {
      state.token = out.observationToken; state.outputDigest = digest;
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'unknown', reason: 'liveness-unknown', probes: { output: 'valid', liveness: 'unknown' }, livelockStreak: state.livelockStreak };
    }
    const hadBaseline = state.hasBaseline;
    const changed = state.token
      ? out.changed
      : hadBaseline && state.outputDigest !== null
        ? state.outputDigest !== digest
        : false;
    state.token = out.observationToken; state.outputDigest = digest; state.hasBaseline = true;
    const exception = config.exceptions.find((entry) => entry.schedulerGeneration === this.schedulerGeneration && entry.unitRef === state.unitRef);
    if (exception && (liveness === 'busy' || liveness === 'idle')) {
      state.livelockStreak = 0;
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'exempt', reason: 'exempt', probes: { output: 'valid', liveness }, livelockStreak: 0 };
    }
    if (liveness === 'idle') {
      state.livelockStreak = 0;
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'idle', reason: 'idle', probes: { output: 'valid', liveness: 'idle' }, livelockStreak: 0 };
    }
    if (!hadBaseline) {
      state.livelockStreak = 0;
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'unknown', reason: 'missing-output-baseline', probes: { output: 'valid', liveness: 'busy' }, livelockStreak: 0 };
    }
    if (changed) {
      state.livelockStreak = 0;
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'busy', reason: 'busy', probes: { output: 'valid', liveness: 'busy' }, livelockStreak: 0 };
    }
    state.livelockStreak += 1;
    if (state.livelockStreak >= config.livelockTicks) {
      return { unitRef: state.unitRef, provenance: state.provenance, class: 'livelock', reason: 'livelock', probes: { output: 'valid', liveness: 'busy' }, livelockStreak: state.livelockStreak };
    }
    return { unitRef: state.unitRef, provenance: state.provenance, class: 'unknown', reason: 'busy-without-progress', probes: { output: 'valid', liveness: 'busy' }, livelockStreak: state.livelockStreak };
  }

  #failure(input: { reason: string; sequence: number; budget: ReturnType<typeof effectiveBudget>; startedAt: number; previous: FleetObserverSnapshot | null; stale?: boolean; fleetCap?: boolean }): FleetObserverResult {
    return {
      result: 'observer-failed', status: 'failed', reason: input.reason, snapshotCommitted: false,
      snapshotPath: this.snapshotPath, schedulerGeneration: this.schedulerGeneration, tickSequence: input.sequence,
      effectiveBudgetMs: input.budget.effectiveBudgetMs, schedulerReturnedWithinBudget: this.#now() <= input.startedAt + input.budget.effectiveBudgetMs,
      staleCompletionRejected: input.stale ?? false, fleetCapFailClosed: input.fleetCap ?? false,
      goneSemanticsClosed: true, exceptionCollisionRejected: this.#exceptionCollisionRejected, zeroActuation: true,
      ...(input.previous ? { snapshot: input.previous } : {}),
    };
  }

  async tick(input: FleetObserverTickInput): Promise<FleetObserverResult> {
    const parsed = this.#readConfig();
    const config = parsed.ok ? parsed.config : defaultConfig();
    const budget = effectiveBudget(config, input.schedulerIntervalMs);
    const startedAt = input.phaseStartMs ?? this.#now();
    const deadlineMs = startedAt + budget.effectiveBudgetMs;
    const requested = input.tickSequence ?? this.#tickSequence + 1;
    this.#latestRequestedSequence = Math.max(this.#latestRequestedSequence, requested);
    const cancelVersion = this.#cancelVersion;
    const previous = readSnapshot(this.snapshotPath).snapshot;
    if (!parsed.ok) return this.#failure({ reason: parsed.reason, sequence: requested, budget, startedAt, previous });
    this.#exceptionCollisionRejected = config.exceptions.some((entry) => entry.schedulerGeneration !== this.schedulerGeneration && [...this.#states.values()].some((state) => state.unitRef === entry.unitRef));

    const listing = await beforeDeadline(() => this.source.listWorkers({ workspace: 'active' }, { timeoutMs: Math.max(1, deadlineMs - this.#now()) }), deadlineMs, this.#now);
    if (requested !== this.#latestRequestedSequence || cancelVersion !== this.#cancelVersion) return this.#failure({ reason: 'stale-completion', sequence: requested, budget, startedAt, previous, stale: true });
    if (!listing.completed || !listing.value || listing.value.status !== 'ok') return this.#failure({ reason: 'list-workers-failed', sequence: requested, budget, startedAt, previous });
    const workers = [...listing.value.value];
    if (workers.length > MAX_UNITS) return this.#failure({ reason: 'fleet-cap-exceeded', sequence: requested, budget, startedAt, previous, fleetCap: true });
    if (!this.#restore(workers)) return this.#failure({ reason: 'assignment-binding-untrusted', sequence: requested, budget, startedAt, previous });
    for (const state of this.#states.values()) state.present = false;
    const states: InMemoryUnit[] = [];
    for (const worker of workers) {
      const state = this.#ensureState(worker);
      if (!state) return this.#failure({ reason: 'assignment-binding-untrusted', sequence: requested, budget, startedAt, previous });
      state.present = true; states.push(state);
    }

    const transitions: FleetTransition[] = [];
    const rows: CensusRow[] = [];
    let cursor = 0;
    const probeWorker = async (): Promise<void> => {
      for (;;) {
        const index = cursor; cursor += 1; if (index >= states.length) return;
        if (this.#now() >= deadlineMs || requested !== this.#latestRequestedSequence || cancelVersion !== this.#cancelVersion) return;
        const state = states[index]!; const priorClass = state.class;
        const row = await this.#probe(state, config, deadlineMs);
        if (row === null) {
          transitions.push({ type: 'unit-disappeared', unitRef: state.unitRef, tickSequence: requested, reason: 'positive-gone' });
          this.#states.delete(this.#identityKey(state.identity));
          continue;
        }
        rows.push(row);
        if (priorClass === null) transitions.push({ type: 'unit-appeared', unitRef: state.unitRef, tickSequence: requested, reason: 'unit-present' });
        else if (priorClass !== row.class) transitions.push({ type: 'class-changed', unitRef: state.unitRef, tickSequence: requested, reason: row.reason, fromClass: priorClass, toClass: row.class });
        state.class = row.class;
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.maxConcurrency, Math.max(1, states.length)) }, () => probeWorker()));
    if (requested !== this.#latestRequestedSequence || cancelVersion !== this.#cancelVersion) return this.#failure({ reason: 'stale-completion', sequence: requested, budget, startedAt, previous, stale: true });
    if (this.#now() > deadlineMs || rows.length + transitions.filter((item) => item.type === 'unit-disappeared').length < states.length) return this.#failure({ reason: 'phase-budget-expired', sequence: requested, budget, startedAt, previous });

    rows.sort((a, b) => a.unitRef.localeCompare(b.unitRef)); transitions.sort((a, b) => a.unitRef.localeCompare(b.unitRef) || a.type.localeCompare(b.type));
    const continuity = this.#activationLineage ? [...this.#states.values()]
      .filter((state) => state.assignmentId && state.assignmentGeneration)
      .map((state): FleetObserverContinuityRow => ({
        assignmentId: state.assignmentId!, assignmentGeneration: state.assignmentGeneration!, unitRef: state.unitRef,
        class: state.class, livelockStreak: state.livelockStreak, hasBaseline: state.hasBaseline, outputDigest: state.outputDigest,
      })).sort((a, b) => a.unitRef.localeCompare(b.unitRef)) : undefined;
    const completedAt = this.#now();
    const snapshot: FleetObserverSnapshot = {
      schemaVersion: 1, commitStatus: 'complete', schedulerGeneration: this.schedulerGeneration, tickSequence: requested,
      startedAt: iso(startedAt), completedAt: iso(completedAt), configuredBudgetMs: budget.configuredBudgetMs,
      effectiveBudgetMs: budget.effectiveBudgetMs, settlementReserveMs: budget.settlementReserveMs,
      maxUnits: MAX_UNITS, maxSnapshotBytes: MAX_SNAPSHOT_BYTES, result: 'complete', census: rows,
      transitions, progress: [{ type: 'tick-complete', schedulerGeneration: this.schedulerGeneration, tickSequence: requested, at: iso(completedAt) }],
      ...(this.#activationLineage ? { activationLineage: this.#activationLineage } : {}),
      ...(continuity ? { continuity } : {}),
    };
    if (snapshotByteLength(snapshot) > MAX_SNAPSHOT_BYTES || !atomicCommit(this.snapshotPath, snapshot)) return this.#failure({ reason: 'snapshot-commit-failed', sequence: requested, budget, startedAt, previous });
    this.#tickSequence = Math.max(this.#tickSequence, requested);
    return {
      result: 'census-published-observer-only', status: 'complete', snapshotCommitted: true, snapshotPath: this.snapshotPath,
      schedulerGeneration: this.schedulerGeneration, tickSequence: requested, effectiveBudgetMs: budget.effectiveBudgetMs,
      schedulerReturnedWithinBudget: completedAt <= deadlineMs, staleCompletionRejected: false, fleetCapFailClosed: false,
      goneSemanticsClosed: true, exceptionCollisionRejected: this.#exceptionCollisionRejected, zeroActuation: true, snapshot,
    };
  }
}

export function createUnavailableFleetObserver(reason = 'runtime-adapter-unavailable'): FleetObserver {
  const source: FleetObserverSource = {
    listWorkers: () => runtimeFailure('list_workers', reason),
    findWorker: () => runtimeFailure('find_worker', reason),
    readBoundedOutput: () => runtimeFailure('read_bounded_output', reason),
    liveness: (input) => ({ status: 'unknown', worker: input.worker }),
  };
  return new FleetObserver({ source });
}
