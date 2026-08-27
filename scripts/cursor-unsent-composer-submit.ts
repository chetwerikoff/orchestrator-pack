#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOrcaJson, type OrcaJsonResponse } from './orca-runtime/native.ts';
import {
  type RuntimeAdapter,
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
const ORCHESTRATION_NOTICE = /^You have \d+ orchestration messages?\. Run `orca orchestration check(?: --run \S+| --terminal \S+)?`\.$/iu;
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

function composerContentLines(lines: readonly string[]): string[] {
  const content = trimNonEmpty(lines)
    .filter((line) => !LONE_ARROW.test(line) && !UNBOXED_CTRL_C.test(line))
    .map((line) => line.replace(/^→\s*/u, '').trim())
    .filter(Boolean);
  // A live orchestration notice can be rendered inside the box after the
  // user's text. Preserve a notice in the first line for compatibility with
  // a user-entered poke, but exclude trailing notices from the fingerprint.
  return content.filter((line, index) => index === 0 || !ORCHESTRATION_NOTICE.test(line));
}

function unboxedComposerLines(preview: string): string[] {
  const lines = composerContentLines(preview.split(/\r?\n/));
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
  const source = interior ? composerContentLines(interior) : unboxedComposerLines(preview);
  // Cursor may wrap between words or inside the command token. Try both
  // reconstructions, but return only the command so wording/count changes do
  // not invalidate the exact-pointer comparison.
  const candidates = [source.join(''), source.join(' '), preview.trim()];
  for (const candidate of candidates) {
    if (!/^You have \d+ orchestration messages?\b/iu.test(candidate)) continue;
    const command = candidate.match(new RegExp('^You have \\d+ orchestration messages?\\b.*\\x60(orca orchestration check(?: --run \\S+| --terminal \\S+)?)\\x60\\.$', 'iu'))?.[1];
    if (command && ORCHESTRATION_CHECK_COMMAND.test(command)) return candidate;
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
  readonly workerKey: string;
  readonly nextEligibleAt: number;
  readonly backoffMs: number;
}

interface PersistedReconcileState {
  readonly messages: Record<string, number>;
  readonly episodes: Record<string, EpisodeRecord>;
}

function episodeKey(message: DeliveryMessage, worker: RuntimeWorker): string {
  return workerKey(worker.identity) + '\u0000' + message.runId + '\u0000' + message.id;
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
        const row = value as Partial<EpisodeRecord>;
        if (
          typeof row.messageId === 'string' && row.messageId
          && typeof row.runId === 'string' && row.runId
          && typeof row.workerKey === 'string' && row.workerKey
          && typeof row.nextEligibleAt === 'number' && Number.isFinite(row.nextEligibleAt)
          && typeof row.backoffMs === 'number' && Number.isFinite(row.backoffMs)
        ) episodes[key] = {
          messageId: row.messageId,
          runId: row.runId,
          workerKey: row.workerKey,
          nextEligibleAt: row.nextEligibleAt,
          backoffMs: row.backoffMs,
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
  readonly writePointer: (
    worker: RuntimeWorkerIdentity,
    pointer: string,
  ) => RuntimeDispatchResult;
  readonly submitDeps: UnsentComposerSubmitDeps;
  readonly pointerWriteLedger?: Map<string, number>;
  readonly reconcileClock?: () => number;
  readonly episodeStatePath?: string;
  readonly episodeLockPath?: string;
  readonly episodeState?: PersistedReconcileState;
}

export interface OrchestrationMailReconcileResult {
  readonly ok: boolean;
  readonly attempted: number;
  readonly nudged: number;
  readonly skipped: number;
  readonly reasons: readonly string[];
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

function settleComposerObservation(
  worker: RuntimeWorker,
  input: UnsentComposerSubmitInput,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState,
  shown: ComposerReadResult,
  allowAmbiguousRetry = false,
  submitCount = 1,
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
    return { ...base, ok: true, unsent: false, enter: false, reason: 'composer_empty' };
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
  state.submittedFingerprint.set(key, fingerprint);
  const dispatches: RuntimeDispatchResult[] = [deps.submit(identity)];
  if (submitCount > 1 && dispatches[0]?.status !== 'send_failed') {
    const reshown = deps.read(identity);
    const stillBusy = deps.liveness?.(identity, DELIVERY_LIVENESS_WINDOW_MS) === 'busy';
    if (stillBusy && reshown.ok && isExactOrchestrationPointer(reshown)) {
      dispatches.push(deps.submit(identity));
    }
  }
  const dispatched = dispatches.find((result) => result.status === 'send_failed')
    ?? dispatches.find((result) => result.status === 'dispatch_unknown')
    ?? dispatches.at(-1)!;
  if (dispatched.status === 'send_failed') {
    state.submittedFingerprint.delete(key);
    return { ...base, ok: false, unsent: true, enter: false, reason: dispatched.reason };
  }
  if (dispatched.status === 'dispatch_unknown') {
    const fingerprints = state.ambiguousSubmittedFingerprints.get(key) ?? new Set<string>();
    fingerprints.add(fingerprint);
    state.ambiguousSubmittedFingerprints.set(key, fingerprints);
    return { ...base, ok: true, unsent: true, enter: false, reason: dispatched.reason };
  }
  if (dispatched.status === 'dispatched') {
    const fingerprints = state.ambiguousSubmittedFingerprints.get(key);
    fingerprints?.delete(fingerprint);
    if (fingerprints?.size === 0) state.ambiguousSubmittedFingerprints.delete(key);
  }
  return { ...base, ok: true, unsent: true, enter: true, reason: 'enter_sent' };
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

function isExactOrchestrationPointer(shown: ComposerReadResult): boolean {
  if (!shown.ok) return false;
  return exactOrchestrationPointerFingerprint(shown.lines.join('\n')) !== undefined;
}

export function buildDeliveryPointer(message: DeliveryMessage): string {
  const check = message.recipient.startsWith('dispatch:')
    ? 'orca orchestration check'
    : message.recipient.startsWith('run:')
      ? `orca orchestration check --run ${message.runId}`
      : message.recipient.startsWith('term_')
        ? `orca orchestration check --terminal ${message.recipient}`
        : `orca orchestration check --run ${message.runId}`;
  return `You have 1 orchestration message. Read orchestration mail, check the fleet, and clear blockers so the fleet does not idle. Run \`${check}\`.`;
}

function composerShowsDeliveryPointer(shown: ComposerReadResult, pointer: string): boolean {
  if (!shown.ok || !isExactOrchestrationPointer(shown)) return false;
  const observed = exactOrchestrationPointerFingerprint(shown.lines.join('\n'));
  const expected = exactOrchestrationPointerFingerprint(pointer);
  const command = (value: string): string | undefined =>
    value.match(new RegExp('\\x60(orca orchestration check(?: --run \\S+| --terminal \\S+)?)\\x60', 'iu'))?.[1];
  return observed !== undefined && expected !== undefined
    && command(observed) !== undefined && command(observed) === command(expected);
}

/** Immediate delivery-scoped observation plus one bounded render-race retry. */
export async function submitUnsentCursorComposerOnceForWorker(
  worker: RuntimeWorker,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState = createUnsentComposerWatchState(),
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
  const exactPointer = isExactOrchestrationPointer(shown);
  const liveness = exactPointer
    ? deps.liveness?.(worker.identity, DELIVERY_LIVENESS_WINDOW_MS) ?? 'unknown'
    : 'unknown';
  if (exactPointer && deps.liveness && (liveness === 'gone' || liveness === 'unknown')) {
    return {
      ok: true,
      dryRun: false,
      watch: false,
      terminals: [{
        terminal: worker.identity.id,
        generation: worker.identity.generation,
        ok: true,
        unsent: true,
        enter: false,
        reason: `worker_${liveness}`,
      }],
    };
  }
  const terminal = settleComposerObservation(
    worker,
    { watch: true },
    deps,
    state,
    shown,
    true,
    liveness === 'busy' ? 2 : 1,
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
    message: { id, runId, recipient, consumed: row.read === 1 || row.read === true },
  };
}

/** Bind one Orca message to one exact recipient, write its pointer, then submit it. */
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
    return submitOrcaMessageDeliveryPointerForMessage(found.message, deps);
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
      for (const [key, episode] of Object.entries(state.episodes)) {
        if (episode.messageId === id) delete state.episodes[key];
      }
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
  const pointer = buildDeliveryPointer(message);
  const key = episodeKey(message, worker);
  if (deps.pointerWriteLedger?.has(key)) return deliveryNoEffect('orchestration_episode_already_claimed', worker, false);
  const shown = deps.submitDeps.readAsync
    ? await deps.submitDeps.readAsync(worker.identity)
    : deps.submitDeps.read(worker.identity);
  if (!shown.ok) return deliveryNoEffect(shown.reason, worker, false);
  const composerKind = classifyCursorComposer(shown.lines.join('\n'));
  const alreadyShown = composerKind !== 'empty' && composerShowsDeliveryPointer(shown, pointer);
  if (composerKind !== 'empty' && !alreadyShown) {
    return deliveryNoEffect('composer_not_empty_before_delivery', worker);
  }
  const now = deps.reconcileClock?.() ?? Date.now();
  let state = deps.episodeState;
  if (!state && deps.episodeStatePath) state = loadReconcileState(deps.episodeStatePath);
  const existing = state?.episodes[key];
  if (existing && now < existing.nextEligibleAt) {
    return deliveryNoEffect('orchestration_episode_backoff', worker, false);
  }
  const priorBackoff = existing?.backoffMs ?? ORCHESTRATION_RECONCILE_WINDOW_MS;
  const nextBackoff = Math.min(priorBackoff * 2, ORCHESTRATION_RECONCILE_MAX_BACKOFF_MS);
  if (state) {
    state.episodes[key] = {
      messageId: message.id,
      runId: message.runId,
      workerKey: workerKey(worker.identity),
      nextEligibleAt: now + priorBackoff,
      backoffMs: nextBackoff,
    };
    if (deps.episodeStatePath && !deps.episodeState) saveReconcileState(deps.episodeStatePath, state);
  }
  if (deps.pointerWriteLedger) deps.pointerWriteLedger.set(key, now);
  if (!alreadyShown) {
    const written = deps.writePointer(worker.identity, pointer);
    const accepted = written.status === 'dispatched'
      || (written.status === 'dispatch_unknown' && written.witness?.operation === 'write' && written.witness.accepted === true);
    if (!accepted) return deliveryNoEffect(written.reason ?? 'pointer_write_failed', worker, false);
  }
  // The episode claim, rather than the rendered pointer fingerprint, owns Enter.
  return await submitUnsentCursorComposerOnceForWorker(worker, deps.submitDeps, createUnsentComposerWatchState());
}
export function createOrcaMessageSubmitDeps(
  adapter: RuntimeAdapter,
  submitDeps = createAdapterSubmitDeps(adapter),
): DeliveryMessageSubmitDeps {
  const readInbox = () => runOrcaJson<OrcaInboxFullResult>(
    ['orchestration', 'inbox', '--full', '--limit', String(ORCHESTRATION_INBOX_LIMIT)],
    { timeoutMs: RECONCILE_COMMAND_TIMEOUT_MS },
  );
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
      return {
        ok: true,
        message: {
          id: messageId,
          runId,
          recipient,
          consumed: row?.read === 1 || row?.read === true,
        },
      };
    },
    resolveWorker: (message) => {
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
        handle = response.result?.run?.coordinator_handle?.trim() ?? '';
      }
      if (!handle.startsWith('term_')) return { ok: false, reason: 'orchestration_recipient_unresolved' };
      const resolved = adapter.findWorkerById(handle);
      if (resolved.status !== 'ok') return { ok: false, reason: resolved.reason };
      return { ok: true, worker: resolved.value };
    },
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
      const observed = runOrcaJson<OrcaInboxFullResult>([
        'orchestration', 'check', '--terminal', worker.identity.id, '--peek',
      ], { timeoutMs: RECONCILE_COMMAND_TIMEOUT_MS });
      if (!observed.ok) return { ok: false, reason: observed.error?.code ?? 'orchestration_check_unavailable' };
      return (observed.result?.messages ?? []).some((row) => row.id?.trim() === message.id)
        ? { ok: true }
        : { ok: false, reason: 'orchestration_message_unretrievable' };
    },
    writePointer: (worker, pointer) => adapter.dispatchInput({ worker, text: pointer, writeOnly: true }),
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
  if (!held.acquired) return { ok: true, attempted: 0, nudged: 0, skipped: 0, reasons: [`reconcile_lock_${held.reason}`] };
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
    if (!response.ok) return { ok: false, attempted: 0, nudged: 0, skipped: 0, reasons: [response.error?.code ?? 'orchestration_inbox_unavailable'] };
    const unread = (response.result?.messages ?? []).filter((row) => {
      const id = row.id?.trim() ?? '';
      return id && !(row.read === 1 || row.read === true);
    });
    const unreadIds = new Set(unread.map((row) => row.id!.trim()));
    for (const id of Object.keys(state.messages)) {
      if (!unreadIds.has(id) || current - state.messages[id]! >= ORCHESTRATION_RECONCILE_WINDOW_MS) delete state.messages[id];
    }
    for (const [key, episode] of Object.entries(state.episodes)) {
      if (!unreadIds.has(episode.messageId)) delete state.episodes[key];
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
          for (const [key, episode] of Object.entries(state.episodes)) if (episode.messageId === id) delete state.episodes[key];
          result = deliveryNoEffect(resolved.reason, undefined, false);
        } else if (!resolved.worker) {
          for (const [key, episode] of Object.entries(state.episodes)) if (episode.messageId === id) delete state.episodes[key];
          result = deliveryNoEffect('worker_gone', undefined, false);
        } else {
          const worker = resolved.worker;
          const cacheKey = workerKey(worker.identity) + '\u0000' + found.message.runId;
          let observed = retrievable.get(cacheKey);
          if (!observed) {
            observed = deps.observeRetrievableMessageIds
              ? deps.observeRetrievableMessageIds(worker)
              : deps.isMessageRetrievable
                ? deps.isMessageRetrievable(found.message, worker)
                : { ok: false as const, reason: 'orchestration_retrievability_unavailable' };
            retrievable.set(cacheKey, observed);
          }
          const qualifies = 'messageIds' in observed
            ? observed.ok && observed.messageIds.has(found.message.id)
            : observed.ok;
          if (!qualifies) {
            for (const [key, episode] of Object.entries(state.episodes)) if (episode.messageId === id) delete state.episodes[key];
            const reason = !observed.ok ? observed.reason : 'orchestration_message_unretrievable';
            result = deliveryNoEffect(reason, worker, false);
          } else {
            result = await submitOrcaMessageDeliveryPointerForMessage(found.message, reconcileDeps);
          }
        }
      }
      if (result.terminals[0]?.reason === 'orchestration_episode_backoff' || result.terminals[0]?.reason === 'orchestration_episode_already_claimed') skipped += 1;
      if (result.terminals[0]?.enter || result.terminals[0]?.reason === 'dispatch_unknown' || result.terminals[0]?.reason === 'send_failed') nudged += 1;
      state.messages[id] = current;
      if (result.terminals[0]?.reason) reasons.push(`${id}:${result.terminals[0].reason}`);
    }
    saveReconcileState(ledgerPath, state);
    return { ok: reasons.every((reason) => !/:send_failed$|:dispatch_unknown$/u.test(reason)), attempted, nudged, skipped, reasons };
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
