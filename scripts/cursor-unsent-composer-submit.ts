#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOrcaJson, type OrcaJsonResponse } from './orca-runtime/native.ts';
import {
  type RuntimeAdapter,
  type RuntimeComposerControl,
  type RuntimeDispatchResult,
  type RuntimeLiveness,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from './runtime/contracts.ts';
import { selectRuntimeAdapter } from './runtime/registry.ts';
import {
  releaseHeldFileLock,
  replaceLockedFileContents,
  tryAcquireHeldFileLock,
} from './runtime/single-instance-lease.ts';
import { resolveWakeSupervisorStateRoot } from './pr2-foundation/wake-supervisor-state-root.ts';

const UNBOXED_BOX_CHROME = /^[▀▄]+$/u;
const UNBOXED_CTRL_C = /^ctrl\+c to stop\b/iu;
const UNBOXED_STATUS_FOOTER = /^(?:Cursor|GPT-\S+|Composer)\s.+(?:\d+(?:\.\d+)?%|Run Everything)/iu;
const UNBOXED_CWD_FOOTER = /^(?:~[/\\]|[A-Za-z]:[\\/]|\/)/u;
const EMPTY_COMPOSER = /^(?:→\s*)?Add a follow-up\b/iu;
export const ORCHESTRATION_NOTICE = /^You have \d+ orchestration messages?\.(?: .*)? Run `orca orchestration check(?: --run \S+| --terminal \S+)?`\.$/iu;
const ORCHESTRATION_CHECK_COMMAND = /orca orchestration check(?: --run \S+| --terminal \S+)?/iu;
const LONE_ARROW = /^→$/u;
const BOX_TOP = /^\s*▄{8,}\s*$/u;
const BOX_BOTTOM = /^\s*▀{8,}\s*$/u;
const DEFAULT_INTERVAL_MS = 2_000;
const DELIVERY_RENDER_GRACE_MS = 250;
const DELIVERY_LIVENESS_WINDOW_MS = 25;
export const WATCH_LOCK_PATH = join(tmpdir(), 'opk-cursor-unsent-composer-submit.lock');
export const SENT_STORE_PATH = join(tmpdir(), 'opk-cursor-unsent-composer-submit.sent.json');
export const ORCHESTRATION_RECONCILE_LEDGER_PATH = join(
  resolveWakeSupervisorStateRoot(),
  'orchestration-mail-reconcile.json',
);
export const ORCHESTRATION_RECONCILE_LOCK_PATH = join(
  resolveWakeSupervisorStateRoot(),
  'orchestration-mail-reconcile.lock',
);
const ORCHESTRATION_RECONCILE_WINDOW_MS = 60_000;
const ORCHESTRATION_RECONCILE_MAX_BACKOFF_MS = 30 * 60_000;
const ORCHESTRATION_INBOX_LIMIT = 5_000;
const RECONCILE_COMMAND_TIMEOUT_MS = 10_000;

export type CursorComposerKind = 'empty' | 'non_empty';

function composerInterior(preview: string): string[] | undefined {
  const raw = preview.split(/\r?\n/);
  let top = -1;
  for (let index = 0; index < raw.length; index += 1) {
    if (BOX_TOP.test(raw[index] ?? '')) top = index;
  }
  if (top < 0) return undefined;
  for (let index = top + 1; index < raw.length; index += 1) {
    if (BOX_BOTTOM.test(raw[index] ?? '')) return raw.slice(top + 1, index);
  }
  return undefined;
}

function trimNonEmpty(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter(Boolean);
}

function composerContentLines(
  lines: readonly string[],
  includeTrailingNotices = false,
 ): string[] {
  const content = trimNonEmpty(lines)
    .filter((line) => !LONE_ARROW.test(line) && !UNBOXED_CTRL_C.test(line))
    .map((line) => line.replace(/^→\s*/u, '').trim())
    .filter(Boolean);
  // A live orchestration notice can be rendered inside the box after the
  // user's text. Preserve a notice in the first line for compatibility with
  // a user-entered poke, but exclude trailing notices from the fingerprint.
  return includeTrailingNotices
    ? content
    : content.filter((line, index) => index === 0 || !ORCHESTRATION_NOTICE.test(line));
}

function unboxedComposerLines(preview: string, includeTrailingNotices = false): string[] {
  const lines = composerContentLines(preview.split(/\r?\n/), includeTrailingNotices);
  let end = lines.length;
  while (
    end > 0
    && (UNBOXED_BOX_CHROME.test(lines[end - 1] ?? '') || UNBOXED_CTRL_C.test(lines[end - 1] ?? ''))
  ) {
    end -= 1;
  }
  if (
    end >= 2
    && UNBOXED_STATUS_FOOTER.test(lines[end - 2] ?? '')
    && UNBOXED_CWD_FOOTER.test(lines[end - 1] ?? '')
  ) {
    return lines.slice(0, end - 2);
  }
  return [];
}

function classifyContent(
  lines: readonly string[],
  trailingPlaceholderMeansEmpty = false,
): CursorComposerKind {
  return lines.length === 0
    || (EMPTY_COMPOSER.test(lines.at(-1) ?? '')
      && (trailingPlaceholderMeansEmpty || lines.length === 1))
    ? 'empty'
    : 'non_empty';
}

export function classifyCursorComposer(preview: string): CursorComposerKind {
  const interior = composerInterior(preview);
  if (interior) return classifyContent(composerContentLines(interior));
  return classifyContent(unboxedComposerLines(preview), true);
}

export function cursorComposerLooksUnsent(preview: string): boolean {
  return classifyCursorComposer(preview) === 'non_empty';
}

export function composerPokeFingerprint(preview: string): string {
  const interior = composerInterior(preview);
  const source = interior ? composerContentLines(interior) : unboxedComposerLines(preview);
  return source.join('\n');
}

function exactOrchestrationPointerFingerprint(preview: string): string | undefined {
  const interior = composerInterior(preview);
  const source = interior
    ? composerContentLines(interior, true)
    : unboxedComposerLines(preview, true);
  // Cursor may wrap between words or inside the command token. Try both
  // reconstructions, but reject stacked notices and return only the command.
  const candidates = [source.join(''), source.join(' '), preview.trim()];
  for (const candidate of candidates) {
    const headers = candidate.match(/You have \d+ orchestration messages?\b/giu);
    if (headers?.length !== 1) continue;
    const command = candidate.match(new RegExp('^You have \\d+ orchestration messages?\\b.*\\x60(orca orchestration check(?: --run \\S+| --terminal \\S+)?)\\x60\\.$', 'iu'))?.[1];
    if (command && ORCHESTRATION_CHECK_COMMAND.test(command)) return command;
  }
  return undefined;
}

export function workerKey(identity: RuntimeWorkerIdentity): string {
  return `${identity.runtime}\u0000${identity.id}\u0000${identity.generation}`;
}

function workspaceSelectorsFromList(response: OrcaJsonResponse<unknown>): string[] {
  const selectors = ['active'];
  const result = response.result;
  if (!result || typeof result !== 'object') return selectors;
  const worktrees = 'worktrees' in result && Array.isArray(result.worktrees)
    ? result.worktrees
    : [];
  for (const row of worktrees) {
    if (!row || typeof row !== 'object') continue;
    const path = (row as { path?: unknown }).path;
    if (typeof path === 'string' && path.trim()) selectors.push(path.trim());
  }
  return [...new Set(selectors)];
}

interface WatchStoreIdentityRow {
  readonly runtime: string;
  readonly id: string;
  readonly generation: string;
  readonly fingerprint: string;
  readonly ambiguous?: boolean;
}

interface WatchStore {
  readonly submitted: readonly WatchStoreIdentityRow[];
  readonly observations: readonly (WatchStoreIdentityRow & { readonly changedAt: number })[];
}

function identityFromKey(key: string, fingerprint: string): WatchStoreIdentityRow | undefined {
  const [runtime, id, generation] = key.split('\u0000');
  if (!runtime || !id || !generation) return undefined;
  return { runtime, id, generation, fingerprint };
}

function readIdentityRow(row: unknown): WatchStoreIdentityRow | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const runtime = (row as { runtime?: unknown }).runtime;
  const id = (row as { id?: unknown }).id;
  const generation = (row as { generation?: unknown }).generation;
  const fingerprint = (row as { fingerprint?: unknown }).fingerprint;
  const ambiguous = (row as { ambiguous?: unknown }).ambiguous;
  if (
    typeof runtime !== 'string' || !runtime
    || typeof id !== 'string' || !id
    || typeof generation !== 'string' || !generation
    || typeof fingerprint !== 'string' || !fingerprint
  ) return undefined;
  return { runtime, id, generation, fingerprint, ...(ambiguous === true ? { ambiguous: true } : {}) };
}

