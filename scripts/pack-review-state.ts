import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveSmokeRequirement } from './draft-discipline.mjs';

export const PACK_REVIEW_AUTHORITY_SCHEMA_VERSION = 1;
export const PACK_REVIEW_TERMINAL_CONTRACT_VERSION = 2;
export const PACK_REVIEW_CAP_MAP_VERSION = 'issue-1063-1-2-4';
export const PACK_REVIEW_LOGICAL_CAP_MAP_VERSION = 'issue-1826-logical-rounds-1-1-2';
export const PACK_REVIEW_DISTINCT_HEAD_CAP_MAP_VERSION = PACK_REVIEW_CAP_MAP_VERSION;
export const PACK_REVIEW_LEGACY_CAP_MAP_VERSION = 'legacy-frozen';
export const PACK_REVIEW_CAPS = Object.freeze({ T1: 1, T2: 2, T3: 4 });
export const PACK_REVIEW_LOGICAL_CAPS = Object.freeze({ T1: 1, T2: 1, T3: 2 });
export const PACK_REVIEW_DISTINCT_HEAD_CAPS = PACK_REVIEW_CAPS;
export const PACK_REVIEW_GPT_SOURCE_ADMISSION_INTERVAL_MS = 10_000;
export const PACK_REVIEW_AUTHORITY_PHASES = Object.freeze([
  'head_observed',
  'claim_acquired',
  'review_or_bundle_staged',
  'terminal_and_cap_committed',
  'evidence_selected',
  'triage_committed',
  'external_published',
] as const);

export type PackReviewTier = keyof typeof PACK_REVIEW_CAPS;
export type PackReviewAuthorityPhase = (typeof PACK_REVIEW_AUTHORITY_PHASES)[number];
export type PackReviewAutomaticBudgetDisposition = 'consume' | 'non_consuming_explicit';
export type SmokeOrderingActor = 'worker-owned' | 'independent';
export type SmokeOrderingStatus = 'started' | 'passed' | 'failed';
export type SmokeOrderingFailureKind = 'finding' | 'retryable';

export interface PackReviewSmokeOrdering {
  workerOwned?: {
    headSha: string;
    status: SmokeOrderingStatus;
    updatedAtUtc: string;
  };
  reviewSettledHeadSha?: string;
  independent?: {
    startedEver: boolean;
    headSha: string;
    status: SmokeOrderingStatus;
    updatedAtUtc: string;
    failureKind?: SmokeOrderingFailureKind;
    failureHeadSha?: string;
  };
}

export function selectPackReviewGptSourceCardinality(input: {
  reviewer: string;
  tier: PackReviewTier;
  roundOrdinal: number;
  accountingVersion?: string;
}): number {
  if (input.reviewer.trim().toLowerCase() !== 'gpt') return 1;
  if (!Number.isInteger(input.roundOrdinal) || input.roundOrdinal <= 0) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'roundOrdinal must be a positive integer');
  }
  if (input.accountingVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION) return 3;
  return input.roundOrdinal === 1 || input.tier === 'T3' ? 3 : 1;
}
export type PackReviewCycleState =
  | 'open'
  | 'at_cap_open_findings'
  | 'at_cap_continuation_required'
  | 'closed';

export type PackReviewTerminalSource =
  | 'normal'
  | 'conflict_free_carryover'
  | 'merge_composite';

export interface PackReviewTerminalV2 {
  schemaVersion: 1;
  terminalContractVersion: 2;
  terminalSource: PackReviewTerminalSource;
  automaticBudgetDisposition?: PackReviewAutomaticBudgetDisposition;
  runId: string;
  targetSha: string;
  logicalRoundOrdinal?: number;
  reviewVerdict: 'clean' | 'findings';
  findingCount: number;
  findingsDigest: string;
  deliveryDigest?: string;
  sourceCleanRunId?: string;
  sourceHeadSha?: string;
  mergeBaseSha?: string;
  mainSha?: string;
  orderedParentShas?: [string, string];
  replayDigest?: string;
  bundleDigest?: string;
  helperVersion?: string;
  focusedResolutionRunId?: string;
  focusedResolutionVerdict?: 'clean';
}

export interface PackReviewCycle {
  cycleId: string;
  state: PackReviewCycleState;
  frozenTier: PackReviewTier;
  frozenCap: number;
  capMapVersion:
    | typeof PACK_REVIEW_CAP_MAP_VERSION
    | typeof PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
    | typeof PACK_REVIEW_DISTINCT_HEAD_CAP_MAP_VERSION
    | typeof PACK_REVIEW_LEGACY_CAP_MAP_VERSION;
  frozenMapOrigin?: 'persisted-open-cycle';
  openedAtUtc: string;
  closedAtUtc?: string;
  consumedHeadShas: string[];
  consumedRoundOrdinals?: number[];
  atCapHash?: string;
  reviewStageComplete?: boolean;
  reviewStageCompletedAtUtc?: string;
  reviewStartConsumed?: boolean;
  resetProvenance?: PackReviewResetProvenance;
}

export interface PackReviewResetProvenance {
  priorCycleId: string;
  priorAtCapHash: string;
  actor: string;
  reason: string;
  timestampUtc: string;
  nonce: string;
}

export interface PackReviewEvidenceSelection {
  expectedEvidenceKey: string;
  selectedEvidenceId: string;
  selectedEvidenceDigest: string;
  selectedAtUtc: string;
}

export interface PackReviewTriageState {
  verdict: 'BLOCK' | 'PENDING_ARCHITECT' | 'PENDING_OPERATOR' | 'DEFER';
  source: 'automatic' | 'architect';
  findingSnapshotDigest: string;
  actor?: string;
  tokenDigest?: string;
  committedAtUtc: string;
}

export interface PackReviewPublicationState {
  headSha: string;
  terminalRunId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'superseded';
  publicationDigest: string;
  recordedAtUtc: string;
}

export interface PackReviewAuthorityDocument {
  schemaVersion: 1;
  prNumber: number;
  transitionSeq: number;
  phase: PackReviewAuthorityPhase;
  currentHeadSha: string;
  updatedAtUtc: string;
  authorityConflict?: {
    key: string;
    existingDigest: string;
    attemptedDigest: string;
    recordedAtUtc: string;
  };
  terminal?: {
    runId: string;
    digest: string;
    targetSha: string;
    logicalRoundOrdinal?: number;
    reviewVerdict: 'clean' | 'findings';
    terminalSource: PackReviewTerminalSource;
    automaticBudgetDisposition?: PackReviewAutomaticBudgetDisposition;
    reviewStatus?: string;
  };
  cycle: PackReviewCycle | null;
  evidence?: PackReviewEvidenceSelection;
  triage?: PackReviewTriageState;
  publication?: PackReviewPublicationState;
  smokeOrdering?: PackReviewSmokeOrdering;
}

export interface PackReviewAuthorityOptions {
  storeRoot: string;
  now?: Date;
  lockAttempts?: number;
  lockWaitMs?: number;
}

export interface PackReviewStartConsumptionRecord {
  id?: unknown;
  runId?: unknown;
  prNumber: number;
  targetSha?: unknown;
  headSha?: unknown;
  status?: unknown;
  automaticBudgetDisposition?: unknown;
  stale?: unknown;
  createdAt?: unknown;
  failureReason?: unknown;
}

export class PackReviewAuthorityError extends Error {
  readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = 'PackReviewAuthorityError';
  }
}

function sleepSync(milliseconds: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, milliseconds);
}

function nowIso(options: PackReviewAuthorityOptions): string {
  return (options.now ?? new Date()).toISOString();
}

