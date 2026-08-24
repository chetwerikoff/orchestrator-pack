#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOrcaJson, type OrcaJsonResponse } from './orca-runtime/native.ts';
import {
  type RuntimeAdapter,
  type RuntimeDispatchResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from './runtime/contracts.ts';
import { selectRuntimeAdapter } from './runtime/registry.ts';
import {
  releaseHeldFileLock,
  replaceLockedFileContents,
  tryAcquireHeldFileLock,
} from './runtime/single-instance-lease.ts';

const UNBOXED_BOX_CHROME = /^[▀▄]+$/u;
const UNBOXED_CTRL_C = /^ctrl\+c to stop\b/iu;
const UNBOXED_STATUS_FOOTER = /^(?:Cursor|GPT-\S+|Composer)\s.+(?:\d+(?:\.\d+)?%|Run Everything)/iu;
const UNBOXED_CWD_FOOTER = /^(?:~[/\\]|[A-Za-z]:[\\/]|\/)/u;
const EMPTY_COMPOSER = /^(?:→\s*)?Add a follow-up\b/iu;
const ORCHESTRATION_NOTICE = /^You have \d+ orchestration messages?\. Run `orca orchestration check --run \S+`\.$/iu;
const LONE_ARROW = /^→$/u;
const BOX_TOP = /^\s*▄{8,}\s*$/u;
const BOX_BOTTOM = /^\s*▀{8,}\s*$/u;
const DEFAULT_INTERVAL_MS = 2_000;
export const WATCH_LOCK_PATH = join(tmpdir(), 'opk-cursor-unsent-composer-submit.lock');
export const SENT_STORE_PATH = join(tmpdir(), 'opk-cursor-unsent-composer-submit.sent.json');

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
  const content = trimNonEmpty(lines).filter((line) => !LONE_ARROW.test(line));
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
  const fingerprint = composerPokeFingerprint(preview);
  if (!ORCHESTRATION_NOTICE.test(fingerprint)) {
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
  const dispatched = deps.submit(identity);
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

/** One immediate composer observation for the exact worker that just received a notification. */
export async function submitUnsentCursorComposerOnceForWorker(
  worker: RuntimeWorker,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState = createUnsentComposerWatchState(),
): Promise<UnsentComposerSubmitResult> {
  hydrateSubmitted(state, deps.sentStorePath);
  const shown = deps.readAsync
    ? await deps.readAsync(worker.identity)
    : deps.read(worker.identity);
  const terminal = settleComposerObservation(
    worker,
    { watch: true },
    deps,
    state,
    shown,
    true,
  );
  persistSubmitted(state, deps.sentStorePath);
  return {
    ok: terminal.ok,
    dryRun: false,
    watch: false,
    terminals: [terminal],
  };
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

function parseArgs(argv: readonly string[]): UnsentComposerSubmitInput & { readonly once: boolean } {
  const terminals: string[] = [];
  let dryRun = false;
  let once = false;
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
  return { terminals, dryRun, once, intervalMs };
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
  acquireWatchLock();
  installLockRelease();
  const adapter = await selectRuntimeAdapter();
  const deps = createAdapterSubmitDeps(adapter);
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