export function loadWatchStore(path: string): WatchStore {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      return { submitted: parsed.flatMap((row) => readIdentityRow(row) ? [readIdentityRow(row)!] : []), observations: [] };
    }
    if (!parsed || typeof parsed !== 'object') return { submitted: [], observations: [] };
    const submittedRaw = (parsed as { submitted?: unknown }).submitted;
    const observationsRaw = (parsed as { observations?: unknown }).observations;
    const submitted = Array.isArray(submittedRaw)
      ? submittedRaw.flatMap((row) => { const parsedRow = readIdentityRow(row); return parsedRow ? [parsedRow] : []; })
      : [];
    const observations = Array.isArray(observationsRaw)
      ? observationsRaw.flatMap((row) => {
        const parsedRow = readIdentityRow(row);
        const changedAt = (row as { changedAt?: unknown }).changedAt;
        if (!parsedRow || !Number.isFinite(changedAt)) return [];
        return [{ ...parsedRow, changedAt: Number(changedAt) }];
      })
      : [];
    return { submitted, observations };
  } catch {
    return { submitted: [], observations: [] };
  }
}

export function loadSubmittedFingerprints(path: string): Map<string, string> {
  const loaded = new Map<string, string>();
  for (const row of loadWatchStore(path).submitted) {
    loaded.set(workerKey(row), row.fingerprint);
  }
  return loaded;
}

export function saveSubmittedFingerprints(path: string, submitted: ReadonlyMap<string, string>): void {
  saveWatchStore(path, {
    submittedFingerprint: submitted,
    ambiguousSubmittedFingerprints: new Map(),
    lastFingerprint: new Map(),
    lastChangedAt: new Map(),
  });
}

interface PersistableWatchState {
  readonly submittedFingerprint: ReadonlyMap<string, string>;
  readonly ambiguousSubmittedFingerprints: ReadonlyMap<string, ReadonlySet<string>>;
  readonly lastFingerprint: ReadonlyMap<string, string>;
  readonly lastChangedAt: ReadonlyMap<string, number>;
}

function saveWatchStore(path: string, state: PersistableWatchState): void {
  const submittedRows = new Map<string, WatchStoreIdentityRow>();
  for (const [key, fingerprint] of state.submittedFingerprint.entries()) {
    const row = identityFromKey(key, fingerprint);
    if (!row) continue;
    const ambiguous = state.ambiguousSubmittedFingerprints.get(key)?.has(fingerprint) ?? false;
    submittedRows.set(`${key}\u0000${fingerprint}`, ambiguous ? { ...row, ambiguous: true } : row);
  }
  for (const [key, fingerprints] of state.ambiguousSubmittedFingerprints.entries()) {
    for (const fingerprint of fingerprints) {
      const row = identityFromKey(key, fingerprint);
      if (row) submittedRows.set(`${key}\u0000${fingerprint}`, { ...row, ambiguous: true });
    }
  }
  const submitted = [...submittedRows.values()];
  const observations = [...state.lastFingerprint.entries()].flatMap(([key, fingerprint]) => {
    const row = identityFromKey(key, fingerprint);
    const changedAt = state.lastChangedAt.get(key);
    if (!row || !Number.isFinite(changedAt)) return [];
    return [{ ...row, changedAt: changedAt as number }];
  });
  writeFileSync(path, `${JSON.stringify({ submitted, observations })}\n`);
}

function hydrateSubmitted(state: UnsentComposerWatchState, path: string | undefined): void {
  if (!path) return;
  const store = loadWatchStore(path);
  for (const row of store.submitted) {
    const key = workerKey(row);
    if (!state.submittedFingerprint.has(key)) state.submittedFingerprint.set(key, row.fingerprint);
    if (row.ambiguous) {
      const fingerprints = state.ambiguousSubmittedFingerprints.get(key) ?? new Set<string>();
      fingerprints.add(row.fingerprint);
      state.ambiguousSubmittedFingerprints.set(key, fingerprints);
    }
  }
  for (const row of store.observations) {
    const key = workerKey(row);
    if (!state.lastFingerprint.has(key)) {
      state.lastFingerprint.set(key, row.fingerprint);
      state.lastChangedAt.set(key, row.changedAt);
    }
  }
}

function persistSubmitted(state: UnsentComposerWatchState, path: string | undefined): void {
  if (!path) return;
  saveWatchStore(path, state);
}

export interface UnsentComposerSubmitDeps {
  readonly [key: string]: unknown;
  readonly listWorkers: () => { ok: true; workers: readonly RuntimeWorker[] } | { ok: false; reason: string };
  readonly listWorkersAsync?: () => PromiseLike<
    { ok: true; workers: readonly RuntimeWorker[] } | { ok: false; reason: string }
  >;
  readonly read: (worker: RuntimeWorkerIdentity) =>
    | { ok: true; lines: readonly string[]; source: 'screen' }
    | { ok: false; reason: string };
  readonly readAsync?: (worker: RuntimeWorkerIdentity) => PromiseLike<
    | { ok: true; lines: readonly string[]; source: 'screen' }
    | { ok: false; reason: string }
  >;
  readonly submit: (worker: RuntimeWorkerIdentity) => RuntimeDispatchResult;
  readonly composerControl?: (worker: RuntimeWorkerIdentity) => RuntimeComposerControl | undefined;
  readonly liveness?: (worker: RuntimeWorkerIdentity, observationWindowMs: number) =>
    RuntimeLiveness;
  readonly sleepAsync?: (milliseconds: number) => PromiseLike<void>;
  readonly sleep?: (milliseconds: number) => void;
  readonly now?: () => number;
  readonly sentStorePath?: string;
}

export interface UnsentComposerSubmitInput {
  readonly terminals?: readonly string[];
  readonly dryRun?: boolean;
  readonly watch?: boolean;
  readonly intervalMs?: number;
}

interface DeliveryTerminalSubmitResolver {
  findWorkerById(
    id: string,
  ): ReturnType<RuntimeAdapter['findWorkerById']>;
}

interface OrcaInboxMessageRow {
  readonly id?: string;
  readonly run_id?: string;
  readonly to_handle?: string;
  readonly read?: number | boolean;
}

interface OrcaInboxFullResult {
  readonly messages?: readonly OrcaInboxMessageRow[];
}

interface OrcaRunShowResult {
  readonly run?: {
    readonly id?: string;
    readonly coordinator_handle?: string;
    readonly coordinator_pane_key?: string;
  };
}

interface DeliveryMessage {
  readonly id: string;
  readonly runId: string;
  readonly recipient: string;
  readonly consumed: boolean;
}

interface DeliveryPointerSubmitOptions {
  readonly reconcileLedgerPath?: string;
  readonly reconcileLockPath?: string;
  readonly now?: () => number;
}

interface EpisodeRecord {
  readonly messageId: string;
  readonly runId: string;
  readonly recipient: string;
  readonly workerKey: string;
  readonly stableKey?: string;
  readonly nextEligibleAt: number;
  readonly backoffMs?: number;
  readonly state: 'claimed' | 'pointer-visible' | 'confirmed';
}

interface PersistedReconcileState {
  readonly messages: Record<string, number>;
  readonly episodes: Record<string, EpisodeRecord>;
}

function recipientEpisodeKey(worker: RuntimeWorker): string {
  const stableKey = worker.stableKey?.trim();
  return stableKey ? `stable\u0000${stableKey}` : workerKey(worker.identity);
}

function episodeKey(message: DeliveryMessage, worker: RuntimeWorker): string {
  return `${recipientEpisodeKey(worker)}\u0000message\u0000${message.id}`;
}

function pointerLedgerKey(message: DeliveryMessage, worker: RuntimeWorker): string {
  return `${recipientEpisodeKey(worker)}\u0000pointer\u0000${buildDeliveryPointer(message)}`;
}
function loadReconcileState(path: string): PersistedReconcileState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return { messages: {}, episodes: {} };
    const record = parsed as Record<string, unknown>;
    const messages: Record<string, number> = {};
    const episodes: Record<string, EpisodeRecord> = {};
    const messageSource = record.messages && typeof record.messages === 'object'
      ? record.messages as Record<string, unknown>
      : record;
    for (const [id, value] of Object.entries(messageSource)) {
      if (typeof value === 'number' && Number.isFinite(value)) messages[id] = value;
    }
    if (record.episodes && typeof record.episodes === 'object') {
      for (const [key, value] of Object.entries(record.episodes as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Partial<EpisodeRecord> & { readonly sealed?: unknown; readonly state?: unknown };
        if (
          typeof row.messageId === 'string' && row.messageId
          && typeof row.runId === 'string' && row.runId
          && typeof row.recipient === 'string' && row.recipient
          && typeof row.workerKey === 'string' && row.workerKey
          && typeof row.nextEligibleAt === 'number' && Number.isFinite(row.nextEligibleAt)
          && (row.backoffMs === undefined || (typeof row.backoffMs === 'number' && Number.isFinite(row.backoffMs)))
        ) episodes[key] = {
          messageId: row.messageId,
          runId: row.runId,
          recipient: row.recipient,
          workerKey: row.workerKey,
          ...(typeof row.stableKey === 'string' && row.stableKey.trim() ? { stableKey: row.stableKey.trim() } : {}),
          nextEligibleAt: row.nextEligibleAt,
          ...(typeof row.backoffMs === 'number' ? { backoffMs: row.backoffMs } : {}),
          state: row.state === 'confirmed' || row.sealed === true
            ? 'confirmed'
            : row.state === 'pointer-visible'
              ? 'pointer-visible'
              : 'claimed',
        };
      }
    }
    return { messages, episodes };
  } catch {
    return { messages: {}, episodes: {} };
  }
}

