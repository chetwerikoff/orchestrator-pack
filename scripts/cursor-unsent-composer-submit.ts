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
const UNBOXED_CWD_FOOTER = /^~\//u;
const EMPTY_COMPOSER = /^(?:→\s*)?Add a follow-up\b/iu;
const LONE_ARROW = /^→$/u;
const MACHINE_POKE = /^You have \d+ orchestration messages?\. Run `orca orchestration check --run [A-Za-z0-9_-]+`\.$/u;
const BOX_TOP = /^\s*▄{8,}\s*$/u;
const BOX_BOTTOM = /^\s*▀{8,}\s*$/u;
const DEFAULT_INTERVAL_MS = 2_000;
export const QUIET_AFTER_PRINT_MS = 5_000;
export const WATCH_LOCK_PATH = join(tmpdir(), 'opk-cursor-unsent-composer-submit.lock');
export const SENT_STORE_PATH = join(tmpdir(), 'opk-cursor-unsent-composer-submit.sent.json');

export type CursorComposerKind = 'empty' | 'machine_poke' | 'manual';

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
  return trimNonEmpty(lines).filter((line) => !LONE_ARROW.test(line));
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
  return lines.slice(0, end);
}

function classifyContent(lines: readonly string[]): CursorComposerKind {
  if (lines.length === 0 || lines.every((line) => EMPTY_COMPOSER.test(line))) return 'empty';
  if (lines.every((line) => MACHINE_POKE.test(line))) return 'machine_poke';
  return 'manual';
}

export function classifyCursorComposer(preview: string): CursorComposerKind {
  const interior = composerInterior(preview);
  if (interior) return classifyContent(composerContentLines(interior));
  return classifyContent(unboxedComposerLines(preview));
}

export function cursorComposerLooksUnsent(preview: string): boolean {
  return classifyCursorComposer(preview) === 'machine_poke';
}

export function composerPokeFingerprint(preview: string): string {
  const interior = composerInterior(preview);
  const source = interior ? composerContentLines(interior) : unboxedComposerLines(preview);
  return source.filter((line) => MACHINE_POKE.test(line)).join('\n');
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
  if (
    typeof runtime !== 'string' || !runtime
    || typeof id !== 'string' || !id
    || typeof generation !== 'string' || !generation
    || typeof fingerprint !== 'string' || !fingerprint
  ) return undefined;
  return { runtime, id, generation, fingerprint };
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
    lastFingerprint: new Map(),
    lastChangedAt: new Map(),
  });
}

interface PersistableWatchState {
  readonly submittedFingerprint: ReadonlyMap<string, string>;
  readonly lastFingerprint: ReadonlyMap<string, string>;
  readonly lastChangedAt: ReadonlyMap<string, number>;
}

function saveWatchStore(path: string, state: PersistableWatchState): void {
  const submitted = [...state.submittedFingerprint.entries()].flatMap(([key, fingerprint]) => {
    const row = identityFromKey(key, fingerprint);
    return row ? [row] : [];
  });
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
  readonly read: (worker: RuntimeWorkerIdentity) =>
    | { ok: true; lines: readonly string[]; source: 'screen' }
    | { ok: false; reason: string };
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
  };
}

function clearObservation(state: UnsentComposerWatchState, key: string): void {
  state.lastFingerprint.delete(key);
  state.lastChangedAt.delete(key);
}

function submitOne(
  worker: RuntimeWorker,
  input: UnsentComposerSubmitInput,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState,
): UnsentComposerTerminalResult {
  const identity = worker.identity;
  const key = workerKey(identity);
  const base = { terminal: identity.id, generation: identity.generation };
  const shown = deps.read(identity);
  if (!shown.ok) {
    return { ...base, ok: false, unsent: false, enter: false, reason: shown.reason };
  }
  const preview = shown.lines.join('\n');
  const kind = classifyCursorComposer(preview);
  if (kind === 'empty') {
    clearObservation(state, key);
    return { ...base, ok: true, unsent: false, enter: false, reason: 'composer_empty' };
  }
  if (kind === 'manual') {
    clearObservation(state, key);
    return { ...base, ok: true, unsent: false, enter: false, reason: 'manual_input' };
  }
  const fingerprint = composerPokeFingerprint(preview);
  if (state.submittedFingerprint.get(key) === fingerprint) {
    return { ...base, ok: true, unsent: true, enter: false, reason: 'already_submitted' };
  }
  if (input.watch) {
    const now = deps.now?.() ?? Date.now();
    if (state.lastFingerprint.get(key) !== fingerprint) {
      state.lastFingerprint.set(key, fingerprint);
      state.lastChangedAt.set(key, now);
      return { ...base, ok: true, unsent: true, enter: false, reason: 'waiting_stable' };
    }
    const quietFor = now - (state.lastChangedAt.get(key) ?? now);
    if (quietFor < QUIET_AFTER_PRINT_MS) {
      return { ...base, ok: true, unsent: true, enter: false, reason: 'waiting_stable' };
    }
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
    return { ...base, ok: true, unsent: true, enter: false, reason: dispatched.reason };
  }
  return { ...base, ok: true, unsent: true, enter: true, reason: 'enter_sent' };
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
  const first = submitUnsentCursorComposer({ ...input, watch: true }, deps, state);
  if (!first.terminals.some((row) => row.reason === 'waiting_stable')) {
    return { ...first, watch: false };
  }
  (deps.sleep ?? sleepSync)(QUIET_AFTER_PRINT_MS);
  const second = submitUnsentCursorComposer({ ...input, watch: true }, deps, state);
  return { ...second, watch: false };
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

export async function runSupervisorUnsentComposerTick(): Promise<UnsentComposerSubmitResult> {
  const adapter = await selectRuntimeAdapter();
  return submitUnsentCursorComposer({ watch: true }, createAdapterSubmitDeps(adapter));
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
  return Boolean(script) && import.meta.url === pathToFileURL(script).href;
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
