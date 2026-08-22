#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { processAlive } from './lib/cutover/activation-cordon.ts';
import { submitOrcaTerminalComposer } from './orca-runtime/compat.ts';
import { runOrcaJson, type OrcaJsonResponse } from './orca-runtime/native.ts';

const CHROME_LINE = /^(?:Run Everything|Tip:|[▀▄]|~\s*\/|~\/|Cursor |GPT-|Composer |ctrl\+c to stop)/iu;
const EMPTY_COMPOSER = /^(?:→\s*)?Add a follow-up\b/iu;
const LONE_ARROW = /^→$/u;
const PASTED_DRAFT = /^(?:→\s*)?\[Pasted text\b/u;
const MACHINE_POKE = /^You have \d+ orchestration messages?\. Run `orca orchestration check --run [A-Za-z0-9_-]+`\.$/u;
const BOX_TOP = /^\s*▄/u;
const BOX_BOTTOM = /^\s*▀/u;
const DEFAULT_INTERVAL_MS = 2_000;
export const QUIET_AFTER_PRINT_MS = 10_000;
const LOCK_PATH = join(tmpdir(), 'opk-cursor-unsent-composer-submit.lock');

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

function outerMeaningfulLines(lines: readonly string[]): string[] {
  return trimNonEmpty(lines).filter((line) => !CHROME_LINE.test(line) && !LONE_ARROW.test(line));
}

function boxedComposerLines(lines: readonly string[]): string[] {
  return trimNonEmpty(lines).filter((line) => !LONE_ARROW.test(line));
}

function isComposerManualLine(line: string): boolean {
  if (EMPTY_COMPOSER.test(line) || MACHINE_POKE.test(line)) return false;
  if (PASTED_DRAFT.test(line)) return true;
  return /^→\s+\S/u.test(line);
}

export function classifyCursorComposer(preview: string): CursorComposerKind {
  const interior = composerInterior(preview);
  if (interior) {
    const lines = boxedComposerLines(interior);
    if (lines.length === 0 || lines.every((line) => EMPTY_COMPOSER.test(line))) return 'empty';
    if (lines.every((line) => MACHINE_POKE.test(line))) return 'machine_poke';
    return 'manual';
  }
  const lines = outerMeaningfulLines(preview.split(/\r?\n/));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (EMPTY_COMPOSER.test(line)) return 'empty';
    if (MACHINE_POKE.test(line)) {
      let cursor = index - 1;
      while (cursor >= 0 && MACHINE_POKE.test(lines[cursor] ?? '')) cursor -= 1;
      if (cursor >= 0 && isComposerManualLine(lines[cursor] ?? '')) return 'manual';
      return 'machine_poke';
    }
    return 'manual';
  }
  return 'empty';
}

export function cursorComposerLooksUnsent(preview: string): boolean {
  return classifyCursorComposer(preview) === 'machine_poke';
}

export function composerPokeFingerprint(preview: string): string {
  const interior = composerInterior(preview);
  const source = interior ? boxedComposerLines(interior) : outerMeaningfulLines(preview.split(/\r?\n/));
  return source.filter((line) => MACHINE_POKE.test(line)).join('\n');
}

function previewFromRead(response: OrcaJsonResponse<unknown>): string {
  const result = response.result;
  if (!result || typeof result !== 'object') return '';
  const terminal = 'terminal' in result && result.terminal && typeof result.terminal === 'object'
    ? result.terminal as Record<string, unknown>
    : result as Record<string, unknown>;
  const tail = Array.isArray(terminal.tail)
    ? terminal.tail.filter((row): row is string => typeof row === 'string')
    : Array.isArray((result as { lines?: unknown }).lines)
      ? (result as { lines: unknown[] }).lines.filter((row): row is string => typeof row === 'string')
      : [];
  return tail.join('\n');
}

function handlesFromList(response: OrcaJsonResponse<unknown>): string[] {
  const result = response.result;
  if (!result || typeof result !== 'object') return [];
  const terminals = 'terminals' in result && Array.isArray(result.terminals)
    ? result.terminals
    : [];
  const handles: string[] = [];
  for (const row of terminals) {
    if (!row || typeof row !== 'object') continue;
    const handle = (row as { handle?: unknown }).handle;
    if (typeof handle === 'string' && handle.trim()) handles.push(handle.trim());
  }
  return handles;
}