function saveReconcileState(path: string, state: PersistedReconcileState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ messages: state.messages, episodes: state.episodes }) + '\n');
}

interface DeliveryMessageSubmitDeps {
  readonly readInbox?: () => OrcaJsonResponse<OrcaInboxFullResult>;
  readonly lookupMessage: (messageId: string) =>
    | { readonly ok: true; readonly message: DeliveryMessage }
    | { readonly ok: false; readonly reason: string };
  readonly resolveWorker: (message: DeliveryMessage) =>
    | { readonly ok: true; readonly worker: RuntimeWorker | null }
    | { readonly ok: false; readonly reason: string };
  readonly isMessageRetrievable?: (message: DeliveryMessage, worker: RuntimeWorker) =>
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string };
  readonly observeRetrievableMessageIds?: (worker: RuntimeWorker) =>
    | { readonly ok: true; readonly messageIds: ReadonlySet<string> }
    | { readonly ok: false; readonly reason: string };
  readonly submitDeps: UnsentComposerSubmitDeps;
  readonly pointerWriteLedger?: Map<string, number>;
  readonly reconcileClock?: () => number;
  readonly episodeStatePath?: string;
  readonly episodeLockPath?: string;
  readonly episodeState?: PersistedReconcileState;
}

export interface OrchestrationMailDeliveryEvidence {
  readonly workerGeneration: string;
  readonly runId: string;
  readonly messageId: string;
  readonly delivery: 'delivered-looking';
  readonly terminalReceipt: 'unproven';
}

export interface OrchestrationMailReconcileResult {
  readonly ok: boolean;
  readonly attempted: number;
  readonly nudged: number;
  readonly skipped: number;
  readonly reasons: readonly string[];
  readonly deliveryEvidence: readonly OrchestrationMailDeliveryEvidence[];
}

export interface UnsentComposerWatchState {
  readonly lastFingerprint: Map<string, string>;
  readonly lastChangedAt: Map<string, number>;
  readonly submittedFingerprint: Map<string, string>;
  readonly ambiguousSubmittedFingerprints: Map<string, Set<string>>;
}

export interface UnsentComposerTerminalResult {
  readonly terminal: string;
  readonly generation: string;
  readonly ok: boolean;
  readonly unsent: boolean;
  readonly enter: boolean;
  readonly reason: string;
  readonly dispatchStatus?: RuntimeDispatchResult['status'];
}

export interface UnsentComposerSubmitResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly watch: boolean;
  readonly terminals: UnsentComposerTerminalResult[];
}

export function createUnsentComposerWatchState(): UnsentComposerWatchState {
  return {
    lastFingerprint: new Map(),
    lastChangedAt: new Map(),
    submittedFingerprint: new Map(),
    ambiguousSubmittedFingerprints: new Map(),
  };
}

function clearObservation(state: UnsentComposerWatchState, key: string): void {
  state.lastFingerprint.delete(key);
  state.lastChangedAt.delete(key);
}

type ComposerReadResult = ReturnType<UnsentComposerSubmitDeps['read']>;

function currentLiveness(
  deps: UnsentComposerSubmitDeps,
  identity: RuntimeWorkerIdentity,
): RuntimeLiveness {
  // Older test-only callers have no liveness seam; production adapters always do.
  return deps.liveness?.(identity, DELIVERY_LIVENESS_WINDOW_MS) ?? 'idle';
}

function livenessDeferral(
  identity: RuntimeWorkerIdentity,
  status: RuntimeLiveness,
): UnsentComposerTerminalResult {
  return {
    terminal: identity.id,
    generation: identity.generation,
    ok: true,
    unsent: true,
    enter: false,
    reason: `worker_${status}`,
  };
}

function settleComposerObservation(
  worker: RuntimeWorker,
  input: UnsentComposerSubmitInput,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState,
  shown: ComposerReadResult,
  allowAmbiguousRetry = false,
  allowNonIdle = false,
  requireConsumption = false,
  _submitCount = 1,
 ): UnsentComposerTerminalResult {
  const identity = worker.identity;
  const key = workerKey(identity);
  const base = { terminal: identity.id, generation: identity.generation };
  if (!shown.ok) {
    return { ...base, ok: false, unsent: false, enter: false, reason: shown.reason };
  }
  const preview = shown.lines.join('\n');
  const kind = classifyCursorComposer(preview);
  if (kind === 'empty') {
    clearObservation(state, key);
    if (!state.ambiguousSubmittedFingerprints.has(key)) state.submittedFingerprint.delete(key);
    return { ...base, ok: true, unsent: false, enter: false, reason: requireConsumption ? 'pointer_consumed' : 'composer_empty' };
  }
  const fingerprint = exactOrchestrationPointerFingerprint(preview);
  if (!fingerprint) {
    clearObservation(state, key);
    return {
      ...base,
      ok: true,
      unsent: true,
      enter: false,
      reason: 'composer_not_orchestration_pointer',
    };
  }
  const ambiguous = state.ambiguousSubmittedFingerprints.get(key)?.has(fingerprint) ?? false;
  if (
    (state.submittedFingerprint.get(key) === fingerprint && !(allowAmbiguousRetry && ambiguous))
    || (ambiguous && !allowAmbiguousRetry)
  ) {
    return { ...base, ok: true, unsent: true, enter: false, reason: 'already_submitted' };
  }
  if (input.dryRun) {
    return { ...base, ok: true, unsent: true, enter: false, reason: 'dry_run' };
  }
  const beforeLiveness = currentLiveness(deps, identity);
  if (beforeLiveness !== 'idle' && !(allowNonIdle && beforeLiveness !== 'gone')) {
    return livenessDeferral(identity, beforeLiveness);
  }

  const submitted = deps.submit(identity);
  if (submitted.status === 'send_failed') {
    state.submittedFingerprint.delete(key);
    return { ...base, ok: false, unsent: true, enter: false, reason: submitted.reason, dispatchStatus: submitted.status };
  }
  if (!deps.liveness && submitted.status === 'dispatch_unknown') {
    const fingerprints = state.ambiguousSubmittedFingerprints.get(key) ?? new Set<string>();
    fingerprints.add(fingerprint);
    state.ambiguousSubmittedFingerprints.set(key, fingerprints);
    state.submittedFingerprint.set(key, fingerprint);
    return { ...base, ok: true, unsent: true, enter: false, reason: submitted.reason, dispatchStatus: submitted.status };
  }

  // Transport acceptance is not submission evidence. For delivery, the exact
  // pointer must disappear from the observable composer after Enter; a busy
  // liveness result alone is not a submission witness.
  const afterShown = deps.liveness || requireConsumption
    ? deps.read(identity)
    : { ok: true as const, lines: [], source: 'screen' as const };
  const afterLiveness = deps.liveness ? currentLiveness(deps, identity) : 'busy';
  const afterFingerprint = afterShown.ok
    ? exactOrchestrationPointerFingerprint(afterShown.lines.join('\n'))
    : undefined;
  const consumed = afterShown.ok && afterFingerprint !== fingerprint;
  const started = requireConsumption
    ? consumed
    : afterShown.ok && afterLiveness === 'busy';
  if (!started) {
    const fingerprints = state.ambiguousSubmittedFingerprints.get(key) ?? new Set<string>();
    fingerprints.add(fingerprint);
    state.ambiguousSubmittedFingerprints.set(key, fingerprints);
    state.submittedFingerprint.set(key, fingerprint);
    return {
      ...base,
      ok: false,
      unsent: true,
      enter: false,
      reason: 'submission_unconfirmed',
      dispatchStatus: submitted.status,
    };
  }

  state.submittedFingerprint.set(key, fingerprint);
  const fingerprints = state.ambiguousSubmittedFingerprints.get(key);
  fingerprints?.delete(fingerprint);
  if (fingerprints?.size === 0) state.ambiguousSubmittedFingerprints.delete(key);
  return { ...base, ok: true, unsent: true, enter: true, reason: 'enter_sent', dispatchStatus: submitted.status };
}

function submitOne(
  worker: RuntimeWorker,
  input: UnsentComposerSubmitInput,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState,
): UnsentComposerTerminalResult {
  return settleComposerObservation(worker, input, deps, state, deps.read(worker.identity));
}

async function submitOneAsync(
  worker: RuntimeWorker,
  input: UnsentComposerSubmitInput,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState,
): Promise<UnsentComposerTerminalResult> {
  const shown = deps.readAsync
    ? await deps.readAsync(worker.identity)
    : deps.read(worker.identity);
  return settleComposerObservation(worker, input, deps, state, shown);
}

