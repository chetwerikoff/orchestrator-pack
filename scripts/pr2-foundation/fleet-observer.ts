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
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  RUNTIME_LIVENESS_RESULTS,
  sameRuntimeWorker,
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
  listWorkers(
    input: { readonly workspace?: 'active' | string },
    options?: RuntimeCallOptions,
  ): MaybePromise<RuntimeResult<readonly RuntimeWorker[]>>;
  findWorker(
    identity: RuntimeWorkerIdentity,
    options?: RuntimeCallOptions,
  ): MaybePromise<RuntimeResult<RuntimeWorker | null>>;
  readBoundedOutput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly previousToken?: RuntimeObservationToken | null;
      readonly limit?: number;
    },
    options?: RuntimeCallOptions,
  ): MaybePromise<RuntimeResult<RuntimeBoundedOutput>>;
  liveness(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly observationWindowMs: number;
    },
    options?: RuntimeCallOptions,
  ): MaybePromise<RuntimeLivenessResult>;
}

export type RuntimeNeutralFleetSource = Pick<
  RuntimeAdapter,
  'listWorkers' | 'findWorker' | 'readBoundedOutput' | 'liveness'
>;

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
  token: RuntimeObservationToken | null;
  hasBaseline: boolean;
  livelockStreak: number;
  class: ObserverClass | null;
  present: boolean;
}

interface UnitSettlement {
  readonly kind: 'row' | 'gone';
  readonly row?: CensusRow;
  readonly state: InMemoryUnit;
}

interface ParsedSnapshotResult {
  snapshot: FleetObserverSnapshot | null;
  rawBytes: string | null;
}

type ConfigResult = {
  readonly ok: true;
  readonly config: FleetObserverConfig;
} | {
  readonly ok: false;
  readonly reason: string;
};

interface BoundedCall<T> {
  readonly completed: boolean;
  readonly value?: T;
}