export interface UnsentComposerSubmitDeps {
  readonly list: () => OrcaJsonResponse<unknown>;
  readonly read: (handle: string) => OrcaJsonResponse<unknown>;
  readonly submit: (handle: string) => OrcaJsonResponse<unknown>;
  readonly sleep?: (milliseconds: number) => void;
  readonly now?: () => number;
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

const defaultDeps: UnsentComposerSubmitDeps = {
  list: () => runOrcaJson(['terminal', 'list']),
  read: (handle) => runOrcaJson(['terminal', 'read', '--terminal', handle]),
  submit: (handle) => submitOrcaTerminalComposer(handle),
};

function clearObservation(state: UnsentComposerWatchState, handle: string, clearSubmitted: boolean): void {
  state.lastFingerprint.delete(handle);
  state.lastChangedAt.delete(handle);
  if (clearSubmitted) state.submittedFingerprint.delete(handle);
}

function submitOne(
  handle: string,
  input: UnsentComposerSubmitInput,
  deps: UnsentComposerSubmitDeps,
  state: UnsentComposerWatchState,
): UnsentComposerTerminalResult {
  const shown = deps.read(handle);
  if (!shown.ok) {
    return {
      terminal: handle,
      ok: false,
      unsent: false,
      enter: false,
      reason: shown.error?.code ?? shown.error?.message ?? 'terminal_read_failed',
    };
  }
  const preview = previewFromRead(shown);
  const kind = classifyCursorComposer(preview);
  if (kind === 'empty') {
    clearObservation(state, handle, true);
    return { terminal: handle, ok: true, unsent: false, enter: false, reason: 'composer_empty' };
  }
  if (kind === 'manual') {
    clearObservation(state, handle, false);
    return { terminal: handle, ok: true, unsent: false, enter: false, reason: 'manual_input' };
  }
  const fingerprint = composerPokeFingerprint(preview);
  if (state.submittedFingerprint.get(handle) === fingerprint) {
    return { terminal: handle, ok: true, unsent: true, enter: false, reason: 'already_submitted' };
  }
  if (input.watch) {
    const now = deps.now?.() ?? Date.now();
    if (state.lastFingerprint.get(handle) !== fingerprint) {
      state.lastFingerprint.set(handle, fingerprint);
      state.lastChangedAt.set(handle, now);
      return { terminal: handle, ok: true, unsent: true, enter: false, reason: 'waiting_stable' };
    }
    const quietFor = now - (state.lastChangedAt.get(handle) ?? now);
    if (quietFor < QUIET_AFTER_PRINT_MS) {
      return { terminal: handle, ok: true, unsent: true, enter: false, reason: 'waiting_stable' };
    }
  }
  if (input.dryRun) {
    return { terminal: handle, ok: true, unsent: true, enter: false, reason: 'dry_run' };
  }
  const submitted = deps.submit(handle);
  if (!submitted.ok) {
    return {
      terminal: handle,
      ok: false,
      unsent: true,
      enter: false,
      reason: submitted.error?.code ?? submitted.error?.message ?? 'terminal_enter_failed',
    };
  }
  state.submittedFingerprint.set(handle, fingerprint);
  return { terminal: handle, ok: true, unsent: true, enter: true, reason: 'enter_sent' };
}

export function submitUnsentCursorComposer(
  input: UnsentComposerSubmitInput = {},
  deps: UnsentComposerSubmitDeps = defaultDeps,
  state: UnsentComposerWatchState = createUnsentComposerWatchState(),
): UnsentComposerSubmitResult {
  const dryRun = Boolean(input.dryRun);
  const watch = Boolean(input.watch);
  const requested = (input.terminals ?? []).map((handle) => handle.trim()).filter(Boolean);
  let handles = requested;
  if (handles.length === 0) {
    const listed = deps.list();
    if (!listed.ok) {
      return {
        ok: false,
        dryRun,
        watch,
        terminals: [{
          terminal: '',
          ok: false,
          unsent: false,
          enter: false,
          reason: listed.error?.code ?? listed.error?.message ?? 'terminal_list_failed',
        }],
      };
    }
    handles = handlesFromList(listed);
  }
  const terminals = handles.map((handle) => submitOne(handle, { ...input, watch }, deps, state));
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
  deps: UnsentComposerSubmitDeps = defaultDeps,
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

function acquireWatchLock(): void {
  try {
    const fd = openSync(LOCK_PATH, 'wx');
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = Number.parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    if (Number.isInteger(existing) && existing > 0 && processAlive(existing)) {
      throw new Error(`already running pid=${existing}`);
    }
    unlinkSync(LOCK_PATH);
    acquireWatchLock();
  }
  const release = (): void => {
    try { unlinkSync(LOCK_PATH); } catch { /* lock file already gone */ }
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
  return result.terminals.some((row) => row.enter || !row.ok);
}

function isDirectCliExecution(): boolean {
  const script = process.argv[1];
  return Boolean(script) && import.meta.url === pathToFileURL(script).href;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.once) {
    const result = submitUnsentCursorComposerOnce({ ...parsed });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  acquireWatchLock();
  const state = createUnsentComposerWatchState();
  const sleep = defaultDeps.sleep ?? sleepSync;
  for (;;) {
    const result = submitUnsentCursorComposer({ ...parsed, watch: true }, defaultDeps, state);
    if (shouldLogWatchTick(result)) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    if (!result.ok) process.exitCode = 1;
    sleep(parsed.intervalMs ?? DEFAULT_INTERVAL_MS);
  }
}

if (isDirectCliExecution()) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