export function submitUnsentCursorComposer(
  input: UnsentComposerSubmitInput = {},
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState = createUnsentComposerWatchState(),
): UnsentComposerSubmitResult {
  hydrateSubmitted(state, deps.sentStorePath);
  const dryRun = Boolean(input.dryRun);
  const watch = Boolean(input.watch);
  const listed = deps.listWorkers();
  if (!listed.ok) {
    return {
      ok: false,
      dryRun,
      watch,
      terminals: [{
        terminal: '',
        generation: '',
        ok: false,
        unsent: false,
        enter: false,
        reason: listed.reason,
      }],
    };
  }
  const requested = (input.terminals ?? []).map((handle) => handle.trim()).filter(Boolean);
  const workers = requested.length === 0
    ? listed.workers
    : listed.workers.filter((worker) => requested.includes(worker.identity.id));
  const terminals = workers.map((worker) => submitOne(worker, { ...input, watch }, deps, state));
  persistSubmitted(state, deps.sentStorePath);
  return {
    ok: terminals.every((row) => row.ok),
    dryRun,
    watch,
    terminals,
  };
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, milliseconds));
}

export function submitUnsentCursorComposerOnce(
  input: UnsentComposerSubmitInput = {},
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState = createUnsentComposerWatchState(),
): UnsentComposerSubmitResult {
  const result = submitUnsentCursorComposer({ ...input, watch: true }, deps, state);
  return { ...result, watch: false };
}

function sleepAsync(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}


export function buildDeliveryPointer(message: DeliveryMessage): string {
  const check = message.recipient.startsWith('dispatch:')
    ? 'orca orchestration check'
    : message.recipient.startsWith('run:')
      ? `orca orchestration check --run ${message.runId}`
      : message.recipient.startsWith('term_')
        ? `orca orchestration check --terminal ${message.recipient}`
        : `orca orchestration check --run ${message.runId}`;
  const prose = message.recipient.startsWith('run:')
    ? 'Read orchestration mail, check the fleet, and clear blockers so the fleet does not idle.'
    : 'Read and act on your orchestration message.';
  return `You have 1 orchestration message. ${prose} Run \`${check}\`.`;
}

function pointerMatchesDelivery(
  pointer: string,
  message: DeliveryMessage,
  worker: RuntimeWorker,
 ): boolean {
  if (pointer === 'orca orchestration check') return message.recipient.startsWith('dispatch:');
  const runId = pointer.match(/^orca orchestration check --run (\S+)$/u)?.[1];
  if (runId) return runId === message.runId;
  const terminal = pointer.match(/^orca orchestration check --terminal (\S+)$/u)?.[1];
  return terminal === worker.identity.id;
}

/** Immediate delivery-scoped observation plus one bounded render-race retry. */
export async function submitUnsentCursorComposerOnceForWorker(
  worker: RuntimeWorker,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState = createUnsentComposerWatchState(),
  allowNonIdle = false,
  requireConsumption = false,
 ): Promise<UnsentComposerSubmitResult> {
  let shown = deps.readAsync
    ? await deps.readAsync(worker.identity)
    : deps.read(worker.identity);
  if (shown.ok && classifyCursorComposer(shown.lines.join('\n')) === 'empty') {
    await (deps.sleepAsync ?? sleepAsync)(DELIVERY_RENDER_GRACE_MS);
    shown = deps.readAsync
      ? await deps.readAsync(worker.identity)
      : deps.read(worker.identity);
  }
  const terminal = settleComposerObservation(
    worker,
    { watch: true },
    deps,
    state,
    shown,
    true,
    allowNonIdle,
    requireConsumption,
  );
  return {
    ok: terminal.ok,
    dryRun: false,
    watch: false,
    terminals: [terminal],
  };
}

/** Resolve one live terminal identity, then apply the bounded delivery reaction. */
export async function submitUnsentCursorComposerDeliveryForTerminal(
  terminal: string,
  resolver: DeliveryTerminalSubmitResolver,
  deps: UnsentComposerSubmitDeps,
): Promise<UnsentComposerSubmitResult> {
  const handle = terminal.trim();
  if (!handle) {
    return {
      ok: false,
      dryRun: false,
      watch: false,
      terminals: [{
        terminal: '',
        generation: '',
        ok: false,
        unsent: false,
        enter: false,
        reason: 'runtime_worker_id_missing',
      }],
    };
  }
  const resolved = resolver.findWorkerById(handle);
  if (resolved.status !== 'ok') {
    return {
      ok: false,
      dryRun: false,
      watch: false,
      terminals: [{
        terminal: handle,
        generation: '',
        ok: false,
        unsent: false,
        enter: false,
        reason: resolved.reason,
      }],
    };
  }
  if (resolved.value === null) {
    return {
      ok: true,
      dryRun: false,
      watch: false,
      terminals: [{
        terminal: handle,
        generation: '',
        ok: true,
        unsent: false,
        enter: false,
        reason: 'worker_gone',
      }],
    };
  }
  return submitUnsentCursorComposerOnceForWorker(resolved.value, deps);
}

function deliveryNoEffect(
  reason: string,
  worker?: RuntimeWorker,
  ok = true,
): UnsentComposerSubmitResult {
  return {
    ok,
    dryRun: false,
    watch: false,
    terminals: [{
      terminal: worker?.identity.id ?? '',
      generation: worker?.identity.generation ?? '',
      ok,
      unsent: false,
      enter: false,
      reason,
    }],
  };
}

function deliveryMessageFromInboxRow(row: OrcaInboxMessageRow):
  | { readonly ok: true; readonly message: DeliveryMessage }
  | { readonly ok: false; readonly reason: string } {
  const id = row.id?.trim() ?? '';
  const runId = row.run_id?.trim() ?? '';
  const recipient = row.to_handle?.trim() ?? '';
  if (!id || !runId || !recipient) return { ok: false, reason: 'orchestration_message_binding_incomplete' };
  return {
    ok: true,
    message: {
      id,
      runId,
      recipient,
      consumed: row.read === 1 || row.read === true,
    },
  };
}

function episodeStateRank(state: EpisodeRecord['state']): number {
  return state === 'confirmed' ? 3 : state === 'pointer-visible' ? 2 : 1;
}

function migrateLegacyEpisodeKeys(
  state: PersistedReconcileState,
  unreadEpisodeKeysByMessage: ReadonlyMap<string, string>,
 ): void {
  for (const [messageId, currentKey] of unreadEpisodeKeysByMessage) {
    const legacy = Object.entries(state.episodes).find(([candidateKey, candidate]) =>
      candidateKey !== currentKey && candidate.messageId === messageId);
    if (!legacy) continue;
    const current = state.episodes[currentKey];
    if (!current || episodeStateRank(legacy[1].state) > episodeStateRank(current.state)) {
      state.episodes[currentKey] = legacy[1];
    }
    delete state.episodes[legacy[0]];
  }
}

function releaseClaimsForConsumedMessages(
  state: PersistedReconcileState,
  unreadMessageIds: ReadonlySet<string>,
  unreadEpisodeKeys: ReadonlySet<string>,
): void {
  for (const [key, episode] of Object.entries(state.episodes)) {
    if (unreadEpisodeKeys.has(key) && !unreadMessageIds.has(episode.messageId)) {
      delete state.episodes[key];
    }
  }
}

function releaseEpisodeWhenMailboxEmpty(
  state: PersistedReconcileState,
  deps: DeliveryMessageSubmitDeps,
  message: DeliveryMessage,
): void {
  const response = deps.readInbox?.();
  if (!response?.ok) return;
  const resolved = deps.resolveWorker(message);
  if (!resolved.ok || !resolved.worker) return;
  const mailboxKey = episodeKey(message, resolved.worker);
  const hasUnreadSibling = (response.result?.messages ?? []).some((row) => {
    if (row.read === 1 || row.read === true) return false;
    const parsed = deliveryMessageFromInboxRow(row);
    if (!parsed.ok) return false;
    const sibling = deps.resolveWorker(parsed.message);
    return sibling.ok
      && sibling.worker !== null
      && episodeKey(parsed.message, sibling.worker) === mailboxKey;
  });
  if (!hasUnreadSibling) {
    for (const [key, episode] of Object.entries(state.episodes)) {
      if (key === mailboxKey || episode.messageId === message.id) delete state.episodes[key];
    }
  }
}