const UNIT_REF_PATTERN = /^u-[0-9]{1,9}$/u;
const GENERATION_PATTERN = /^sg-[A-Za-z0-9._~-]{1,80}$/u;
const REASON_PATTERN = /^[a-z0-9-]{1,80}$/u;
const EXCEPTION_KINDS = new Set<ExceptionKind>(['HELD', 'FOREIGN', 'OWED', 'STANDDOWN']);
const UNKNOWN_ROW_REASONS = new Set([
  'identity-contradiction',
  'observation-failed',
  'phase-budget-expired',
  'liveness-unknown',
  'missing-output-baseline',
  'busy-without-progress',
  'unsupported-liveness',
  'contradictory-gone',
]);
const SNAPSHOT_KEYS = new Set([
  'schemaVersion',
  'commitStatus',
  'schedulerGeneration',
  'tickSequence',
  'startedAt',
  'completedAt',
  'configuredBudgetMs',
  'effectiveBudgetMs',
  'settlementReserveMs',
  'maxUnits',
  'maxSnapshotBytes',
  'result',
  'census',
  'transitions',
  'progress',
]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: RecordValue, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function boundedString(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function sameIdentity(left: RuntimeWorkerIdentity, right: RuntimeWorkerIdentity): boolean {
  return sameRuntimeWorker(left, right);
}

function sameLogicalWorker(left: RuntimeWorkerIdentity, right: RuntimeWorkerIdentity): boolean {
  return left.runtime === right.runtime && left.id === right.id;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function effectiveBudget(config: FleetObserverConfig, schedulerIntervalMs: number): {
  readonly configuredBudgetMs: number | null;
  readonly effectiveBudgetMs: number;
  readonly settlementReserveMs: number;
} {
  const interval = Math.max(1, Math.floor(schedulerIntervalMs));
  const effectiveBudgetMs = Math.min(
    config.phaseBudgetMs ?? DEFAULT_PHASE_BUDGET_MS,
    Math.max(1, Math.floor(interval / 4)),
  );
  return {
    configuredBudgetMs: config.phaseBudgetMs ?? null,
    effectiveBudgetMs,
    settlementReserveMs: Math.min(250, Math.max(1, Math.floor(effectiveBudgetMs / 5))),
  };
}

function defaultConfig(): FleetObserverConfig {
  return {
    schemaVersion: 1,
    livelockTicks: DEFAULT_LIVELOCK_TICKS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    exceptions: [],
  };
}

function parseConfigValue(raw: unknown): ConfigResult {
  if (raw === undefined) return { ok: true, config: defaultConfig() };
  if (!isRecord(raw) || !hasOnlyKeys(raw, new Set(['schemaVersion', 'livelockTicks', 'phaseBudgetMs', 'maxConcurrency', 'exceptions']))) {
    return { ok: false, reason: 'invalid-config' };
  }
  if (raw.schemaVersion !== 1) return { ok: false, reason: 'invalid-config-schema' };
  if (raw.livelockTicks !== undefined && !positiveInteger(raw.livelockTicks)) return { ok: false, reason: 'invalid-livelock-threshold' };
  if (raw.phaseBudgetMs !== undefined && !positiveInteger(raw.phaseBudgetMs)) return { ok: false, reason: 'invalid-phase-budget' };
  if (raw.maxConcurrency !== undefined && (
    typeof raw.maxConcurrency !== 'number'
    || !Number.isInteger(raw.maxConcurrency)
    || raw.maxConcurrency < 1
    || raw.maxConcurrency > MAX_CONCURRENCY
  )) return { ok: false, reason: 'invalid-max-concurrency' };
  const exceptions = raw.exceptions ?? [];
  if (!Array.isArray(exceptions)) return { ok: false, reason: 'invalid-exceptions' };
  const seen = new Set<string>();
  const parsed: FleetObserverException[] = [];
  for (const candidate of exceptions) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, new Set(['kind', 'schedulerGeneration', 'unitRef']))) {
      return { ok: false, reason: 'invalid-exception' };
    }
    if (!EXCEPTION_KINDS.has(candidate.kind as ExceptionKind)
      || !boundedString(candidate.schedulerGeneration, GENERATION_PATTERN)
      || !boundedString(candidate.unitRef, UNIT_REF_PATTERN)) {
      return { ok: false, reason: 'invalid-exception' };
    }
    const key = `${candidate.schedulerGeneration}\u0000${candidate.unitRef}`;
    if (seen.has(key)) return { ok: false, reason: 'duplicate-exception' };
    seen.add(key);
    parsed.push({
      kind: candidate.kind as ExceptionKind,
      schedulerGeneration: candidate.schedulerGeneration,
      unitRef: candidate.unitRef,
    });
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

function parseSnapshot(rawBytes: string): FleetObserverSnapshot | null {
  if (Buffer.byteLength(rawBytes, 'utf8') > MAX_SNAPSHOT_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(rawBytes);
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, SNAPSHOT_KEYS)) return null;
  if (value.schemaVersion !== 1 || value.commitStatus !== 'complete'
    || !boundedString(value.schedulerGeneration, GENERATION_PATTERN)
    || !positiveInteger(value.tickSequence)
    || typeof value.startedAt !== 'string'
    || typeof value.completedAt !== 'string'
    || (value.configuredBudgetMs !== null && !positiveInteger(value.configuredBudgetMs))
    || !positiveInteger(value.effectiveBudgetMs)
    || !positiveInteger(value.settlementReserveMs)
    || value.maxUnits !== MAX_UNITS
    || value.maxSnapshotBytes !== MAX_SNAPSHOT_BYTES
    || (value.result !== 'complete' && value.result !== 'failed')
    || !Array.isArray(value.census)
    || !Array.isArray(value.transitions)
    || !Array.isArray(value.progress)
    || value.census.length > MAX_UNITS
    || value.transitions.length > MAX_UNITS
    || value.progress.length > MAX_UNITS) return null;

  const startedAtMs = Date.parse(value.startedAt);
  const completedAtMs = Date.parse(value.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < startedAtMs
    || value.settlementReserveMs > value.effectiveBudgetMs) return null;

  const refs = new Set<string>();
  const census: CensusRow[] = [];
  for (const candidate of value.census) {
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, new Set(['unitRef', 'provenance', 'class', 'reason', 'probes', 'livelockStreak']))
      || !boundedString(candidate.unitRef, UNIT_REF_PATTERN)
      || refs.has(candidate.unitRef)
      || (candidate.provenance !== 'internal' && candidate.provenance !== 'external')
      || !OBSERVER_CLASSES.includes(candidate.class as ObserverClass)
      || !boundedString(candidate.reason, REASON_PATTERN)
      || !isRecord(candidate.probes)
      || !hasOnlyKeys(candidate.probes, new Set(['output', 'liveness']))
      || !['valid', 'failed', 'expired'].includes(candidate.probes.output as string)
      || ![...RUNTIME_LIVENESS_RESULTS, 'failed', 'expired'].includes(candidate.probes.liveness as string)
      || typeof candidate.livelockStreak !== 'number'
      || !Number.isInteger(candidate.livelockStreak)
      || candidate.livelockStreak < 0) return null;
    const outputProbe = candidate.probes.output as ProbeOutcomes['output'];
    const livenessProbe = candidate.probes.liveness as ProbeOutcomes['liveness'];
    const className = candidate.class as ObserverClass;
    const reason = candidate.reason as string;
    if ((className === 'busy' || className === 'livelock') && (outputProbe !== 'valid' || livenessProbe !== 'busy')) return null;
    if (className === 'idle' && (outputProbe !== 'valid' || livenessProbe !== 'idle')) return null;
    if (className === 'exempt' && (outputProbe !== 'valid' || !['busy', 'idle'].includes(livenessProbe))) return null;
    if (className === 'unknown' && !UNKNOWN_ROW_REASONS.has(reason)) return null;
    if (className !== 'unknown' && !['busy', 'livelock', 'idle', 'exempt'].includes(className)) return null;
    refs.add(candidate.unitRef);
    census.push({
      unitRef: candidate.unitRef,
      provenance: candidate.provenance as RuntimeWorkerProvenance,
      class: candidate.class as ObserverClass,
      reason: candidate.reason,
      probes: {
        output: candidate.probes.output as ProbeOutcomes['output'],
        liveness: candidate.probes.liveness as ProbeOutcomes['liveness'],
      },
      livelockStreak: candidate.livelockStreak,
    });
  }

  const transitions: FleetTransition[] = [];
  const transitionKeys = new Set<string>();
  for (const candidate of value.transitions) {
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, new Set(['type', 'unitRef', 'tickSequence', 'reason', 'fromClass', 'toClass']))
      || !['unit-appeared', 'unit-disappeared', 'class-changed'].includes(candidate.type as string)
      || !boundedString(candidate.unitRef, UNIT_REF_PATTERN)
      || !positiveInteger(candidate.tickSequence)
      || candidate.tickSequence > value.tickSequence
      || !boundedString(candidate.reason, REASON_PATTERN)
      || (candidate.fromClass !== undefined && !OBSERVER_CLASSES.includes(candidate.fromClass as ObserverClass))
      || (candidate.toClass !== undefined && !OBSERVER_CLASSES.includes(candidate.toClass as ObserverClass))) return null;
    if (candidate.type === 'class-changed'
      ? candidate.fromClass === undefined || candidate.toClass === undefined || candidate.fromClass === candidate.toClass
      : candidate.fromClass !== undefined || candidate.toClass !== undefined) return null;
    const transitionKey = JSON.stringify([
      candidate.type,
      candidate.unitRef,
      candidate.tickSequence,
      candidate.reason,
      candidate.fromClass ?? null,
      candidate.toClass ?? null,
    ]);
    if (transitionKeys.has(transitionKey)) return null;
    transitionKeys.add(transitionKey);
    transitions.push({
      type: candidate.type as TransitionKind,
      unitRef: candidate.unitRef,
      tickSequence: candidate.tickSequence,
      reason: candidate.reason,
      ...(candidate.fromClass === undefined ? {} : { fromClass: candidate.fromClass as ObserverClass }),
      ...(candidate.toClass === undefined ? {} : { toClass: candidate.toClass as ObserverClass }),
    });
  }

  const progress: FleetProgress[] = [];
  const progressKeys = new Set<string>();
  for (const candidate of value.progress) {
    if (!isRecord(candidate)
      || !hasOnlyKeys(candidate, new Set(['type', 'schedulerGeneration', 'tickSequence', 'at', 'reason']))
      || (candidate.type !== 'tick-complete' && candidate.type !== 'tick-failed')
      || candidate.schedulerGeneration !== value.schedulerGeneration
      || !boundedString(candidate.schedulerGeneration, GENERATION_PATTERN)
      || !positiveInteger(candidate.tickSequence)
      || candidate.tickSequence > value.tickSequence
      || typeof candidate.at !== 'string'
      || (candidate.reason !== undefined && !boundedString(candidate.reason, REASON_PATTERN))
      || (candidate.type === 'tick-complete' && candidate.reason !== undefined)
      || (candidate.type === 'tick-failed' && candidate.reason === undefined)) return null;
    const progressKey = JSON.stringify([candidate.type, candidate.schedulerGeneration, candidate.tickSequence, candidate.reason ?? null]);
    if (progressKeys.has(progressKey)) return null;
    progressKeys.add(progressKey);
    progress.push({
      type: candidate.type,
      schedulerGeneration: candidate.schedulerGeneration,
      tickSequence: candidate.tickSequence,
      at: candidate.at,
      ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    });
  }
  const terminalProgress = progress.filter((entry) => entry.tickSequence === value.tickSequence);
  const last = progress.at(-1);
  if (terminalProgress.length !== 1 || !last || last.tickSequence !== value.tickSequence
    || last.schedulerGeneration !== value.schedulerGeneration
    || (value.result === 'complete' && last.type !== 'tick-complete')
    || (value.result === 'failed' && last.type !== 'tick-failed')) return null;

  return {
    schemaVersion: 1,
    commitStatus: 'complete',
    schedulerGeneration: value.schedulerGeneration,
    tickSequence: value.tickSequence,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    configuredBudgetMs: value.configuredBudgetMs,
    effectiveBudgetMs: value.effectiveBudgetMs,
    settlementReserveMs: value.settlementReserveMs,
    maxUnits: MAX_UNITS,
    maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
    result: value.result,
    census,
    transitions,
    progress,
  };
}