function normalizeSha(value: unknown, label = 'headSha'): string {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new PackReviewAuthorityError('authority_input_invalid', `${label} must be full 40-hex`);
  }
  return sha;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new PackReviewAuthorityError('authority_input_invalid', `${label} must be positive integer`);
  }
  return parsed;
}

function nonEmpty(value: unknown, label: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new PackReviewAuthorityError('authority_input_invalid', `${label} is required`);
  return text;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function storeRoot(options: PackReviewAuthorityOptions): string {
  return resolve(options.storeRoot);
}

function authorityDir(options: PackReviewAuthorityOptions): string {
  return join(storeRoot(options), 'authority');
}

function authorityPath(prNumber: number, options: PackReviewAuthorityOptions): string {
  return join(authorityDir(options), `pr-${positiveInteger(prNumber, 'prNumber')}.json`);
}

function immutableRoot(options: PackReviewAuthorityOptions): string {
  return join(storeRoot(options), 'immutable');
}

function lockPath(options: PackReviewAuthorityOptions): string {
  return join(storeRoot(options), '.store-lock');
}

function ensureStore(options: PackReviewAuthorityOptions): void {
  mkdirSync(authorityDir(options), { recursive: true });
  mkdirSync(immutableRoot(options), { recursive: true });
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error
      && String((error as NodeJS.ErrnoException).code) === 'EPERM';
  }
}

function abandonedLock(path: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as { pid?: number };
    if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) return !processAlive(Number(owner.pid));
  } catch {
    // The owner file can be briefly absent while the creator writes it.
  }
  try {
    return Date.now() - statSync(path).mtimeMs > 30_000;
  } catch {
    return false;
  }
}