/** Bind one Orca message to one exact recipient, then submit its visible pointer. */
export async function submitOrcaMessageDeliveryPointer(
  messageId: string,
  deps: DeliveryMessageSubmitDeps,
  options: DeliveryPointerSubmitOptions = {},
): Promise<UnsentComposerSubmitResult> {
  const id = messageId.trim();
  if (!id) return deliveryNoEffect('orchestration_message_id_missing', undefined, false);
  const statePath = options.reconcileLedgerPath ?? deps.episodeStatePath;
  const lockPath = options.reconcileLockPath ?? deps.episodeLockPath;
  if (!statePath) {
    const found = deps.lookupMessage(id);
    if (!found.ok) return deliveryNoEffect(found.reason, undefined, false);
    const result = await submitOrcaMessageDeliveryPointerForMessage(found.message, deps);
    if (found.message.consumed && deps.episodeState) releaseEpisodeWhenMailboxEmpty(deps.episodeState, deps, found.message);
    return result;
  }
  const held = tryAcquireHeldFileLock(lockPath ?? ORCHESTRATION_RECONCILE_LOCK_PATH);
  if (!held.acquired) return deliveryNoEffect(`reconcile_lock_${held.reason}`, undefined, false);
  replaceLockedFileContents(held.descriptor, `${process.pid}\n`);
  try {
    const current = options.now?.() ?? deps.reconcileClock?.() ?? Date.now();
    const state = loadReconcileState(statePath);
    const found = deps.lookupMessage(id);
    if (!found.ok) return deliveryNoEffect(found.reason, undefined, false);
    let result: UnsentComposerSubmitResult;
    if (found.message.consumed) {
      result = deliveryNoEffect('delivery_already_consumed');
    } else {
      const resolved = deps.resolveWorker(found.message);
      if (!resolved.ok) {
        result = deliveryNoEffect(resolved.reason, undefined, false);
      } else if (!resolved.worker) {
        result = deliveryNoEffect('worker_gone');
      } else {
        let eligible = true;
        let eligibilityReason = 'orchestration_message_unretrievable';
        if (deps.isMessageRetrievable) {
          const observed = deps.isMessageRetrievable(found.message, resolved.worker);
          eligible = observed.ok;
          if (!observed.ok) eligibilityReason = observed.reason;
        } else if (deps.observeRetrievableMessageIds) {
          const observed = deps.observeRetrievableMessageIds(resolved.worker);
          eligible = observed.ok && observed.messageIds.has(found.message.id);
          if (!observed.ok) eligibilityReason = observed.reason;
        }
        result = !eligible
          ? deliveryNoEffect(eligibilityReason, resolved.worker, false)
          : await submitOrcaMessageDeliveryPointerForMessage(found.message, {
            ...deps,
            resolveWorker: () => resolved,
            reconcileClock: options.now ?? deps.reconcileClock ?? (() => current),
            episodeStatePath: statePath,
            episodeLockPath: lockPath,
            episodeState: state,
          });
      }
    }
    state.messages[id] = current;
    if (found.message.consumed || result.terminals[0]?.reason === 'worker_gone' || result.terminals[0]?.reason?.includes('unretrievable') || result.terminals[0]?.reason === 'orchestration_message_unretrievable') {
      releaseEpisodeWhenMailboxEmpty(state, deps, found.message);
    }
    saveReconcileState(statePath, state);
    return result;
  } finally {
    releaseHeldFileLock(held.descriptor);
  }
}
async function submitOrcaMessageDeliveryPointerForMessage(
  message: DeliveryMessage,
  deps: DeliveryMessageSubmitDeps,
): Promise<UnsentComposerSubmitResult> {
  if (message.consumed) return deliveryNoEffect('delivery_already_consumed');
  const resolved = deps.resolveWorker(message);
  if (!resolved.ok) return deliveryNoEffect(resolved.reason, undefined, false);
  if (resolved.worker === null) return deliveryNoEffect('worker_gone');
  const worker = resolved.worker;
  if (!worker.identity.runtime || !worker.identity.id.trim() || !worker.identity.generation.trim()) {
    return deliveryNoEffect('orchestration_worker_identity_incomplete', worker, false);
  }
  const pointer = buildDeliveryPointer(message);
  const key = episodeKey(message, worker);
  const stableKey = worker.stableKey?.trim();
  const pointerKey = pointerLedgerKey(message, worker);
  if (deps.pointerWriteLedger?.has(pointerKey)) return deliveryNoEffect('orchestration_episode_already_claimed', worker, false);
  const now = deps.reconcileClock?.() ?? Date.now();
  let state = deps.episodeState;
  if (!state && deps.episodeStatePath) state = loadReconcileState(deps.episodeStatePath);
  let existing = state?.episodes[key];
  // Migrate any pre-message-key claim for the same message without sharing it with siblings.
  if (!existing && state) {
    const legacy = Object.entries(state.episodes).find(([candidate, row]) =>
      candidate !== key && row.messageId === message.id);
    if (legacy) {
      existing = {
        ...legacy[1],
        workerKey: workerKey(worker.identity),
        ...(stableKey ? { stableKey } : {}),
      };
      state.episodes[key] = existing;
      delete state.episodes[legacy[0]];
    }
  }

  const control = deps.submitDeps.composerControl?.(worker.identity);

  if (control?.kind === 'opencode-http') {
    const liveness = currentLiveness(deps.submitDeps, worker.identity);
    if (liveness !== 'idle') return deliveryNoEffect(`worker_${liveness}`, worker);

    if (existing?.state === 'confirmed') return deliveryNoEffect('orchestration_episode_already_delivered', worker, false);
    if (existing && now < existing.nextEligibleAt) return deliveryNoEffect('orchestration_episode_backoff', worker, false);
    const priorBackoff = existing?.backoffMs ?? ORCHESTRATION_RECONCILE_WINDOW_MS;
    const nextBackoff = Math.min(priorBackoff * 2, ORCHESTRATION_RECONCILE_MAX_BACKOFF_MS);
    if (existing) {
      const observedLiveness = currentLiveness(deps.submitDeps, worker.identity);
      if (observedLiveness !== 'idle' && observedLiveness !== 'busy') {
        return deliveryNoEffect(`worker_${observedLiveness}`, worker);
      }
      const base = { terminal: worker.identity.id, generation: worker.identity.generation };
      if (observedLiveness === 'busy') {
        if (state) {
          state.episodes[key] = { ...existing, state: 'confirmed' };
          if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
        }
        return { ok: true, dryRun: false, watch: false, terminals: [{ ...base, unsent: true, enter: true, ok: true, reason: 'enter_sent' }] };
      }
      if (state) {
        state.episodes[key] = { ...existing, state: 'pointer-visible', nextEligibleAt: now + nextBackoff, backoffMs: nextBackoff };
        if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
      }
      return { ok: false, dryRun: false, watch: false, terminals: [{ ...base, unsent: true, enter: false, ok: false, reason: 'submission_unconfirmed' }] };
    }
    if (state && !existing) {
      state.episodes[key] = {
        messageId: message.id,
        runId: message.runId,
        recipient: message.recipient,
        workerKey: workerKey(worker.identity),
        ...(stableKey ? { stableKey } : {}),
        nextEligibleAt: now + priorBackoff,
        backoffMs: nextBackoff,
        state: 'claimed',
      };
      if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
    }
    if (deps.pointerWriteLedger) deps.pointerWriteLedger.set(pointerKey, now);
    const createdClaim = !existing;
    const before = deps.submitDeps.readAsync
      ? await deps.submitDeps.readAsync(worker.identity)
      : deps.submitDeps.read(worker.identity);
    if (!before.ok) {
      if (state && createdClaim) {
        delete state.episodes[key];
        if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
      }
      deps.pointerWriteLedger?.delete(pointerKey);
      return deliveryNoEffect(before.reason, worker, false);
    }
    const submitted = control.dispatch({ worker: worker.identity, action: 'submit-prompt', text: pointer });
    if (submitted.status === 'send_failed') {
      if (state && createdClaim) {
        delete state.episodes[key];
        if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
      }
      deps.pointerWriteLedger?.delete(pointerKey);
      return { ok: false, dryRun: false, watch: false, terminals: [{ terminal: worker.identity.id, generation: worker.identity.generation, unsent: true, enter: false, ok: false, reason: submitted.reason, dispatchStatus: submitted.status }] };
    }
    const base = { terminal: worker.identity.id, generation: worker.identity.generation };
    if (state) state.episodes[key] = { ...state.episodes[key]!, state: 'pointer-visible' };
    if (submitted.status === 'dispatch_unknown') {
      if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state!);
      return { ok: false, dryRun: false, watch: false, terminals: [{ ...base, unsent: true, enter: false, ok: false, reason: 'submission_unconfirmed', dispatchStatus: submitted.status }] };
    }
    // Transport acceptance is not submission evidence. Re-read the pane and
    // require the observed idle-to-busy transition before recording confirmation.
    const afterShown = deps.submitDeps.liveness
      ? deps.submitDeps.read(worker.identity)
      : { ok: true as const, lines: [], source: 'screen' as const };
    const afterLiveness = deps.submitDeps.liveness
      ? currentLiveness(deps.submitDeps, worker.identity)
      : 'busy';
    if (!(afterShown.ok && afterLiveness === 'busy')) {
      if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state!);
      return { ok: false, dryRun: false, watch: false, terminals: [{ ...base, unsent: true, enter: false, ok: false, reason: 'submission_unconfirmed', dispatchStatus: submitted.status }] };
    }
    const after = deps.submitDeps.readAsync
      ? await deps.submitDeps.readAsync(worker.identity)
      : deps.submitDeps.read(worker.identity);
    if (!after.ok || after.lines.join('\n') === before.lines.join('\n')) {
      return { ok: true, dryRun: false, watch: false, terminals: [{ ...base, unsent: true, enter: false, ok: true, reason: 'opencode_panel_visibility_unconfirmed', dispatchStatus: 'dispatch_unknown' }] };
    }
    if (state) {
      state.episodes[key] = { ...state.episodes[key]!, state: 'confirmed' };
      if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
    }
    return { ok: true, dryRun: false, watch: false, terminals: [{ ...base, unsent: true, enter: true, ok: true, reason: 'enter_sent', dispatchStatus: submitted.status }] };
  }

  const shown = deps.submitDeps.readAsync
    ? await deps.submitDeps.readAsync(worker.identity)
    : deps.submitDeps.read(worker.identity);
  if (!shown.ok) return deliveryNoEffect(shown.reason, worker, false);
  const composerKind = classifyCursorComposer(shown.lines.join('\n'));
  const observedPointer = exactOrchestrationPointerFingerprint(shown.lines.join('\n'));
  const alreadyShown = composerKind !== 'empty' && observedPointer !== undefined;
  if (alreadyShown && !pointerMatchesDelivery(observedPointer, message, worker)) {
    return deliveryNoEffect('orchestration_pointer_target_mismatch', worker);
  }
  const contradicted = existing?.state === 'confirmed' && alreadyShown && now >= existing.nextEligibleAt;
  if (contradicted) {
    const liveness = currentLiveness(deps.submitDeps, worker.identity);
    if (liveness === 'gone') return deliveryNoEffect(`worker_${liveness}`, worker);
  }
  if (contradicted && state) {
    existing = { ...existing!, state: 'pointer-visible', nextEligibleAt: now };
    state.episodes[key] = existing;
  }
  if (existing?.state === 'confirmed' && !contradicted) {
    return deliveryNoEffect('orchestration_episode_already_delivered', worker, false);
  }
  const priorBackoff = existing?.backoffMs ?? ORCHESTRATION_RECONCILE_WINDOW_MS;
  const nextBackoff = Math.min(priorBackoff * 2, ORCHESTRATION_RECONCILE_MAX_BACKOFF_MS);
  if (existing && now < existing.nextEligibleAt) {
    return deliveryNoEffect('orchestration_episode_backoff', worker, false);
  }
  if (composerKind === 'empty' && !alreadyShown && !existing) {
    return deliveryNoEffect('pointer_absent_orca_did_not_notify', worker);
  }
  if (!alreadyShown && !(existing && composerKind === 'empty')) {
    return deliveryNoEffect('composer_not_orchestration_pointer', worker);
  }

  const claimExists = Boolean(existing);
  if (!alreadyShown && !claimExists) {
    const liveness = currentLiveness(deps.submitDeps, worker.identity);
    if (liveness === 'gone') return deliveryNoEffect(`worker_${liveness}`, worker);
  }
  if (state && !existing) {
    state.episodes[key] = {
      messageId: message.id,
      runId: message.runId,
      recipient: message.recipient,
      workerKey: workerKey(worker.identity),
      ...(stableKey ? { stableKey } : {}),
      nextEligibleAt: now + priorBackoff,
      backoffMs: nextBackoff,
      state: alreadyShown ? 'pointer-visible' : 'claimed',
    };
    if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
  }
  if (state) {
    state.episodes[key] = { ...state.episodes[key]!, state: 'pointer-visible' };
  }
  let result: UnsentComposerSubmitResult;
  if (claimExists && !alreadyShown && composerKind === 'empty') {
    // A missing pointer after a prior claim is the consumption witness; do not re-Enter.
    const liveness = currentLiveness(deps.submitDeps, worker.identity);
    if (liveness === 'gone') return deliveryNoEffect(`worker_${liveness}`, worker);
    if (state) {
      state.episodes[key] = {
        ...existing!,
        state: 'confirmed',
        nextEligibleAt: now + ORCHESTRATION_RECONCILE_WINDOW_MS,
      };
      if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
    }
    const base = { terminal: worker.identity.id, generation: worker.identity.generation };
    result = { ok: true, dryRun: false, watch: false, terminals: [{ ...base, unsent: true, enter: false, ok: true, reason: 'pointer_consumed' }] };
  } else {
    result = await submitUnsentCursorComposerOnceForWorker(
      worker,
      deps.submitDeps,
      createUnsentComposerWatchState(),
      true,
      true,
    );
  }
  const terminal = result.terminals[0];
  if (state && (terminal?.reason === 'enter_sent' || terminal?.reason === 'pointer_consumed')) {
    state.episodes[key] = {
      ...state.episodes[key]!,
      state: 'confirmed',
      nextEligibleAt: now + ORCHESTRATION_RECONCILE_WINDOW_MS,
    };
  } else if (state && terminal?.reason === 'submission_unconfirmed') {
    state.episodes[key] = { ...state.episodes[key]!, state: 'pointer-visible', nextEligibleAt: now + priorBackoff, backoffMs: nextBackoff };
  } else if (state && terminal?.dispatchStatus === 'send_failed') {
    const { backoffMs: _backoffMs, ...episodeWithoutBackoff } = state.episodes[key]!;
    state.episodes[key] = { ...episodeWithoutBackoff, state: 'pointer-visible', nextEligibleAt: now };
  }
  if (state && deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
  return result;
}