function cloneUnitState(state: InMemoryUnit): InMemoryUnit {
  return { ...state };
}

function cloneStateList(states: readonly InMemoryUnit[]): InMemoryUnit[] {
  return states.map(cloneUnitState);
}

function trim<T>(values: readonly T[], max = MAX_UNITS): T[] {
  return values.length <= max ? [...values] : values.slice(values.length - max);
}

function configNamespaces(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.exceptions)) return [];
  return raw.exceptions
    .filter(isRecord)
    .map((entry) => entry.schedulerGeneration)
    .filter((value): value is string => boundedString(value, GENERATION_PATTERN));
}

function defaultGeneration(): string {
  return `sg-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

async function boundedCall<T>(
  operation: () => MaybePromise<T>,
  deadlineMs: number,
  now: () => number,
): Promise<BoundedCall<T>> {
  if (now() >= deadlineMs) return { completed: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedCall<T>>((resolve) => {
    timer = setTimeout(() => resolve({ completed: false }), Math.max(1, deadlineMs - now()));
  });
  try {
    const value = await Promise.race([
      Promise.resolve().then(operation).then((result) => now() < deadlineMs
        ? { completed: true, value: result }
        : { completed: false }),
      timeout,
    ]);
    return value;
  } catch {
    return { completed: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function calculateFleetObserverBudget(
  config: Pick<FleetObserverConfig, 'phaseBudgetMs'>,
  schedulerIntervalMs: number,
): { configuredBudgetMs: number | null; effectiveBudgetMs: number; settlementReserveMs: number } {
  return effectiveBudget(config as FleetObserverConfig, schedulerIntervalMs);
}

export function serializeFleetSnapshot(snapshot: FleetObserverSnapshot): string {
  return JSON.stringify(snapshot);
}

export function snapshotByteLength(snapshot: FleetObserverSnapshot): number {
  return Buffer.byteLength(serializeFleetSnapshot(snapshot), 'utf8');
}

export function isAcceptedFleetSnapshot(rawBytes: string): boolean {
  return parseSnapshot(rawBytes) !== null;
}

export interface FleetObserverOptions {
  readonly source: FleetObserverSource;
  readonly configPath?: string;
  readonly snapshotPath?: string;
  readonly now?: () => number;
  readonly generationFactory?: () => string;
  readonly env?: NodeJS.ProcessEnv;
}

export class FleetObserver {
  readonly #source: FleetObserverSource;
  readonly #configPath: string;
  readonly #snapshotPath: string;
  readonly #stateDirectory: string;
  readonly #now: () => number;
  readonly #generationFactory: () => string;
  readonly #states: InMemoryUnit[] = [];
  readonly #previous: ParsedSnapshotResult;
  readonly #startupFailure: string | null;
  #schedulerGeneration: string;
  #unitCounter = 0;
  #tickSequence = 0;
  #activeTick = 0;

  constructor(options: FleetObserverOptions) {
    this.#source = options.source;
    this.#now = options.now ?? (() => Date.now());
    this.#generationFactory = options.generationFactory ?? defaultGeneration;
    const home = options.env?.HOME ?? process.env.HOME ?? os.homedir();
    this.#configPath = options.configPath ?? path.join(home, '.config', 'orchestrator-pack', 'fleet-observer.json');
    this.#snapshotPath = options.snapshotPath ?? path.join(
      home,
      '.local',
      'state',
      'orchestrator-pack',
      'fleet-observer',
      'snapshot.json',
    );
    this.#stateDirectory = path.dirname(this.#snapshotPath);
    this.#previous = this.readPrevious();
    this.#tickSequence = this.#previous.snapshot?.tickSequence ?? 0;

    let rawConfig: unknown;
    try {
      rawConfig = existsSync(this.#configPath) ? JSON.parse(readFileSync(this.#configPath, 'utf8')) : undefined;
    } catch {
      rawConfig = undefined;
    }
    const forbidden = new Set<string>([
      ...(this.#previous.snapshot ? [this.#previous.snapshot.schedulerGeneration] : []),
      ...configNamespaces(rawConfig),
    ]);
    let generation = '';
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.#generationFactory();
      if (boundedString(candidate, GENERATION_PATTERN) && !forbidden.has(candidate)) {
        generation = candidate;
        break;
      }
    }
    this.#schedulerGeneration = generation;
    this.#startupFailure = generation ? null : 'scheduler-generation-collision';
  }

  get schedulerGeneration(): string {
    return this.#schedulerGeneration;
  }

  get snapshotPath(): string {
    return this.#snapshotPath;
  }

  async tick(input: FleetObserverTickInput): Promise<FleetObserverResult> {
    const start = input.phaseStartMs ?? this.#now();
    const tickSequence = Math.max(
      this.#tickSequence + 1,
      input.tickSequence ?? this.#tickSequence + 1,
    );
    this.#tickSequence = tickSequence;
    this.#activeTick = tickSequence;

    const parsedConfig = this.readConfig();
    const budget = parsedConfig.ok
      ? effectiveBudget(parsedConfig.config, input.schedulerIntervalMs)
      : effectiveBudget(defaultConfig(), input.schedulerIntervalMs);
    const hardDeadline = start + budget.effectiveBudgetMs;
    const admissionDeadline = hardDeadline - budget.settlementReserveMs;
    const before = cloneStateList(this.#states);
    const priorCensus = this.#previous.snapshot?.census ?? [];
    const transitions: FleetTransition[] = [];
    let failureReason: string | undefined;

    if (this.#startupFailure) failureReason = this.#startupFailure;
    else if (!parsedConfig.ok) failureReason = parsedConfig.reason;

    let config = parsedConfig.ok ? parsedConfig.config : defaultConfig();
    if (!failureReason) {
      const listCall = await boundedCall(
        () => this.#source.listWorkers({ workspace: 'active' }, { timeoutMs: Math.max(1, admissionDeadline - this.#now()) }),
        admissionDeadline,
        this.#now,
      );
      if (!listCall.completed || !listCall.value || listCall.value.status !== 'ok') {
        failureReason = listCall.completed ? 'list-failed' : 'phase-budget-expired';
      } else if (this.#activeTick !== tickSequence || this.#now() >= admissionDeadline) {
        return this.resultFor(undefined, start, hardDeadline, tickSequence, true, false);
      } else if (listCall.value.value.length > MAX_UNITS) {
        failureReason = 'fleet-cap-exceeded';
      } else {
        const workers = listCall.value.value;
        for (const state of [...this.#states]) {
          if (state.present && !workers.some((worker) => sameLogicalWorker(worker.identity, state.identity))) {
            transitions.push({
              type: 'unit-disappeared',
              unitRef: state.unitRef,
              tickSequence,
              reason: 'not-listed',
            });
            const stateIndex = this.#states.indexOf(state);
            if (stateIndex >= 0) this.#states.splice(stateIndex, 1);
          }
        }

        const results: Array<UnitSettlement | undefined> = [];
        let nextIndex = 0;
        const concurrency = Math.min(config.maxConcurrency, Math.max(1, workers.length));
        const probeWorker = async (): Promise<void> => {
          while (true) {
            if (this.#now() >= admissionDeadline || this.#activeTick !== tickSequence) return;
            const index = nextIndex;
            nextIndex += 1;
            if (index >= workers.length) return;
            results[index] = await this.probeUnit(workers[index], config, admissionDeadline, tickSequence);
          }
        };
        const pool = Array.from({ length: concurrency }, () => probeWorker());
        const all = Promise.all(pool);
        await Promise.race([
          all,
          new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, admissionDeadline - this.#now()))),
        ]);
        if (this.#activeTick !== tickSequence) {
          return this.resultFor(undefined, start, hardDeadline, tickSequence, true, false);
        }

        for (let index = 0; index < workers.length; index += 1) {
          const worker = workers[index];
          if (!results[index]) {
            const state = this.ensureState(worker);
            state.livelockStreak = 0;
            state.class = 'unknown';
            results[index] = {
              kind: 'row',
              state,
              row: this.row(state, 'unknown', 'phase-budget-expired', {
                output: 'expired',
                liveness: 'expired',
              }),
            };
          }
        }

        const census: CensusRow[] = [];
        for (const settlement of results) {
          if (!settlement) continue;
          if (settlement.kind === 'gone') {
            const prior = before.find((candidate) => sameIdentity(candidate.identity, settlement.state.identity));
            if (!prior) {
              const previousGeneration = before.find((candidate) =>
                sameLogicalWorker(candidate.identity, settlement.state.identity));
              if (previousGeneration) {
                transitions.push({
                  type: 'unit-disappeared',
                  unitRef: previousGeneration.unitRef,
                  tickSequence,
                  reason: 'generation-changed',
                });
              }
            }
            transitions.push({
              type: 'unit-disappeared',
              unitRef: settlement.state.unitRef,
              tickSequence,
              reason: 'positive-gone',
            });
            const stateIndex = this.#states.findIndex((candidate) => sameIdentity(candidate.identity, settlement.state.identity));
            if (stateIndex >= 0) this.#states.splice(stateIndex, 1);
            continue;
          }
          if (!settlement.row) continue;
          census.push(settlement.row);
          const prior = before.find((candidate) => sameIdentity(candidate.identity, settlement.state.identity));
          if (!prior) {
            const previousGeneration = before.find((candidate) =>
              sameLogicalWorker(candidate.identity, settlement.state.identity));
            if (previousGeneration) {
              transitions.push({
                type: 'unit-disappeared',
                unitRef: previousGeneration.unitRef,
                tickSequence,
                reason: 'generation-changed',
              });
            }
            transitions.push({
              type: 'unit-appeared',
              unitRef: settlement.state.unitRef,
              tickSequence,
              reason: 'unit-present',
            });
          } else if (prior.class && prior.class !== settlement.row.class) {
            transitions.push({
              type: 'class-changed',
              unitRef: settlement.state.unitRef,
              tickSequence,
              reason: settlement.row.reason,
              fromClass: prior.class,
              toClass: settlement.row.class,
            });
          }
        }
        if (this.#now() > hardDeadline) failureReason = 'phase-budget-expired';
        else if (this.#activeTick !== tickSequence) failureReason = 'stale-completion-rejected';
        else {
          const candidate = this.buildSnapshot({
            tickSequence,
            startedAt: iso(start),
            completedAt: iso(this.#now()),
            budget,
            result: 'complete',
            census,
            transitions,
            progress: {
              type: 'tick-complete',
              schedulerGeneration: this.#schedulerGeneration,
              tickSequence,
              at: iso(this.#now()),
            },
          });
          if (!candidate || snapshotByteLength(candidate) > MAX_SNAPSHOT_BYTES) failureReason = 'fleet-cap-exceeded';
          else if (!this.commit(candidate, hardDeadline, tickSequence)) failureReason = 'snapshot-publication-failed';
          else {
            this.#previous.snapshot = candidate;
            this.#previous.rawBytes = serializeFleetSnapshot(candidate);
            return this.resultFor(candidate, start, hardDeadline, tickSequence, false, true);
          }
        }
      }
    }

    this.#states.splice(0, this.#states.length, ...before);
    if (this.#previous.snapshot && this.#previous.snapshot.schedulerGeneration !== this.#schedulerGeneration) {
      return this.resultFor(
        undefined,
        start,
        hardDeadline,
        tickSequence,
        failureReason === 'stale-completion-rejected',
        false,
      );
    }
    const failed = this.buildSnapshot({
      tickSequence,
      startedAt: iso(start),
      completedAt: iso(this.#now()),
      budget,
      result: 'failed',
      census: priorCensus,
      transitions: [],
      progress: {
        type: 'tick-failed',
        schedulerGeneration: this.#schedulerGeneration,
        tickSequence,
        at: iso(this.#now()),
        reason: failureReason ?? 'observer-failed',
      },
    });
    let failedCommitted = false;
    if (failed && snapshotByteLength(failed) <= MAX_SNAPSHOT_BYTES && this.#activeTick === tickSequence) {
      failedCommitted = this.commit(failed, hardDeadline, tickSequence);
      if (failedCommitted) {
        this.#previous.snapshot = failed;
        this.#previous.rawBytes = serializeFleetSnapshot(failed);
      }
    }
    return this.resultFor(
      failed ?? undefined,
      start,
      hardDeadline,
      tickSequence,
      failureReason === 'stale-completion-rejected',
      failedCommitted,
    );
  }

  getEffectiveBudgetMs(schedulerIntervalMs: number): number {
    const parsedConfig = this.readConfig();
    const config = parsedConfig.ok ? parsedConfig.config : defaultConfig();
    return effectiveBudget(config, schedulerIntervalMs).effectiveBudgetMs;
  }

  cancel(): void {
    this.#activeTick += 1;
  }

  private readConfig(): ConfigResult {
    try {
      if (!existsSync(this.#configPath)) return { ok: true, config: defaultConfig() };
      return parseConfigValue(JSON.parse(readFileSync(this.#configPath, 'utf8')));
    } catch {
      return { ok: false, reason: 'invalid-config' };
    }
  }

  private readPrevious(): ParsedSnapshotResult {
    if (!existsSync(this.#snapshotPath)) return { snapshot: null, rawBytes: null };
    try {
      const rawBytes = readFileSync(this.#snapshotPath, 'utf8');
      const snapshot = parseSnapshot(rawBytes);
      return { snapshot, rawBytes: snapshot ? rawBytes : null };
    } catch {
      return { snapshot: null, rawBytes: null };
    }
  }

  private ensureState(worker: RuntimeWorker): InMemoryUnit {
    const existing = this.#states.find((candidate) => sameIdentity(candidate.identity, worker.identity));
    if (existing) {
      existing.present = true;
      return existing;
    }
    for (const oldState of [...this.#states]) {
      if (sameLogicalWorker(oldState.identity, worker.identity) && !sameIdentity(oldState.identity, worker.identity)) {
        const oldIndex = this.#states.indexOf(oldState);
        if (oldIndex >= 0) this.#states.splice(oldIndex, 1);
      }
    }
    this.#unitCounter += 1;
    const state: InMemoryUnit = {
      identity: worker.identity,
      unitRef: `u-${this.#unitCounter.toString(10).padStart(6, '0')}`,
      provenance: worker.provenance,
      token: null,
      hasBaseline: false,
      livelockStreak: 0,
      class: null,
      present: true,
    };
    this.#states.push(state);
    return state;
  }

  private validBoundedOutput(value: RuntimeBoundedOutput, listed: RuntimeWorkerIdentity): value is RuntimeBoundedOutput {
    if (!isRecord(value)
      || !hasOnlyKeys(value, new Set(['worker', 'lines', 'observationToken', 'changed', 'terminalState']))
      || !isRecord(value.worker)
      || typeof value.worker.runtime !== 'string'
      || typeof value.worker.id !== 'string'
      || typeof value.worker.generation !== 'string'
      || !sameIdentity(value.worker, listed)
      || !Array.isArray(value.lines)
      || value.lines.length > 256
      || !value.lines.every((line) => typeof line === 'string')
      || !isRecord(value.observationToken)
      || !hasOnlyKeys(value.observationToken, new Set(['opaque']))
      || typeof value.observationToken.opaque !== 'string'
      || typeof value.changed !== 'boolean'
      || !['running', 'exited', 'unknown'].includes(value.terminalState)) return false;
    return true;
  }

  private async probeUnit(
    listed: RuntimeWorker,
    config: FleetObserverConfig,
    deadlineMs: number,
    tickSequence: number,
  ): Promise<UnitSettlement | undefined> {
    if (this.#activeTick !== tickSequence) return undefined;
    const state = this.ensureState(listed);
    const findCall = await boundedCall(
      () => this.#source.findWorker(listed.identity, { timeoutMs: Math.max(1, deadlineMs - this.#now()) }),
      deadlineMs,
      this.#now,
    );
    if (this.#activeTick !== tickSequence || this.#now() >= deadlineMs) return undefined;
    if (!findCall.completed || !findCall.value || findCall.value.status !== 'ok'
      || !findCall.value.value || !sameIdentity(findCall.value.value.identity, listed.identity)) {
      state.livelockStreak = 0;
      state.class = 'unknown';
      return {
        kind: 'row',
        state,
        row: this.row(state, 'unknown', findCall.completed ? 'identity-contradiction' : 'phase-budget-expired', {
          output: findCall.completed ? 'failed' : 'expired',
          liveness: findCall.completed ? 'failed' : 'expired',
        }),
      };
    }

    const previousToken = state.token;
    const [outputCall, livenessCall] = await Promise.all([
      boundedCall(
        () => this.#source.readBoundedOutput({
          worker: listed.identity,
          ...(previousToken ? { previousToken } : {}),
          limit: 256,
        }, { timeoutMs: Math.max(1, deadlineMs - this.#now()) }),
        deadlineMs,
        this.#now,
      ),
      boundedCall(
        () => this.#source.liveness({
          worker: listed.identity,
          observationWindowMs: Math.max(1, deadlineMs - this.#now()),
        }, { timeoutMs: Math.max(1, deadlineMs - this.#now()) }),
        deadlineMs,
        this.#now,
      ),
    ]);

    if (this.#activeTick !== tickSequence || this.#now() >= deadlineMs) return undefined;
    const output = outputCall.value;
    const liveness = livenessCall.value;
    const live = livenessCall.completed && liveness && this.validLiveness(liveness, listed.identity)
      ? liveness
      : null;
    const outputValue = outputCall.completed && output && output.status === 'ok'
      && this.validBoundedOutput(output.value, listed.identity)
      ? output.value
      : null;
    if (live?.status === 'gone') {
      const outputFailureReason = output && output.status !== 'ok' ? output.reason : undefined;
      const positiveContradictoryPresence = outputValue?.terminalState === 'running';
      const malformedOutput = outputCall.completed && output?.status === 'ok' && !outputValue;
      const disappearanceFailure = outputCall.completed && output?.status !== 'ok'
        && ['gone', 'worker_not_found', 'worker_generation_not_found'].includes(outputFailureReason ?? '');
      if (positiveContradictoryPresence || malformedOutput) {
        state.livelockStreak = 0;
        state.class = 'unknown';
        return {
          kind: 'row',
          state,
          row: this.row(state, 'unknown', 'identity-contradiction', {
            output: outputCall.completed ? 'failed' : 'expired',
            liveness: 'gone',
          }),
        };
      }
      if (!outputValue && !disappearanceFailure) {
        state.livelockStreak = 0;
        state.class = 'unknown';
        return {
          kind: 'row',
          state,
          row: this.row(state, 'unknown', 'observation-failed', {
            output: outputCall.completed ? 'failed' : 'expired',
            liveness: 'gone',
          }),
        };
      }
      state.token = null;
      state.hasBaseline = false;
      state.livelockStreak = 0;
      state.class = null;
      return { kind: 'gone', state };
    }
    const probes: ProbeOutcomes = {
      output: outputValue ? 'valid' : outputCall.completed ? 'failed' : 'expired',
      liveness: live?.status ?? (livenessCall.completed ? 'failed' : 'expired'),
    };
    if (!outputValue || !live) {
      state.livelockStreak = 0;
      state.class = 'unknown';
      return { kind: 'row', state, row: this.row(state, 'unknown', 'observation-failed', probes) };
    }

    const hadBaseline = state.hasBaseline;
    const changed = hadBaseline && outputValue.changed === true;
    state.hasBaseline = true;
    state.token = outputValue.observationToken;
    let classification: ObserverClass;
    let reason: string;
    if (live.status === 'unknown') {
      state.livelockStreak = 0;
      classification = 'unknown';
      reason = 'liveness-unknown';
    } else if (!hadBaseline && live.status === 'busy') {
      state.livelockStreak = 0;
      classification = 'unknown';
      reason = 'missing-output-baseline';
    } else if (this.exceptionApplies(config, state.unitRef)) {
      state.livelockStreak = 0;
      classification = 'exempt';
      reason = 'exempt';
    } else if (changed) {
      state.livelockStreak = 0;
      classification = 'busy';
      reason = 'new-output';
    } else if (live.status === 'busy') {
      state.livelockStreak += 1;
      if (state.livelockStreak >= config.livelockTicks) {
        classification = 'livelock';
        reason = 'livelock-no-progress';
      } else {
        classification = 'unknown';
        reason = 'busy-without-progress';
      }
    } else if (live.status === 'idle') {
      state.livelockStreak = 0;
      classification = 'idle';
      reason = 'positive-idle';
    } else {
      state.livelockStreak = 0;
      classification = 'unknown';
      reason = 'unsupported-liveness';
    }
    state.class = classification;
    return { kind: 'row', state, row: this.row(state, classification, reason, probes) };
  }

  private validLiveness(value: RuntimeLivenessResult, identity: RuntimeWorkerIdentity): value is RuntimeLivenessResult {
    return sameIdentity(value.worker, identity) && RUNTIME_LIVENESS_RESULTS.includes(value.status);
  }

  private exceptionApplies(config: FleetObserverConfig, unitRef: string): boolean {
    return config.exceptions.some((entry) => entry.schedulerGeneration === this.#schedulerGeneration && entry.unitRef === unitRef);
  }

  private row(
    state: InMemoryUnit,
    classification: ObserverClass,
    reason: string,
    probes: ProbeOutcomes,
  ): CensusRow {
    return {
      unitRef: state.unitRef,
      provenance: state.provenance,
      class: classification,
      reason,
      probes,
      livelockStreak: state.livelockStreak,
    };
  }

  private buildSnapshot(input: {
    readonly tickSequence: number;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly budget: { configuredBudgetMs: number | null; effectiveBudgetMs: number; settlementReserveMs: number };
    readonly result: 'complete' | 'failed';
    readonly census: readonly CensusRow[];
    readonly transitions: readonly FleetTransition[];
    readonly progress: FleetProgress;
  }): FleetObserverSnapshot | null {
    const prior = this.#previous.snapshot?.schedulerGeneration === this.#schedulerGeneration
      ? this.#previous.snapshot
      : null;
    return {
      schemaVersion: 1,
      commitStatus: 'complete',
      schedulerGeneration: this.#schedulerGeneration,
      tickSequence: input.tickSequence,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      configuredBudgetMs: input.budget.configuredBudgetMs,
      effectiveBudgetMs: input.budget.effectiveBudgetMs,
      settlementReserveMs: input.budget.settlementReserveMs,
      maxUnits: MAX_UNITS,
      maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
      result: input.result,
      census: trim(input.census),
      transitions: trim([...(prior?.transitions ?? []), ...input.transitions]),
      progress: trim([...(prior?.progress ?? []), input.progress]),
    };
  }

  private commit(snapshot: FleetObserverSnapshot, deadlineMs: number, tickSequence: number): boolean {
    if (this.#activeTick !== tickSequence || this.#now() >= deadlineMs) return false;
    const previousBytes = this.#previous.snapshot ? this.#previous.rawBytes : null;
    let tempPath: string | null = null;
    let replaced = false;
    const invalidateSnapshot = (target: string): boolean => {
      try {
        rmSync(target, { force: true });
        if (!existsSync(target)) return true;
      } catch {
        // Fall through to an invalid empty marker when deletion is unavailable.
      }
      try {
        writeFileSync(target, '', 'utf8');
        return true;
      } catch {
        return false;
      }
    };
    const quarantineUncommitted = (target: string): boolean => {
      const quarantinePath = `${target}.invalid-${process.pid}-${tickSequence}`;
      try {
        renameSync(target, quarantinePath);
        try { rmSync(quarantinePath, { force: true }); } catch { /* best effort */ }
        return !existsSync(target);
      } catch {
        return false;
      }
    };
    const rollback = (): boolean => {
      try {
        if (previousBytes) {
          const restorePath = `${this.#snapshotPath}.restore-${process.pid}-${tickSequence}`;
          writeFileSync(restorePath, previousBytes, 'utf8');
          const restoreFd = openSync(restorePath, 'r');
          try {
            fsyncSync(restoreFd);
          } finally {
            closeSync(restoreFd);
          }
          renameSync(restorePath, this.#snapshotPath);
          return true;
        }
        return invalidateSnapshot(this.#snapshotPath);
      } catch {
        const invalidated = invalidateSnapshot(this.#snapshotPath);
        if (!invalidated) quarantineUncommitted(this.#snapshotPath);
        return false;
      }
    };
    const clearPreviousAuthority = (): void => {
      this.#previous.snapshot = null;
      this.#previous.rawBytes = null;
    };
    try {
      mkdirSync(this.#stateDirectory, { recursive: true });
      const bytes = serializeFleetSnapshot(snapshot);
      if (Buffer.byteLength(bytes, 'utf8') > MAX_SNAPSHOT_BYTES) return false;
      tempPath = `${this.#snapshotPath}.tmp-${process.pid}-${tickSequence}`;
      writeFileSync(tempPath, bytes, 'utf8');
      const fd = openSync(tempPath, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (this.#activeTick !== tickSequence || this.#now() >= deadlineMs) {
        invalidateSnapshot(tempPath);
        tempPath = null;
        return false;
      }
      renameSync(tempPath, this.#snapshotPath);
      tempPath = null;
      replaced = true;
      const readBack = readFileSync(this.#snapshotPath, 'utf8');
      const readBackSnapshot = parseSnapshot(readBack);
      if (this.#now() >= deadlineMs || readBack !== bytes || !readBackSnapshot
        || readBackSnapshot.schedulerGeneration !== this.#schedulerGeneration
        || readBackSnapshot.tickSequence !== tickSequence) {
        if (!rollback()) clearPreviousAuthority();
        return false;
      }
      const dirFd = openSync(this.#stateDirectory, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      if (this.#activeTick !== tickSequence || this.#now() >= deadlineMs) {
        if (!rollback()) clearPreviousAuthority();
        return false;
      }
      return true;
    } catch {
      if (tempPath) invalidateSnapshot(tempPath);
      if (replaced && !rollback()) clearPreviousAuthority();
      return false;
    }
  }

  private resultFor(
    snapshot: FleetObserverSnapshot | undefined,
    start: number,
    hardDeadline: number,
    tickSequence: number,
    staleCompletionRejected: boolean,
    committed: boolean,
  ): FleetObserverResult {
    const committedSnapshot = committed && snapshot?.tickSequence === tickSequence && snapshot.result !== undefined;
    const reason = snapshot?.result === 'failed'
      ? snapshot.progress.at(-1)?.reason
      : undefined;
    return {
      result: committedSnapshot && snapshot?.result === 'complete' ? 'census-published-observer-only' : 'observer-failed',
      status: committedSnapshot && snapshot?.result === 'complete' ? 'complete' : 'failed',
      ...(reason ? { reason } : {}),
      snapshotCommitted: committedSnapshot,
      snapshotPath: this.#snapshotPath,
      schedulerGeneration: this.#schedulerGeneration,
      tickSequence,
      effectiveBudgetMs: Math.max(1, hardDeadline - start),
      schedulerReturnedWithinBudget: this.#now() <= hardDeadline,
      staleCompletionRejected,
      fleetCapFailClosed: reason === 'fleet-cap-exceeded' || reason === undefined,
      goneSemanticsClosed: true,
      exceptionCollisionRejected: this.#startupFailure === null,
      zeroActuation: true,
      ...(snapshot ? { snapshot } : {}),
    };
  }
}

export function defaultFleetObserverPaths(env: NodeJS.ProcessEnv = process.env): {
  readonly configPath: string;
  readonly snapshotPath: string;
} {
  const home = env.HOME ?? os.homedir();
  return {
    configPath: path.join(home, '.config', 'orchestrator-pack', 'fleet-observer.json'),
    snapshotPath: path.join(home, '.local', 'state', 'orchestrator-pack', 'fleet-observer', 'snapshot.json'),
  };
}


export function createUnavailableFleetObserver(reason = 'runtime-adapter-unavailable'): FleetObserver {
  return new FleetObserver({
    source: {
      listWorkers: () => runtimeFailure('list_workers', reason),
      findWorker: () => runtimeFailure('find_worker', reason),
      readBoundedOutput: () => runtimeFailure('read_bounded_output', reason),
      liveness: (input) => ({ status: 'unknown', worker: input.worker }),
    },
  });
}