export function withPackReviewAuthorityLock<T>(
  options: PackReviewAuthorityOptions,
  action: () => T,
): T {
  ensureStore(options);
  const path = lockPath(options);
  const attempts = options.lockAttempts ?? 400;
  const waitMs = options.lockWaitMs ?? 25;
  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      mkdirSync(path);
      writeFileSync(
        join(path, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, nonce: randomUUID(), acquiredAtUtc: nowIso(options) })}\n`,
        'utf8',
      );
      acquired = true;
      break;
    } catch (error) {
      if (existsSync(path) && abandonedLock(path)) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (attempt + 1 === attempts) {
        throw new PackReviewAuthorityError(
          'authority_lock_timeout',
          error instanceof Error ? error.message : String(error),
        );
      }
      sleepSync(waitMs);
    }
  }
  if (!acquired) throw new PackReviewAuthorityError('authority_lock_timeout', 'unreachable');
  try {
    return action();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function phaseIndex(phase: PackReviewAuthorityPhase): number {
  const index = PACK_REVIEW_AUTHORITY_PHASES.indexOf(phase);
  if (index < 0) throw new PackReviewAuthorityError('authority_input_invalid', `unknown phase ${phase}`);
  return index;
}

function validateBudgetDisposition(value: unknown, label: string): PackReviewAutomaticBudgetDisposition {
  const disposition = value ?? 'consume';
  if (disposition !== 'consume' && disposition !== 'non_consuming_explicit') {
    throw new PackReviewAuthorityError('authority_schema_invalid', label);
  }
  return disposition;
}

function isLogicalRoundCycle(cycle: PackReviewCycle): boolean {
  return cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
}

function cycleConsumedCount(cycle: PackReviewCycle): number {
  return isLogicalRoundCycle(cycle)
    ? (cycle.consumedRoundOrdinals?.length ?? 0)
    : cycle.consumedHeadShas.length;
}

function validateCycle(cycle: PackReviewCycle | null): void {
  if (!cycle) return;
  nonEmpty(cycle.cycleId, 'cycleId');
  if (!(cycle.frozenTier in PACK_REVIEW_CAPS)) {
    throw new PackReviewAuthorityError('cap_state_invalid', `unknown tier ${cycle.frozenTier}`);
  }
  positiveInteger(cycle.frozenCap, 'frozenCap');
  if (!Array.isArray(cycle.consumedHeadShas)) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'consumedHeadShas must be array');
  }
  const normalized = cycle.consumedHeadShas.map((sha) => normalizeSha(sha, 'consumedHeadSha'));
  if (new Set(normalized).size !== normalized.length) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'duplicate consumed head');
  }
  if (!['open', 'at_cap_open_findings', 'at_cap_continuation_required', 'closed'].includes(cycle.state)) {
    throw new PackReviewAuthorityError('cap_state_invalid', `unknown cycle state ${cycle.state}`);
  }
  if (![PACK_REVIEW_CAP_MAP_VERSION, PACK_REVIEW_LOGICAL_CAP_MAP_VERSION, PACK_REVIEW_DISTINCT_HEAD_CAP_MAP_VERSION, PACK_REVIEW_LEGACY_CAP_MAP_VERSION]
      .includes(cycle.capMapVersion)) {
    throw new PackReviewAuthorityError('cap_state_invalid', `unknown cap map ${cycle.capMapVersion}`);
  }

  let consumedCount: number;
  if (cycle.capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION) {
    if (cycle.frozenCap !== PACK_REVIEW_LOGICAL_CAPS[cycle.frozenTier] || cycle.frozenMapOrigin !== undefined) {
      throw new PackReviewAuthorityError('cap_state_invalid', 'current-map cycle has mismatched discriminator');
    }
    if (!Array.isArray(cycle.consumedRoundOrdinals)) {
      throw new PackReviewAuthorityError('cap_state_invalid', 'logical-round cycle lacks consumedRoundOrdinals');
    }
    const rounds = cycle.consumedRoundOrdinals.map((value) => positiveInteger(value, 'consumedRoundOrdinal'));
    if (new Set(rounds).size !== rounds.length) {
      throw new PackReviewAuthorityError('cap_state_invalid', 'duplicate consumed logical round');
    }
    for (let index = 0; index < rounds.length; index += 1) {
      if (rounds[index] !== index + 1) {
        throw new PackReviewAuthorityError('cap_state_invalid', 'logical rounds must be contiguous from ordinal 1');
      }
    }
    consumedCount = rounds.length;
  } else {
    if (cycle.consumedRoundOrdinals !== undefined) {
      throw new PackReviewAuthorityError('cap_state_invalid', 'legacy cycle cannot carry logical-round accounting');
    }
    if (cycle.capMapVersion === PACK_REVIEW_DISTINCT_HEAD_CAP_MAP_VERSION) {
      if (cycle.frozenCap !== PACK_REVIEW_DISTINCT_HEAD_CAPS[cycle.frozenTier] || cycle.frozenMapOrigin !== undefined) {
        throw new PackReviewAuthorityError('cap_state_invalid', 'distinct-head cycle has mismatched discriminator');
      }
    } else if (cycle.frozenMapOrigin !== 'persisted-open-cycle') {
      throw new PackReviewAuthorityError('cap_state_invalid', 'legacy cycle lacks persisted origin');
    }
    consumedCount = normalized.length;
  }

  if (consumedCount > cycle.frozenCap) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'consumed review units exceed frozen cap');
  }
  if (cycle.reviewStageComplete === true && !cycle.reviewStageCompletedAtUtc) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'completed review stage lacks timestamp');
  }
  if (cycle.reviewStageComplete !== true && cycle.reviewStageCompletedAtUtc !== undefined) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'incomplete review stage carries completion timestamp');
  }
  const atCap = consumedCount === cycle.frozenCap;
  const atCapState = cycle.state === 'at_cap_open_findings' || cycle.state === 'at_cap_continuation_required';
  if (atCapState && (!atCap || !cycle.atCapHash || !/^[0-9a-f]{64}$/.test(cycle.atCapHash))) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'at-cap cycle lacks full consumption/hash');
  }
  if (!atCapState && cycle.atCapHash !== undefined) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'non-at-cap cycle carries atCapHash');
  }
}

function validateAuthority(document: PackReviewAuthorityDocument): void {
  if (document.schemaVersion !== 1) {
    throw new PackReviewAuthorityError('authority_schema_invalid', String(document.schemaVersion));
  }
  positiveInteger(document.prNumber, 'prNumber');
  if (!Number.isInteger(document.transitionSeq) || document.transitionSeq < 0) {
    throw new PackReviewAuthorityError('authority_schema_invalid', 'transitionSeq');
  }
  normalizeSha(document.currentHeadSha, 'currentHeadSha');
  phaseIndex(document.phase);
  validateCycle(document.cycle);
  if (document.terminal) {
    normalizeSha(document.terminal.targetSha, 'terminal.targetSha');
    nonEmpty(document.terminal.runId, 'terminal.runId');
    nonEmpty(document.terminal.digest, 'terminal.digest');
    validateBudgetDisposition(document.terminal.automaticBudgetDisposition, 'terminal.automaticBudgetDisposition');
  }
  if (document.smokeOrdering) {
    const ordering = document.smokeOrdering;
    if (ordering.workerOwned) {
      normalizeSha(ordering.workerOwned.headSha, 'smokeOrdering.workerOwned.headSha');
      if (!['started', 'passed', 'failed'].includes(ordering.workerOwned.status)) {
        throw new PackReviewAuthorityError('authority_schema_invalid', 'smokeOrdering.workerOwned.status');
      }
      nonEmpty(ordering.workerOwned.updatedAtUtc, 'smokeOrdering.workerOwned.updatedAtUtc');
    }
    if (ordering.reviewSettledHeadSha) {
      normalizeSha(ordering.reviewSettledHeadSha, 'smokeOrdering.reviewSettledHeadSha');
    }
    if (ordering.independent) {
      normalizeSha(ordering.independent.headSha, 'smokeOrdering.independent.headSha');
      if (ordering.independent.startedEver !== true) {
        throw new PackReviewAuthorityError('authority_schema_invalid', 'smokeOrdering.independent.startedEver');
      }
      if (!['started', 'passed', 'failed'].includes(ordering.independent.status)) {
        throw new PackReviewAuthorityError('authority_schema_invalid', 'smokeOrdering.independent.status');
      }
      nonEmpty(ordering.independent.updatedAtUtc, 'smokeOrdering.independent.updatedAtUtc');
    }
  }
}

function readAuthorityUnlocked(
  prNumber: number,
  options: PackReviewAuthorityOptions,
): PackReviewAuthorityDocument | null {
  const path = authorityPath(prNumber, options);
  if (!existsSync(path)) return null;
  let parsed: PackReviewAuthorityDocument;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PackReviewAuthorityDocument;
  } catch (error) {
    throw new PackReviewAuthorityError(
      'authority_document_corrupt',
      error instanceof Error ? error.message : String(error),
    );
  }
  validateAuthority(parsed);
  return parsed;
}

export function readPackReviewAuthority(
  prNumber: number,
  options: PackReviewAuthorityOptions,
): PackReviewAuthorityDocument | null {
  return withPackReviewAuthorityLock(options, () => readAuthorityUnlocked(prNumber, options));
}

export function createNewPackReviewCycle(
  tier: PackReviewTier,
  options: Pick<PackReviewAuthorityOptions, 'now'> & {
    capMapVersion?: typeof PACK_REVIEW_CAP_MAP_VERSION | typeof PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
  } = {},
  resetProvenance?: PackReviewResetProvenance,
): PackReviewCycle {
  if (!(tier in PACK_REVIEW_CAPS)) {
    throw new PackReviewAuthorityError('cap_state_invalid', `unknown tier ${tier}`);
  }
  const capMapVersion = options.capMapVersion ?? PACK_REVIEW_CAP_MAP_VERSION;
  const logicalAccounting = capMapVersion === PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
  return {
    cycleId: `cycle-${randomUUID().replaceAll('-', '')}`,
    state: 'open',
    frozenTier: tier,
    frozenCap: logicalAccounting ? PACK_REVIEW_LOGICAL_CAPS[tier] : PACK_REVIEW_CAPS[tier],
    capMapVersion,
    openedAtUtc: (options.now ?? new Date()).toISOString(),
    consumedHeadShas: [],
    ...(logicalAccounting ? { consumedRoundOrdinals: [] } : {}),
    resetProvenance,
  };
}

export function retainPersistedOpenCycle(raw: unknown): PackReviewCycle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PackReviewAuthorityError('cap_state_invalid', 'persisted open cycle is missing');
  }
  const input = raw as Partial<PackReviewCycle>;
  const cycle: PackReviewCycle = {
    cycleId: nonEmpty(input.cycleId, 'cycleId'),
    state: input.state ?? 'open',
    frozenTier: String(input.frozenTier ?? '') as PackReviewTier,
    frozenCap: positiveInteger(input.frozenCap, 'frozenCap'),
    capMapVersion: PACK_REVIEW_LEGACY_CAP_MAP_VERSION,
    frozenMapOrigin: 'persisted-open-cycle',
    openedAtUtc: nonEmpty(input.openedAtUtc, 'openedAtUtc'),
    closedAtUtc: input.closedAtUtc,
    consumedHeadShas: Array.isArray(input.consumedHeadShas)
      ? input.consumedHeadShas.map((sha) => normalizeSha(sha, 'consumedHeadSha'))
      : [],
    atCapHash: input.atCapHash,
    reviewStageComplete: input.reviewStageComplete === true ? true : undefined,
    reviewStageCompletedAtUtc: input.reviewStageComplete === true
      ? nonEmpty(input.reviewStageCompletedAtUtc, 'reviewStageCompletedAtUtc')
      : undefined,
    resetProvenance: input.resetProvenance,
  };
  validateCycle(cycle);
  return cycle;
}

export function createInitialPackReviewAuthority(input: {
  prNumber: number;
  headSha: string;
  tier: PackReviewTier;
  retainedOpenCycle?: unknown;
  capMapVersion?: typeof PACK_REVIEW_CAP_MAP_VERSION | typeof PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  const currentHeadSha = normalizeSha(input.headSha);
  const cycle = input.retainedOpenCycle
    ? retainPersistedOpenCycle(input.retainedOpenCycle)
    : createNewPackReviewCycle(input.tier, {
        ...input.options,
        capMapVersion: input.capMapVersion,
      });
  return {
    schemaVersion: 1,
    prNumber: positiveInteger(input.prNumber, 'prNumber'),
    transitionSeq: 0,
    phase: 'head_observed',
    currentHeadSha,
    updatedAtUtc: nowIso(input.options),
    cycle,
  };
}

function writeAuthorityUnlocked(
  document: PackReviewAuthorityDocument,
  options: PackReviewAuthorityOptions,
): PackReviewAuthorityDocument {
  validateAuthority(document);
  atomicWriteJson(authorityPath(document.prNumber, options), document);
  return document;
}

export function initializePackReviewAuthority(input: {
  prNumber: number;
  headSha: string;
  tier: PackReviewTier;
  retainedOpenCycle?: unknown;
  capMapVersion?: typeof PACK_REVIEW_CAP_MAP_VERSION | typeof PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  return withPackReviewAuthorityLock(input.options, () => {
    const existing = readAuthorityUnlocked(input.prNumber, input.options);
    if (existing) return existing;
    return writeAuthorityUnlocked(createInitialPackReviewAuthority({
      ...input,
      capMapVersion: input.capMapVersion ?? PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
    }), input.options);
  });
}

export function reconcilePackReviewTier(input: {
  prNumber: number;
  tier: PackReviewTier;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  const current = readPackReviewAuthority(input.prNumber, input.options);
  if (!current) throw new PackReviewAuthorityError('authority_missing', `PR ${input.prNumber}`);
  if (!current.cycle || current.cycle.frozenTier === input.tier) return current;
  const cycle = current.cycle;
  const safelyReplaceable = cycle.state === 'open'
    && cycle.consumedHeadShas.length === 0
    && cycle.reviewStageComplete !== true
    && !current.terminal
    && !current.evidence
    && !current.triage
    && !current.publication
    && !current.smokeOrdering?.independent?.startedEver;
  if (!safelyReplaceable) {
    throw new PackReviewAuthorityError(
      'tier_change_requires_reset',
      `persisted ${cycle.frozenTier} cycle cannot be replaced with authoritative ${input.tier}`,
    );
  }
  return commitPackReviewAuthorityTransition({
    prNumber: input.prNumber,
    expectedTransitionSeq: current.transitionSeq,
    nextPhase: current.phase,
    mutate(authority) {
      authority.cycle = createNewPackReviewCycle(input.tier, {
        now: input.options.now,
        capMapVersion: isLogicalRoundCycle(cycle)
          ? PACK_REVIEW_LOGICAL_CAP_MAP_VERSION
          : PACK_REVIEW_CAP_MAP_VERSION,
      });
      return authority;
    },
    options: input.options,
  });
}

export function commitPackReviewAuthorityTransition(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  nextPhase: PackReviewAuthorityPhase;
  mutate: (current: PackReviewAuthorityDocument) => PackReviewAuthorityDocument;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  return withPackReviewAuthorityLock(input.options, () => {
    const current = readAuthorityUnlocked(input.prNumber, input.options);
    if (!current) throw new PackReviewAuthorityError('authority_missing', `PR ${input.prNumber}`);
    if (current.transitionSeq !== input.expectedTransitionSeq) {
      throw new PackReviewAuthorityError(
        'authority_transition_conflict',
        `expected ${input.expectedTransitionSeq}, actual ${current.transitionSeq}`,
      );
    }
    const next = input.mutate(structuredClone(current));
    if (next.prNumber !== current.prNumber || next.schemaVersion !== 1) {
      throw new PackReviewAuthorityError('authority_identity_conflict', 'immutable identity changed');
    }
    if (phaseIndex(input.nextPhase) < phaseIndex(current.phase)
        && input.nextPhase !== 'head_observed') {
      throw new PackReviewAuthorityError(
        'authority_transition_invalid',
        `${current.phase} -> ${input.nextPhase}`,
      );
    }
    next.phase = input.nextPhase;
    next.transitionSeq = current.transitionSeq + 1;
    next.updatedAtUtc = nowIso(input.options);
    validateAuthority(next);
    return writeAuthorityUnlocked(next, input.options);
  });
}

export function observePackReviewHead(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  headSha: string;
  options: PackReviewAuthorityOptions;
  reviewRuns?: readonly PackReviewStartConsumptionRecord[];
}): PackReviewAuthorityDocument {
  const headSha = normalizeSha(input.headSha);
  return commitPackReviewAuthorityTransition({
    ...input,
    nextPhase: 'head_observed',
    mutate(current) {
      // Same-head observe rewinds the phase without resetting cycle, triage, or budget.
      const consumedRunEvidence = input.reviewRuns
        ? reviewRunEvidence(current, input.reviewRuns)
        : false;
      if (current.currentHeadSha === headSha) {
        if (current.cycle && !current.cycle.reviewStageComplete && consumedRunEvidence) {
          markReviewStageComplete(current, nowIso(input.options));
          current.cycle.reviewStartConsumed = true;
        }
        return current;
      }
      const completed = current.cycle?.reviewStageComplete === true
        || (current.cycle?.state === 'closed'
          && current.publication?.status === 'succeeded')
        || consumedRunEvidence;
      if (completed && current.cycle && current.cycle.reviewStageComplete !== true) {
        current.cycle.reviewStageComplete = true;
        current.cycle.reviewStageCompletedAtUtc = current.publication?.recordedAtUtc ?? nowIso(input.options);
        if (consumedRunEvidence) {
          current.cycle.reviewStartConsumed = true;
        }
      }
      current.currentHeadSha = headSha;
      current.evidence = undefined;
      current.triage = undefined;
      current.publication = undefined;
      if (current.smokeOrdering) {
        const independent = current.smokeOrdering.independent;
        const failedIndependent = independent?.status === 'failed';
        current.smokeOrdering = {
          ...current.smokeOrdering,
          workerOwned: current.cycle && isLogicalRoundCycle(current.cycle)
            ? current.smokeOrdering.workerOwned
            : undefined,
          ...(independent
            ? { independent: failedIndependent
              ? { ...independent, headSha, status: 'failed' }
              : { ...independent } }
            : {}),
          ...(independent?.startedEver ? {} : { reviewSettledHeadSha: undefined }),
        };
      }
      if (current.cycle?.reviewStageComplete === true) {
        return current;
      }
      if (current.cycle?.state === 'closed') {
        current.cycle = createNewPackReviewCycle(current.cycle.frozenTier, {
          now: input.options.now,
          capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
        });
      } else if (current.cycle?.state === 'at_cap_open_findings'
          || current.cycle?.state === 'at_cap_continuation_required') {
        current.cycle.state = 'at_cap_continuation_required';
      }
      return current;
    },
  });
}

export function reopenPackReviewAuthorityForExplicitExtraReview(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  headSha: string;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  const headSha = normalizeSha(input.headSha);
  const current = readPackReviewAuthority(input.prNumber, input.options);
  if (!current) throw new PackReviewAuthorityError('authority_missing', `PR ${input.prNumber}`);
  if (current.currentHeadSha !== headSha) {
    throw new PackReviewAuthorityError(
      'authority_transition_invalid',
      'explicit extra review reopen requires the exact current head',
    );
  }
  if (phaseIndex(current.phase) <= phaseIndex('head_observed')) return current;
  return observePackReviewHead(input);
}

export function terminalConsumesCapSlot(terminal: {
  status: string;
  findingCount?: number;
  failureClass?: string;
  reaperKilled?: boolean;
  superseded?: boolean;
  stale?: boolean;
  automaticBudgetDisposition?: PackReviewAutomaticBudgetDisposition;
}): boolean {
  if (terminal.superseded || terminal.stale || terminal.reaperKilled) return false;
  const status = String(terminal.status).toLowerCase();
  const findings = Number(terminal.findingCount ?? 0);
  if (status === 'timed_out' || terminal.failureClass === 'timeout_no_verdict') return false;
  if (['parse_error', 'process_error', 'empty_output'].includes(String(terminal.failureClass))) return false;
  if (status === 'up_to_date' || status === 'clean' || status === 'commented'
      || status === 'changes_requested') return true;
  if ((status === 'failed' || status === 'cancelled') && findings > 0) return true;
  return false;
}

export function validateTerminalV2(value: unknown): PackReviewTerminalV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PackReviewAuthorityError('terminal_contract_invalid', 'terminal row must be object');
  }
  const row = value as Partial<PackReviewTerminalV2>;
  if (row.schemaVersion !== 1 || row.terminalContractVersion !== 2) {
    throw new PackReviewAuthorityError('terminal_contract_invalid', 'requires schemaVersion 1 / terminalContractVersion 2');
  }
  if (!['normal', 'conflict_free_carryover', 'merge_composite'].includes(String(row.terminalSource))) {
    throw new PackReviewAuthorityError('terminal_contract_invalid', 'unknown terminalSource');
  }
  const normalized: PackReviewTerminalV2 = {
    ...row,
    schemaVersion: 1,
    terminalContractVersion: 2,
    terminalSource: row.terminalSource as PackReviewTerminalSource,
    automaticBudgetDisposition: validateBudgetDisposition(
      row.automaticBudgetDisposition,
      'terminal.automaticBudgetDisposition',
    ),
    runId: nonEmpty(row.runId, 'runId'),
    targetSha: normalizeSha(row.targetSha, 'targetSha'),
    reviewVerdict: row.reviewVerdict === 'clean' || row.reviewVerdict === 'findings'
      ? row.reviewVerdict
      : (() => { throw new PackReviewAuthorityError('terminal_contract_invalid', 'reviewVerdict'); })(),
    findingCount: Number(row.findingCount),
    findingsDigest: nonEmpty(row.findingsDigest, 'findingsDigest'),
    ...(row.logicalRoundOrdinal === undefined
      ? {}
      : { logicalRoundOrdinal: positiveInteger(row.logicalRoundOrdinal, 'logicalRoundOrdinal') }),
  } as PackReviewTerminalV2;
  if (!Number.isInteger(normalized.findingCount) || normalized.findingCount < 0) {
    throw new PackReviewAuthorityError('terminal_contract_invalid', 'findingCount');
  }
  if (normalized.reviewVerdict === 'clean' && normalized.findingCount !== 0) {
    throw new PackReviewAuthorityError('terminal_contract_invalid', 'clean with findings');
  }
  if (normalized.terminalSource === 'merge_composite') {
    const required = [
      'sourceCleanRunId', 'sourceHeadSha', 'mergeBaseSha', 'mainSha', 'replayDigest',
      'bundleDigest', 'helperVersion', 'focusedResolutionRunId',
    ] as const;
    for (const key of required) nonEmpty(normalized[key], key);
    normalizeSha(normalized.sourceHeadSha, 'sourceHeadSha');
    normalizeSha(normalized.mergeBaseSha, 'mergeBaseSha');
    normalizeSha(normalized.mainSha, 'mainSha');
    if (!Array.isArray(normalized.orderedParentShas) || normalized.orderedParentShas.length !== 2) {
      throw new PackReviewAuthorityError('terminal_contract_invalid', 'orderedParentShas');
    }
    const parents = normalized.orderedParentShas.map((sha) => normalizeSha(sha, 'orderedParentSha'));
    if (parents[0] !== normalized.sourceHeadSha || parents[1] !== normalized.mainSha) {
      throw new PackReviewAuthorityError('terminal_contract_invalid', 'ordered parents do not match source/main');
    }
    if (normalized.focusedResolutionVerdict !== 'clean') {
      throw new PackReviewAuthorityError('terminal_contract_invalid', 'focused resolution is not clean');
    }
  }
  if (normalized.terminalSource === 'conflict_free_carryover') {
    nonEmpty(normalized.sourceCleanRunId, 'sourceCleanRunId');
    normalizeSha(normalized.sourceHeadSha, 'sourceHeadSha');
    normalizeSha(normalized.mainSha, 'mainSha');
    nonEmpty(normalized.replayDigest, 'replayDigest');
  }
  return normalized;
}

export function stagePackReviewImmutableRecord(input: {
  kind: 'terminal' | 'bundle' | 'evidence';
  key: string;
  value: unknown;
  options: PackReviewAuthorityOptions;
}): { id: string; digest: string; path: string; created: boolean } {
  const key = nonEmpty(input.key, 'key');
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
    throw new PackReviewAuthorityError('authority_input_invalid', 'immutable key');
  }
  const bytes = `${stableJson(input.value)}\n`;
  const digest = sha256(bytes);
  const id = `${input.kind}-${key}`;
  const path = join(immutableRoot(input.options), input.kind, `${key}.json`);
  return withPackReviewAuthorityLock(input.options, () => {
    if (existsSync(path)) {
      const existingBytes = readFileSync(path, 'utf8');
      const existingDigest = sha256(existingBytes);
      if (existingDigest !== digest) {
        throw new PackReviewAuthorityError(
          'authority_conflict',
          `${id} existing=${existingDigest} attempted=${digest}`,
        );
      }
      return { id, digest, path, created: false };
    }
    mkdirSync(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    const persistedDigest = sha256(readFileSync(path));
    return { id, digest: persistedDigest, path, created: true };
  });
}

export function commitPackReviewTerminal(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  terminal: PackReviewTerminalV2;
  status: string;
  findingCount?: number;
  failureClass?: string;
  reaperKilled?: boolean;
  superseded?: boolean;
  stale?: boolean;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  const terminal = validateTerminalV2(input.terminal);
  const staged = stagePackReviewImmutableRecord({
    kind: 'terminal',
    key: terminal.runId,
    value: terminal,
    options: input.options,
  });
  return commitPackReviewAuthorityTransition({
    ...input,
    nextPhase: 'terminal_and_cap_committed',
    mutate(current) {
      if (terminal.targetSha !== current.currentHeadSha) {
        throw new PackReviewAuthorityError('terminal_head_stale', terminal.targetSha);
      }
      if (current.terminal?.targetSha === terminal.targetSha
          && current.terminal.reviewVerdict === 'findings'
          && terminal.reviewVerdict === 'clean') {
        throw new PackReviewAuthorityError('terminal_precedence_conflict', 'findings outrank clean');
      }
      current.terminal = {
        runId: terminal.runId,
        digest: staged.digest,
        targetSha: terminal.targetSha,
        ...(terminal.logicalRoundOrdinal === undefined ? {} : { logicalRoundOrdinal: terminal.logicalRoundOrdinal }),
        reviewVerdict: terminal.reviewVerdict,
        terminalSource: terminal.terminalSource,
        automaticBudgetDisposition: terminal.automaticBudgetDisposition,
        reviewStatus: input.status,
      };
      const cycle = current.cycle;
      if (!cycle) return current;
      if (isLogicalRoundCycle(cycle) && terminal.logicalRoundOrdinal === undefined) {
        cycle.capMapVersion = PACK_REVIEW_DISTINCT_HEAD_CAP_MAP_VERSION;
        cycle.frozenCap = PACK_REVIEW_DISTINCT_HEAD_CAPS[cycle.frozenTier];
        cycle.consumedRoundOrdinals = undefined;
      }
      const consumesAutomaticReviewBudget = terminal.terminalSource !== 'conflict_free_carryover';
      const consumesSlot = consumesAutomaticReviewBudget
        && terminalConsumesCapSlot({ ...input, automaticBudgetDisposition: terminal.automaticBudgetDisposition });
      if (consumesSlot) {
        if (isLogicalRoundCycle(cycle)) {
          const rounds = cycle.consumedRoundOrdinals!;
          const expectedOrdinal = rounds.length + 1;
          const ordinal = terminal.logicalRoundOrdinal ?? expectedOrdinal;
          if (!Number.isInteger(ordinal) || Number(ordinal) <= 0) {
            throw new PackReviewAuthorityError('cap_state_invalid', 'logical-round terminal has invalid round ordinal');
          }
          if (!rounds.includes(Number(ordinal))) {
            if (Number(ordinal) !== expectedOrdinal) {
              throw new PackReviewAuthorityError(
                'cap_state_invalid',
                `logical round ordinal ${String(ordinal)} does not match expected ${expectedOrdinal}`,
              );
            }
            if (rounds.length >= cycle.frozenCap) {
              throw new PackReviewAuthorityError('cap_exhausted', 'terminal cannot consume an extra logical round');
            }
            rounds.push(Number(ordinal));
          }
          if (!cycle.consumedHeadShas.includes(terminal.targetSha)) {
            cycle.consumedHeadShas.push(terminal.targetSha);
          }
        } else if (!cycle.consumedHeadShas.includes(terminal.targetSha)) {
          if (cycle.consumedHeadShas.length >= cycle.frozenCap) {
            throw new PackReviewAuthorityError('cap_exhausted', 'terminal cannot consume an extra head');
          }
          cycle.consumedHeadShas.push(terminal.targetSha);
        }
      }
      const consumedCount = cycleConsumedCount(cycle);
      if (terminal.reviewVerdict === 'clean' && terminal.findingCount === 0) {
        if (!isLogicalRoundCycle(cycle) || consumedCount >= cycle.frozenCap) {
          cycle.state = 'closed';
          cycle.closedAtUtc = nowIso(input.options);
          cycle.atCapHash = undefined;
        } else {
          cycle.state = 'open';
          cycle.closedAtUtc = undefined;
          cycle.atCapHash = undefined;
        }
      } else if (consumedCount === cycle.frozenCap) {
        cycle.state = 'at_cap_open_findings';
        cycle.atCapHash = sha256(stableJson(isLogicalRoundCycle(cycle) ? {
          cycleId: cycle.cycleId,
          frozenCap: cycle.frozenCap,
          consumedRoundOrdinals: cycle.consumedRoundOrdinals,
        } : {
          cycleId: cycle.cycleId,
          frozenCap: cycle.frozenCap,
          consumedHeadShas: cycle.consumedHeadShas,
        }));
      }
      return current;
    },
  });
}

export function smokeOrderingRequired(issueBody: string | undefined): boolean {
  const resolved = resolveSmokeRequirement(String(issueBody ?? ''));
  return resolved.requirement !== 'not-applicable' && resolved.requirement !== 'legacy-exempt';
}

export function assertPackReviewSmokeAdmission(input: {
  authority: PackReviewAuthorityDocument;
  headSha: string;
}): void {
  const headSha = normalizeSha(input.headSha, 'headSha');
  if (input.authority.currentHeadSha !== headSha) {
    throw new PackReviewAuthorityError('smoke_ordering_head_mismatch', `expected ${input.authority.currentHeadSha}, got ${headSha}`);
  }
  if (input.authority.smokeOrdering?.independent) {
    throw new PackReviewAuthorityError(
      'smoke_ordering_review_forbidden',
      'pack-review is forbidden after independent smoke has started',
    );
  }
}

export function assertIndependentSmokeAdmission(input: {
  authority: PackReviewAuthorityDocument;
  headSha: string;
  reviewRuns: readonly PackReviewStartConsumptionRecord[];
  operatorSmokeOnly?: boolean;
}): void {
  const headSha = normalizeSha(input.headSha, 'headSha');
  if (input.authority.currentHeadSha !== headSha) {
    throw new PackReviewAuthorityError('smoke_ordering_head_mismatch', `expected ${input.authority.currentHeadSha}, got ${headSha}`);
  }
  const ordering = input.authority.smokeOrdering;
  const independent = ordering?.independent;
  if (independent?.startedEver) {
    if (independent.status === 'failed'
        && independent.failureKind === 'finding'
        && independent.failureHeadSha === headSha) {
      throw new PackReviewAuthorityError(
        'smoke_ordering_independent_same_head_forbidden',
        'an independent smoke finding requires a worker fix and a new head',
      );
    }
    if (independent.headSha !== headSha && independent.status !== 'failed') {
      throw new PackReviewAuthorityError(
        'smoke_ordering_independent_head_forbidden',
        'a started or passed independent smoke cannot continue on a new head',
      );
    }
    if (independent.headSha === headSha && independent.status === 'started') {
      throw new PackReviewAuthorityError(
        'smoke_ordering_independent_in_progress',
        'independent smoke is already started for the exact head',
      );
    }
    if (independent.headSha === headSha && independent.status === 'passed') {
      throw new PackReviewAuthorityError(
        'smoke_ordering_independent_already_passed',
        'independent smoke already passed for the exact head',
      );
    }
    return;
  }
  if (['BLOCK', 'PENDING_ARCHITECT', 'PENDING_OPERATOR'].includes(input.authority.triage?.verdict ?? '')) {
    throw new PackReviewAuthorityError(
      'smoke_ordering_review_unsettled',
      'independent smoke is blocked while pack-review triage is unresolved',
    );
  }
  const workerOwnedPassed = input.operatorSmokeOnly === true
    && ordering?.workerOwned?.status === 'passed'
    && normalizeSha(ordering.workerOwned.headSha, 'smokeOrdering.workerOwned.headSha') === headSha;
  if (ordering?.reviewSettledHeadSha !== headSha
      && !reviewStartConsumedEvidence(input.authority, input.reviewRuns)
      && !workerOwnedPassed) {
    throw new PackReviewAuthorityError(
      'smoke_ordering_review_unsettled',
      'independent smoke requires settled pack-review obligations or a consumed review start',
    );
  }
}

export function commitSmokeOrderingTransition(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  actor: SmokeOrderingActor;
  headSha: string;
  status: SmokeOrderingStatus;
  failureKind?: SmokeOrderingFailureKind;
  reviewRuns?: readonly PackReviewStartConsumptionRecord[];
  operatorSmokeOnly?: boolean;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  const headSha = normalizeSha(input.headSha, 'headSha');
  const current = readPackReviewAuthority(input.prNumber, input.options);
  if (!current) throw new PackReviewAuthorityError('authority_missing', `PR ${input.prNumber}`);
  return commitPackReviewAuthorityTransition({
    prNumber: input.prNumber,
    expectedTransitionSeq: input.expectedTransitionSeq,
    nextPhase: current.phase,
    mutate(authority) {
      if (authority.currentHeadSha !== headSha) {
        throw new PackReviewAuthorityError('smoke_ordering_head_mismatch', `expected ${authority.currentHeadSha}, got ${headSha}`);
      }
      const now = nowIso(input.options);
      if (input.actor === 'worker-owned') {
        if (input.status !== 'started' && authority.smokeOrdering?.workerOwned?.status !== 'started') {
          throw new PackReviewAuthorityError(
            'smoke_ordering_worker_smoke_not_started',
            'worker-owned smoke result requires a started dispatch',
          );
        }
        if (authority.smokeOrdering?.independent) {
          throw new PackReviewAuthorityError(
            'smoke_ordering_worker_smoke_forbidden',
            'worker-owned smoke is forbidden after independent smoke has started',
          );
        }
        authority.smokeOrdering = {
          ...authority.smokeOrdering,
          workerOwned: { headSha, status: input.status, updatedAtUtc: now },
        };
      } else {
        if (input.status === 'started') {
          const reviewRuns = input.reviewRuns
            ?? (authority.smokeOrdering?.reviewSettledHeadSha === headSha ? [] : undefined);
          if (!reviewRuns) {
            throw new PackReviewAuthorityError(
              'authority_input_invalid',
              'reviewRuns are required for independent-smoke admission when exact-head review settlement is absent',
            );
          }
          assertIndependentSmokeAdmission({
            authority,
            headSha,
            reviewRuns,
            operatorSmokeOnly: input.operatorSmokeOnly,
          });
        } else if (!authority.smokeOrdering?.independent?.startedEver
            || authority.smokeOrdering.independent.status !== 'started') {
          throw new PackReviewAuthorityError(
            'smoke_ordering_independent_not_started',
            'independent smoke result requires a started dispatch',
          );
        }
        authority.smokeOrdering = {
          ...authority.smokeOrdering,
          independent: {
            startedEver: true,
            headSha,
            status: input.status,
            updatedAtUtc: now,
            ...(input.status === 'failed' && input.failureKind
              ? {
                failureKind: input.failureKind,
                ...(input.failureKind === 'finding' ? { failureHeadSha: headSha } : {}),
              }
              : {}),
          },
        };
      }
      return authority;
    },
    options: input.options,
  });
}

export function selectPackReviewEvidence(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  expectedEvidenceKey: string;
  selectedEvidenceId: string;
  selectedEvidenceDigest: string;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  return commitPackReviewAuthorityTransition({
    ...input,
    nextPhase: 'evidence_selected',
    mutate(current) {
      if (!current.cycle || !['at_cap_open_findings', 'at_cap_continuation_required'].includes(current.cycle.state)) {
        throw new PackReviewAuthorityError('evidence_selection_invalid', 'cycle is not at cap');
      }
      const expectedEvidenceKey = nonEmpty(input.expectedEvidenceKey, 'expectedEvidenceKey');
      const selectedEvidenceId = nonEmpty(input.selectedEvidenceId, 'selectedEvidenceId');
      const selectedEvidenceDigest = nonEmpty(input.selectedEvidenceDigest, 'selectedEvidenceDigest');
      const evidenceRecords = listPackReviewImmutableRecordsUnlocked('evidence', input.options);
      if (evidenceRecords.some((entry) => entry.malformed)) {
        throw new PackReviewAuthorityError('evidence_selection_invalid', 'malformed evidence record');
      }
      const matches = evidenceRecords.filter((entry) =>
        canonicalEvidenceRecordMatches(
          entry.value,
          expectedEvidenceKey,
          selectedEvidenceId,
          current,
        ) && entry.digest === selectedEvidenceDigest,
      );
      if (matches.length !== 1) {
        throw new PackReviewAuthorityError(
          'evidence_selection_invalid',
          'selected evidence does not match the immutable current-head record',
        );
      }
      current.evidence = {
        expectedEvidenceKey,
        selectedEvidenceId,
        selectedEvidenceDigest,
        selectedAtUtc: nowIso(input.options),
      };
      return current;
    },
  });
}

function markReviewStageComplete(
  current: PackReviewAuthorityDocument,
  completedAtUtc: string,
): void {
  if (!current.cycle || current.cycle.reviewStageComplete === true) return;
  current.cycle.reviewStageComplete = true;
  current.cycle.reviewStageCompletedAtUtc = completedAtUtc;
}

function reviewStartConsumedEvidence(
  authority: PackReviewAuthorityDocument,
  reviewRuns: readonly PackReviewStartConsumptionRecord[],
): boolean {
  if (['BLOCK', 'PENDING_ARCHITECT', 'PENDING_OPERATOR'].includes(authority.triage?.verdict ?? '')) {
    return false;
  }
  const reviewStatus = String(authority.terminal?.reviewStatus ?? '').toLowerCase();
  return reviewStatus === 'failed'
    || reviewStatus === 'error'
    || reviewStatus === 'changes_requested'
    || Boolean(
      authority.cycle
      && authority.cycle.consumedHeadShas.length >= authority.cycle.frozenCap,
    )
    || reviewRunEvidence(authority, reviewRuns);
}

function reviewRunEvidence(
  authority: PackReviewAuthorityDocument,
  reviewRuns: readonly PackReviewStartConsumptionRecord[],
): boolean {
  if (!authority.cycle || isLogicalRoundCycle(authority.cycle)) return false;
  const cycleOpenedAt = Date.parse(authority.cycle.openedAtUtc);
  if (!Number.isFinite(cycleOpenedAt)) return false;
  return reviewRuns.some((run) => {
    const runCreatedAt = typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : Number.NaN;
    return run.prNumber === authority.prNumber
      && run.stale !== true
      && run.automaticBudgetDisposition === 'consume'
      && String(run.status ?? '').toLowerCase() === 'failed'
      && Number.isFinite(runCreatedAt)
      && runCreatedAt >= cycleOpenedAt;
  });
}

function reviewObligationsSettled(authority: PackReviewAuthorityDocument): boolean {
  const cycle = authority.cycle;
  if (cycle?.reviewStageComplete === true) return true;
  if (!cycle) return false;
  const reviewStatus = authority.terminal?.reviewStatus;
  if (isLogicalRoundCycle(cycle)) {
    const clearTerminal = reviewStatus === 'clean' || reviewStatus === 'up_to_date' || reviewStatus === 'commented';
    if (cycleConsumedCount(cycle) < cycle.frozenCap) return false;
    if (cycle.state === 'closed' && clearTerminal) {
      return true;
    }
    return (cycle.state === 'at_cap_open_findings' || cycle.state === 'at_cap_continuation_required')
      && authority.triage?.verdict === 'DEFER';
  }
  if (cycle.state === 'closed') return true;
  if (reviewStatus === 'clean' || reviewStatus === 'up_to_date' || reviewStatus === 'commented') return true;
  return (cycle.state === 'at_cap_open_findings' || cycle.state === 'at_cap_continuation_required')
    && authority.triage?.source === 'architect'
    && authority.triage.verdict === 'DEFER';
}

export function commitPackReviewTriage(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  triage: PackReviewTriageState;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  return commitPackReviewAuthorityTransition({
    ...input,
    nextPhase: 'triage_committed',
    mutate(current) {
      let automaticEvidencePredicate: 'intersection' | 'no_intersection' | undefined;
      let automaticFindingResolution: Record<string, unknown> | undefined;
      if (input.triage.source === 'automatic') {
        if (input.triage.verdict !== 'PENDING_OPERATOR' && !current.evidence) {
          throw new PackReviewAuthorityError('triage_invalid', 'automatic triage lacks selected evidence');
        }
        if (current.evidence) {
          const evidenceRecords = listPackReviewImmutableRecordsUnlocked('evidence', input.options);
          const canonical = evidenceRecords.filter((entry) => canonicalEvidenceRecordMatches(
            entry.value,
            current.evidence!.expectedEvidenceKey,
            current.evidence!.selectedEvidenceId,
            current,
          ) && entry.digest === current.evidence!.selectedEvidenceDigest);
          if (evidenceRecords.some((entry) => entry.malformed) || canonical.length !== 1) {
            throw new PackReviewAuthorityError('triage_invalid', 'automatic triage evidence is not canonical');
          }
          const value = canonical[0]!.value as Record<string, unknown>;
          automaticEvidencePredicate = value.predicateResult === 'intersection'
            || value.predicateResult === 'no_intersection'
            ? value.predicateResult
            : undefined;
          const resolution = value.findingResolution;
          automaticFindingResolution = resolution && typeof resolution === 'object' && !Array.isArray(resolution)
            ? resolution as Record<string, unknown>
            : undefined;
        }
        const workerOwned = current.smokeOrdering?.workerOwned;
        const resolution = automaticFindingResolution;
        const findingCount = Number(resolution?.findingCount);
        const blockingFindingCount = Number(resolution?.blockingFindingCount);
        const nonBlockingFindingCount = Number(resolution?.nonBlockingFindingCount);
        const unresolvedBlockingFindingCount = Number(resolution?.unresolvedBlockingFindingCount);
        const finalFixResolutionBound = resolution?.predicateResult === 'resolved'
          && resolution.resolutionBasis === 'explicit_current_head_finding_selection'
          && resolution.findingSnapshotDigest === input.triage.findingSnapshotDigest
          && resolution.priorReviewedHeadSha === current.terminal?.targetSha
          && resolution.currentHeadSha === current.currentHeadSha
          && Number.isInteger(findingCount)
          && findingCount > 0
          && Number.isInteger(blockingFindingCount)
          && blockingFindingCount >= 0
          && blockingFindingCount <= findingCount
          && Number.isInteger(nonBlockingFindingCount)
          && nonBlockingFindingCount === findingCount - blockingFindingCount
          && Number.isInteger(unresolvedBlockingFindingCount)
          && unresolvedBlockingFindingCount === 0;
        const finalFixSettlement = input.triage.verdict === 'DEFER'
          && current.cycle?.state === 'at_cap_continuation_required'
          && cycleConsumedCount(current.cycle) === current.cycle.frozenCap
          && current.terminal?.reviewVerdict === 'findings'
          && current.terminal.targetSha !== current.currentHeadSha
          && (isLogicalRoundCycle(current.cycle)
            || (workerOwned?.headSha === current.currentHeadSha && workerOwned.status === 'passed'))
          && automaticEvidencePredicate === 'no_intersection'
          && finalFixResolutionBound;
        if (input.triage.verdict === 'DEFER' && !finalFixSettlement) {
          throw new PackReviewAuthorityError(
            'triage_invalid',
            isLogicalRoundCycle(current.cycle!)
              ? 'automatic DEFER requires final-cap continuation, no-intersection scope evidence, and exact finding-resolution evidence'
              : 'automatic DEFER requires final-cap continuation, exact-head worker smoke PASS, no-intersection scope evidence, and exact finding-resolution evidence',
          );
        }
      } else if (!['BLOCK', 'DEFER'].includes(input.triage.verdict)) {
        throw new PackReviewAuthorityError('triage_invalid', 'architect verdict must be BLOCK or DEFER');
      }
      current.triage = { ...input.triage };
      const automaticFinalFixSettlement = input.triage.source === 'automatic'
        && input.triage.verdict === 'DEFER';
      if (automaticFinalFixSettlement
          || (current.publication?.status === 'succeeded' && reviewObligationsSettled(current))) {
        markReviewStageComplete(current, input.triage.committedAtUtc);
        current.smokeOrdering = {
          ...current.smokeOrdering,
          reviewSettledHeadSha: current.currentHeadSha,
        };
      }
      return current;
    },
  });
}

export function recordPackReviewPublication(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  publication: PackReviewPublicationState;
  options: PackReviewAuthorityOptions;
  nextPhase?: PackReviewAuthorityPhase;
}): PackReviewAuthorityDocument {
  return commitPackReviewAuthorityTransition({
    ...input,
    nextPhase: input.nextPhase ?? 'external_published',
    mutate(current) {
      if (!current.terminal || current.terminal.runId !== input.publication.terminalRunId) {
        throw new PackReviewAuthorityError('publication_invalid', 'terminal is not authoritative');
      }
      if (input.publication.headSha !== current.currentHeadSha) {
        throw new PackReviewAuthorityError('publication_head_stale', input.publication.headSha);
      }
      current.publication = { ...input.publication };
      if (input.publication.status === 'succeeded' && reviewObligationsSettled(current)) {
        markReviewStageComplete(current, input.publication.recordedAtUtc);
        current.smokeOrdering = {
          ...current.smokeOrdering,
          reviewSettledHeadSha: current.currentHeadSha,
        };
      }
      return current;
    },
  });
}

export function acknowledgePackReviewReset(input: {
  prNumber: number;
  expectedTransitionSeq: number;
  headSha: string;
  tier: PackReviewTier;
  provenance: PackReviewResetProvenance;
  capMapVersion?: typeof PACK_REVIEW_CAP_MAP_VERSION | typeof PACK_REVIEW_LOGICAL_CAP_MAP_VERSION;
  options: PackReviewAuthorityOptions;
}): PackReviewAuthorityDocument {
  const headSha = normalizeSha(input.headSha);
  return commitPackReviewAuthorityTransition({
    ...input,
    nextPhase: 'head_observed',
    mutate(current) {
      const cycle = current.cycle;
      if (!cycle || !['at_cap_open_findings', 'at_cap_continuation_required'].includes(cycle.state)) {
        throw new PackReviewAuthorityError('reset_invalid', 'cycle is not at cap');
      }
      if (cycle.reviewStageComplete === true) {
        throw new PackReviewAuthorityError('reset_invalid', 'completed review stage cannot replenish automatic budget');
      }
      if (input.provenance.priorCycleId !== cycle.cycleId
          || input.provenance.priorAtCapHash !== cycle.atCapHash) {
        throw new PackReviewAuthorityError('reset_invalid', 'prior cycle/hash mismatch');
      }
      nonEmpty(input.provenance.actor, 'actor');
      nonEmpty(input.provenance.reason, 'reason');
      nonEmpty(input.provenance.timestampUtc, 'timestampUtc');
      nonEmpty(input.provenance.nonce, 'nonce');
      current.currentHeadSha = headSha;
      current.cycle = createNewPackReviewCycle(input.tier, {
        ...input.options,
        capMapVersion: input.capMapVersion,
      }, input.provenance);
      current.terminal = undefined;
      current.evidence = undefined;
      current.triage = undefined;
      current.publication = undefined;
      return current;
    },
  });
}

function canonicalEvidenceRecordMatches(
  value: unknown,
  expectedEvidenceKey: string,
  selectedEvidenceId: string,
  authority: PackReviewAuthorityDocument,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !authority.cycle) return false;
  const record = value as Record<string, unknown>;
  const tuple = record.tuple;
  if (!tuple || typeof tuple !== 'object' || Array.isArray(tuple)) return false;
  const tupleRecord = tuple as Record<string, unknown>;
  return record.schema === 'merge-triage-evidence/v1'
    && record.pathId === 'scope-denylist-current-head/v1'
    && record.producer === 'scripts/merge-triage-evidence.ts'
    && record.evidenceId === `mte-${expectedEvidenceKey}`
    && record.evidenceId === selectedEvidenceId
    && record.expectedEvidenceKey === expectedEvidenceKey
    && tupleRecord.prNumber === authority.prNumber
    && tupleRecord.cycleId === authority.cycle.cycleId
    && tupleRecord.currentHeadSha === authority.currentHeadSha
    && Array.isArray(record.changedPaths)
    && Array.isArray(record.denylistPatterns)
    && Array.isArray(record.matchedPaths)
    && (record.predicateResult === 'intersection' || record.predicateResult === 'no_intersection');
}

function listPackReviewImmutableRecordsUnlocked(
  kind: 'terminal' | 'bundle' | 'evidence',
  options: PackReviewAuthorityOptions,
): Array<{ path: string; value: unknown; digest: string; malformed?: boolean }> {
  const dir = join(immutableRoot(options), kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const bytes = readFileSync(path);
      const digest = sha256(bytes);
      try {
        return { path, value: JSON.parse(bytes.toString('utf8')), digest };
      } catch {
        return { path, value: undefined, digest, malformed: true };
      }
    });
}

export function listPackReviewImmutableRecords(
  kind: 'terminal' | 'bundle' | 'evidence',
  options: PackReviewAuthorityOptions,
): Array<{ path: string; value: unknown; digest: string; malformed?: boolean }> {
  return withPackReviewAuthorityLock(options, () => listPackReviewImmutableRecordsUnlocked(kind, options));
}