function deliveryLookingEvidence(
  message: DeliveryMessage,
  worker: RuntimeWorker,
  result: UnsentComposerSubmitResult,
): OrchestrationMailDeliveryEvidence | undefined {
  const messageId = message.id.trim();
  const runId = message.runId.trim();
  const workerGeneration = worker.identity.generation.trim();
  const terminal = result.terminals.length === 1 ? result.terminals[0] : undefined;
  if (
    !messageId || !runId || !workerGeneration || !terminal?.enter
    || terminal.terminal !== worker.identity.id
    || terminal.generation !== worker.identity.generation
  ) return undefined;
  return {
    workerGeneration,
    runId,
    messageId,
    delivery: 'delivered-looking',
    terminalReceipt: 'unproven',
  };
}

export function createOrcaMessageSubmitDeps(
  adapter: RuntimeAdapter,
  submitDeps = createAdapterSubmitDeps(adapter),
): DeliveryMessageSubmitDeps {
  const readInbox = () => runOrcaJson<OrcaInboxFullResult>(
    ['orchestration', 'inbox', '--full', '--limit', String(ORCHESTRATION_INBOX_LIMIT)],
    { timeoutMs: RECONCILE_COMMAND_TIMEOUT_MS },
  );
  const resolveWorker: DeliveryMessageSubmitDeps['resolveWorker'] = (message) => {
      if (message.recipient.startsWith('dispatch:')) {
        if (!adapter.resolveAssignmentWorker) return { ok: false, reason: 'runtime_assignment_resolution_unsupported' };
        const bindingKey = message.recipient.slice('dispatch:'.length).trim();
        const resolved = adapter.resolveAssignmentWorker({ provider: 'orca', bindingKey });
        if (resolved.status !== 'ok') return { ok: false, reason: resolved.reason };
        return resolved.value.kind === 'resolved'
          ? { ok: true, worker: resolved.value.worker }
          : { ok: true, worker: null };
      }
      let handle = message.recipient;
      if (message.recipient.startsWith('run:')) {
        const runId = message.recipient.slice('run:'.length).trim();
        if (runId !== message.runId) return { ok: false, reason: 'orchestration_message_run_mismatch' };
        const response = runOrcaJson<OrcaRunShowResult>(['orchestration', 'run-show', '--id', runId], { timeoutMs: RECONCILE_COMMAND_TIMEOUT_MS });
        if (!response.ok) return { ok: false, reason: response.error?.code ?? 'orchestration_run_unavailable' };
        if (response.result?.run?.id?.trim() !== runId) return { ok: false, reason: 'orchestration_run_binding_mismatch' };
        const paneKey = response.result?.run?.coordinator_pane_key?.trim() ?? '';
        if (paneKey) {
          if (!adapter.findWorkerByPaneKey) return { ok: false, reason: 'runtime_pane_key_resolution_unsupported' };
          const resolved = adapter.findWorkerByPaneKey(paneKey);
          if (resolved.status !== 'ok') return { ok: false, reason: resolved.reason };
          return { ok: true, worker: resolved.value };
        }
        handle = response.result?.run?.coordinator_handle?.trim() ?? '';
      }
      if (!handle.startsWith('term_')) return { ok: false, reason: 'orchestration_recipient_unresolved' };
      const resolved = adapter.findWorkerById(handle);
      if (resolved.status !== 'ok') return { ok: false, reason: resolved.reason };
      return { ok: true, worker: resolved.value };
  };
  return {
    readInbox,
    lookupMessage: (messageId) => {
      const response = readInbox();
      if (!response.ok) return { ok: false, reason: response.error?.code ?? 'orchestration_inbox_unavailable' };
      const matches = (response.result?.messages ?? []).filter((message) => message.id?.trim() === messageId);
      if (matches.length !== 1) {
        return { ok: false, reason: matches.length === 0 ? 'orchestration_message_missing' : 'orchestration_message_ambiguous' };
      }
      const row = matches[0];
      const runId = row?.run_id?.trim() ?? '';
      const recipient = row?.to_handle?.trim() ?? '';
      if (!runId || !recipient) return { ok: false, reason: 'orchestration_message_binding_incomplete' };
      const message: DeliveryMessage = {
        id: messageId,
        runId,
        recipient,
        consumed: row?.read === 1 || row?.read === true,
      };
      const resolved = resolveWorker(message);
      return { ok: true, message };
    },
    resolveWorker,
    observeRetrievableMessageIds: (worker) => {
      const response = runOrcaJson<OrcaInboxFullResult>([
        'orchestration', 'check', '--terminal', worker.identity.id, '--peek',
      ], { timeoutMs: RECONCILE_COMMAND_TIMEOUT_MS });
      if (!response.ok) return { ok: false, reason: response.error?.code ?? 'orchestration_check_unavailable' };
      return { ok: true, messageIds: new Set((response.result?.messages ?? []).flatMap((row) => {
        const id = row.id?.trim();
        return id ? [id] : [];
      })) };
    },
    isMessageRetrievable: (message, worker) => {
      const checkArgs = message.recipient.startsWith('run:')
        ? ['orchestration', 'check', '--run', message.runId, '--peek']
        : ['orchestration', 'check', '--terminal', worker.identity.id, '--peek'];
      const observed = runOrcaJson<OrcaInboxFullResult>(checkArgs, { timeoutMs: RECONCILE_COMMAND_TIMEOUT_MS });
      if (!observed.ok) return { ok: false, reason: observed.error?.code ?? 'orchestration_check_unavailable' };
      return (observed.result?.messages ?? []).some((row) => row.id?.trim() === message.id)
        ? { ok: true }
        : { ok: false, reason: 'orchestration_message_unretrievable' };
    },
    submitDeps,
    episodeStatePath: ORCHESTRATION_RECONCILE_LEDGER_PATH,
    episodeLockPath: ORCHESTRATION_RECONCILE_LOCK_PATH,
  };
}


/** Reconcile unread Orca mail without inspecting composer screens globally. */
export async function runOrchestrationMailReconcileTick(
  deps: DeliveryMessageSubmitDeps,
  options: { readonly ledgerPath?: string; readonly lockPath?: string; readonly now?: () => number } = {},
): Promise<OrchestrationMailReconcileResult> {
  const ledgerPath = options.ledgerPath ?? deps.episodeStatePath ?? ORCHESTRATION_RECONCILE_LEDGER_PATH;
  const lockPath = options.lockPath ?? deps.episodeLockPath ?? ORCHESTRATION_RECONCILE_LOCK_PATH;
  const held = tryAcquireHeldFileLock(lockPath);
  if (!held.acquired) return { ok: false, attempted: 0, nudged: 0, skipped: 0, reasons: [`reconcile_lock_${held.reason}`], deliveryEvidence: [] };
  replaceLockedFileContents(held.descriptor, `${process.pid}\n`);
  try {
    const now = options.now ?? Date.now;
    const current = now();
    const state = loadReconcileState(ledgerPath);
    const response = deps.readInbox
      ? deps.readInbox()
      : runOrcaJson<OrcaInboxFullResult>(
        ['orchestration', 'inbox', '--full', '--limit', String(ORCHESTRATION_INBOX_LIMIT)],
        { timeoutMs: RECONCILE_COMMAND_TIMEOUT_MS },
      );
    if (!response.ok) return { ok: false, attempted: 0, nudged: 0, skipped: 0, reasons: [response.error?.code ?? 'orchestration_inbox_unavailable'], deliveryEvidence: [] };
    const unread = (response.result?.messages ?? []).filter((row) => {
      const id = row.id?.trim() ?? '';
      return id && !(row.read === 1 || row.read === true);
    });
    const unreadIds = new Set(unread.map((row) => row.id!.trim()));
    for (const id of Object.keys(state.messages)) {
      if (!unreadIds.has(id) || current - state.messages[id]! >= ORCHESTRATION_RECONCILE_WINDOW_MS) delete state.messages[id];
    }

    const rowsById = new Map<string, OrcaInboxMessageRow[]>();
    for (const row of unread) {
      const id = row.id!.trim();
      const rows = rowsById.get(id) ?? [];
      rows.push(row);
      rowsById.set(id, rows);
    }
    type Resolution = ReturnType<DeliveryMessageSubmitDeps['resolveWorker']>;
    const resolutions = new Map<string, Resolution>();
    const retrievable = new Map<string, ReturnType<NonNullable<DeliveryMessageSubmitDeps['isMessageRetrievable']>> | { readonly ok: true; readonly messageIds: ReadonlySet<string> } | { readonly ok: false; readonly reason: string }>();
    const resolveWorker = (message: DeliveryMessage): Resolution => {
      const cacheKey = message.recipient + '\u0000' + message.runId;
      const cached = resolutions.get(cacheKey);
      if (cached) return cached;
      const resolved = deps.resolveWorker(message);
      resolutions.set(cacheKey, resolved);
      return resolved;
    };
    const unreadEpisodeKeys = new Set<string>();
    const unreadEpisodeKeysByMessage = new Map<string, string>();
    let unresolvedUnread = false;
    for (const row of unread) {
      const parsed = deliveryMessageFromInboxRow(row);
      if (!parsed.ok) {
        unresolvedUnread = true;
        continue;
      }
      const resolved = resolveWorker(parsed.message);
      if (!resolved.ok || !resolved.worker) {
        unresolvedUnread = true;
        continue;
      }
      const key = episodeKey(parsed.message, resolved.worker);
      unreadEpisodeKeys.add(key);
      unreadEpisodeKeysByMessage.set(parsed.message.id, key);
    }
    if (!unresolvedUnread) {
      migrateLegacyEpisodeKeys(state, unreadEpisodeKeysByMessage);
      releaseClaimsForConsumedMessages(state, unreadIds, unreadEpisodeKeys);
      for (const key of Object.keys(state.episodes)) {
        if (!unreadEpisodeKeys.has(key)) delete state.episodes[key];
      }
    }
    const reconcileDeps: DeliveryMessageSubmitDeps = {
      ...deps,
      resolveWorker,
      episodeStatePath: ledgerPath,
      episodeLockPath: lockPath,
      episodeState: state,
      pointerWriteLedger: new Map<string, number>(),
      reconcileClock: () => current,
    };
    const reasons: string[] = [];
    const deliveryEvidence: OrchestrationMailDeliveryEvidence[] = [];
    let attempted = 0; let nudged = 0; let skipped = 0;
    for (const row of unread) {
      const id = row.id!.trim();
      attempted += 1;
      const rows = rowsById.get(id) ?? [];
      const found = rows.length === 1
        ? deliveryMessageFromInboxRow(rows[0]!)
        : { ok: false as const, reason: 'orchestration_message_ambiguous' };
      let result: UnsentComposerSubmitResult;
      if (!found.ok) {
        result = deliveryNoEffect(found.reason, undefined, false);
      } else {
        const resolved = resolveWorker(found.message);
        if (!resolved.ok) {
          result = deliveryNoEffect(resolved.reason, undefined, false);
        } else if (!resolved.worker) {
          result = deliveryNoEffect('worker_gone', undefined, false);
        } else {
          const worker = resolved.worker;
          const message = found.message;
          const cacheKey = workerKey(worker.identity) + '\u0000' + message.runId;
          const runRecipient = message.recipient.startsWith('run:');
          let observed = retrievable.get(cacheKey);
          if (!observed) {
            observed = runRecipient
              ? deps.isMessageRetrievable
                ? deps.isMessageRetrievable(found.message, worker)
                : { ok: false as const, reason: 'orchestration_retrievability_unavailable' }
              : deps.observeRetrievableMessageIds
                ? deps.observeRetrievableMessageIds(worker)
                : deps.isMessageRetrievable
                  ? deps.isMessageRetrievable(found.message, worker)
                  : { ok: false as const, reason: 'orchestration_retrievability_unavailable' };
            retrievable.set(cacheKey, observed);
          }
          const qualifies = observed !== undefined && ('messageIds' in observed
            ? observed.ok && observed.messageIds.has(message.id)
            : observed.ok);
          if (!qualifies) {
            const reason = observed && !observed.ok ? observed.reason : 'orchestration_message_unretrievable';
            result = deliveryNoEffect(reason, worker, false);
          } else {
            result = await submitOrcaMessageDeliveryPointerForMessage(message, reconcileDeps);
            const evidence = deliveryLookingEvidence(message, worker, result);
            if (evidence) deliveryEvidence.push(evidence);
          }
        }
      }
      if (result.terminals[0]?.reason === 'orchestration_episode_backoff'
        || result.terminals[0]?.reason === 'orchestration_episode_already_claimed'
        || result.terminals[0]?.reason === 'orchestration_episode_already_delivered') skipped += 1;
      if (result.terminals[0]?.enter || result.terminals[0]?.reason === 'dispatch_unknown' || result.terminals[0]?.reason === 'send_failed') nudged += 1;
      state.messages[id] = current;
      if (result.terminals[0]?.reason) reasons.push(`${id}:${result.terminals[0].reason}`);
    }
    saveReconcileState(ledgerPath, state);
    return { ok: reasons.every((reason) => !/:send_failed$|:dispatch_unknown$|:submission_unconfirmed$/u.test(reason)), attempted, nudged, skipped, reasons, deliveryEvidence };
  } finally {
    releaseHeldFileLock(held.descriptor);
  }
}
let heldLockFd: number | undefined;

export function acquireWatchLock(lockPath = WATCH_LOCK_PATH): void {
  const held = tryAcquireHeldFileLock(lockPath);
  if (!held.acquired) {
    throw new Error(held.reason === 'busy' ? 'already running' : `lock ${held.reason}`);
  }
  heldLockFd = held.descriptor;
  replaceLockedFileContents(held.descriptor, `${process.pid}\n`);
}

export function releaseWatchLock(): void {
  if (heldLockFd === undefined) return;
  try {
    releaseHeldFileLock(heldLockFd);
  } catch {
    /* lock already released */
  }
  heldLockFd = undefined;
}

function installLockRelease(): void {
  const release = (): void => {
    releaseWatchLock();
  };
  process.on('exit', release);
  process.on('SIGINT', () => {
    release();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(143);
  });
}

export function createAdapterSubmitDeps(
  adapter: RuntimeAdapter,
  listWorkspaces: () => OrcaJsonResponse<unknown> = () => runOrcaJson(['worktree', 'list']),
): UnsentComposerSubmitDeps {
  return {
    listWorkersAsync: async () => {
      if (!adapter.listWorkersAsync) return { ok: false, reason: 'runtime_async_list_unsupported' };
      const listed = await adapter.listWorkersAsync();
      if (listed.status !== 'ok') return { ok: false, reason: listed.reason };
      const workers: RuntimeWorker[] = [];
      const seen = new Set<string>();
      for (const worker of listed.value) {
        const key = workerKey(worker.identity);
        if (seen.has(key)) continue;
        seen.add(key);
        workers.push(worker);
      }
      return { ok: true, workers };
    },
    listWorkers: () => {
      const selectors = workspaceSelectorsFromList(listWorkspaces());
      const workers: RuntimeWorker[] = [];
      const seen = new Set<string>();
      for (const workspace of selectors) {
        const listed = adapter.listWorkers({ workspace });
        if (listed.status !== 'ok') {
          return { ok: false, reason: listed.reason };
        }
        for (const worker of listed.value) {
          const key = workerKey(worker.identity);
          if (seen.has(key)) continue;
          seen.add(key);
          workers.push(worker);
        }
      }
      return { ok: true, workers };
    },
    readAsync: async (worker) => {
      if (!adapter.readBoundedOutputAsync) return { ok: false, reason: 'runtime_async_read_unsupported' };
      const output = await adapter.readBoundedOutputAsync({ worker, screen: true });
      if (output.status !== 'ok') return { ok: false, reason: output.reason };
      if (output.value.source !== 'screen') {
        return { ok: false, reason: 'runtime_output_source_unobservable' };
      }
      return { ok: true, lines: output.value.lines, source: 'screen' };
    },
    read: (worker) => {
      const output = adapter.readBoundedOutput({ worker, screen: true });
      if (output.status !== 'ok') return { ok: false, reason: output.reason };
      if (output.value.source !== 'screen') {
        return { ok: false, reason: 'runtime_output_source_unobservable' };
      }
      return { ok: true, lines: output.value.lines, source: 'screen' };
    },
    submit: (worker) => adapter.dispatchInput({ worker, submitOnly: true }),
    composerControl: (worker) => adapter.composerControl?.(worker),
    liveness: (worker, observationWindowMs) => adapter.liveness({ worker, observationWindowMs }).status,
    sentStorePath: SENT_STORE_PATH,
  };
}

export async function runSupervisorUnsentComposerTick(
  providedDeps?: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState = createUnsentComposerWatchState(),
): Promise<UnsentComposerSubmitResult> {
  const deps = providedDeps ?? createAdapterSubmitDeps(await selectRuntimeAdapter());
  hydrateSubmitted(state, deps.sentStorePath);
  const listed = deps.listWorkersAsync
    ? await deps.listWorkersAsync()
    : deps.listWorkers();
  if (!listed.ok) {
    return {
      ok: false,
      dryRun: false,
      watch: true,
      terminals: [{ terminal: '', generation: '', ok: false, unsent: false, enter: false, reason: listed.reason }],
    };
  }
  let persistTail = Promise.resolve();
  const persistAfterObservation = (): Promise<void> => {
    persistTail = persistTail.then(() => {
      persistSubmitted(state, deps.sentStorePath);
    });
    return persistTail;
  };
  const runWorker = async (worker: RuntimeWorker): Promise<UnsentComposerTerminalResult> => {
    const workerDeps: UnsentComposerSubmitDeps = {
      ...deps,
      listWorkers: () => ({ ok: true, workers: [worker] }),
      sentStorePath: undefined,
    };
    const result = deps.readAsync
      ? await submitOneAsync(worker, { terminals: [worker.identity.id], watch: true }, workerDeps, state)
      : submitOne(worker, { terminals: [worker.identity.id], watch: true }, workerDeps, state);
    await persistAfterObservation();
    return result ?? {
      terminal: worker.identity.id,
      generation: worker.identity.generation,
      ok: false,
      unsent: false,
      enter: false,
      reason: 'composer_result_missing',
    };
  };
  const terminals = await Promise.all(listed.workers.map(runWorker));
  await persistTail;
  return { ok: terminals.every((row) => row.ok), dryRun: false, watch: true, terminals };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: readonly string[]): UnsentComposerSubmitInput & {
  readonly once: boolean;
  readonly delivery: boolean;
  readonly reconcile: boolean;
  readonly messageId: string;
} {
  const terminals: string[] = [];
  let dryRun = false;
  let once = false;
  let delivery = false;
  let reconcile = false;
  let messageId = '';
  let intervalMs = DEFAULT_INTERVAL_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--terminal') {
      const value = argv[++index]?.trim() ?? '';
      if (value) terminals.push(value);
      continue;
    }
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token === '--once') {
      once = true;
      continue;
    }
    if (token === '--delivery') {
      delivery = true;
      continue;
    }
    if (token === '--reconcile') {
      reconcile = true;
      continue;
    }
    if (token === '--message-id') {
      messageId = argv[++index]?.trim() ?? '';
      continue;
    }
    if (token === '--watch') {
      once = false;
      continue;
    }
    if (token === '--interval-ms') {
      intervalMs = parsePositiveInt(argv[++index], DEFAULT_INTERVAL_MS);
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return { terminals, dryRun, once, delivery, reconcile, messageId, intervalMs };
}

function shouldLogWatchTick(result: UnsentComposerSubmitResult): boolean {
  return result.terminals.some((row) => row.enter || !row.ok || row.reason === 'submit_witness_unavailable');
}

function isDirectCliExecution(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  return import.meta.url === pathToFileURL(script).href;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const adapter = await selectRuntimeAdapter();
  const deps = createAdapterSubmitDeps(adapter);
  if (parsed.reconcile) {
    const result = await runOrchestrationMailReconcileTick(createOrcaMessageSubmitDeps(adapter, deps));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (parsed.delivery) {
    if (parsed.dryRun || parsed.once || (parsed.messageId && parsed.terminals?.length)) {
      throw new Error('delivery mode requires one --message-id or one --terminal and cannot combine with --dry-run or --once');
    }
    const result = parsed.messageId
      ? await submitOrcaMessageDeliveryPointer(
        parsed.messageId,
        createOrcaMessageSubmitDeps(adapter, deps),
        { reconcileLedgerPath: ORCHESTRATION_RECONCILE_LEDGER_PATH },
      )
      : parsed.terminals?.length === 1
        ? await submitUnsentCursorComposerDeliveryForTerminal(parsed.terminals[0] ?? '', adapter, deps)
        : (() => { throw new Error('delivery mode requires one --message-id or one --terminal'); })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  acquireWatchLock();
  installLockRelease();
  if (parsed.once) {
    const result = submitUnsentCursorComposerOnce({ ...parsed }, deps);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const state = createUnsentComposerWatchState();
  const sleep = deps.sleep ?? sleepSync;
  for (;;) {
    const result = submitUnsentCursorComposer({ ...parsed, watch: true }, deps, state);
    if (shouldLogWatchTick(result)) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    if (!result.ok) process.exitCode = 1;
    sleep(parsed.intervalMs ?? DEFAULT_INTERVAL_MS);
  }
}

if (isDirectCliExecution()) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
