#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import { runProcessSync } from '../kernel/subprocess.ts';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FleetPaneState = 'busy' | 'STOPPED' | 'POLLING' | 'PARKED';

export interface FleetTerminal {
  readonly handle: string;
  readonly title: string;
  readonly worktreePath: string;
}

export interface FleetPaneObservation extends FleetTerminal {
  readonly state: FleetPaneState;
  readonly lines: readonly string[];
}

export interface OrcaCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export type OrcaExecutor = (args: readonly string[]) => OrcaCommandResult;

export interface FleetPollingStore {
  hasPollingMark(handle: string): boolean;
  setPollingMark(handle: string): void;
  clearPollingMark(handle: string): void;
}

export interface FleetSweepOptions {
  readonly primary: string;
  readonly workspaceRe?: RegExp;
  readonly busyRe?: RegExp;
  readonly lines?: number;
  readonly json?: boolean;
  readonly executor?: OrcaExecutor;
  readonly store?: FleetPollingStore;
  readonly terminals?: readonly FleetTerminal[];
}

const DEFAULT_AGENT_TITLE_RE = /(?:\bOpenCode\b|\bCursor\b|\bClaude\b|\bOC\s*\||✳|…\s*Agent|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/iu;
export const DEFAULT_BUSY_RE = /(?:esc\s+(?:to\s+)?interrupt|ctrl\+c\s+to\s+stop)/iu;
const POLLING_RE = /(?:\bsleep\s+\d+(?:\.\d+)?\b|\bWAIT_EXIT\s*=\s*124\b|\bexit(?:[_ -]?code)?\s*[:=]?\s*124\b)/iu;
const CHROME_LINE_RE = /^(?:Cursor Agent|OpenCode|Claude Code)(?:\s|$)|^(?:model|context|tokens?)\s*:/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizedPath(value: string): string {
  return resolve(value).replaceAll('\\', '/');
}

export function defaultWorkspaceRegex(primary: string): RegExp {
  const project = basename(resolve(primary));
  return new RegExp(`(?:^|/)orca/workspaces/${escapeRegExp(project)}/`, 'u');
}

export function compileRegex(raw: string | undefined, fallback: RegExp): RegExp {
  if (!raw?.trim()) return fallback;
  return new RegExp(raw, 'iu');
}

export function looksLikeAgentPane(title: string): boolean {
  return DEFAULT_AGENT_TITLE_RE.test(title);
}

export function isBusyScreen(screen: string, busyRe: RegExp = DEFAULT_BUSY_RE): boolean {
  busyRe.lastIndex = 0;
  return busyRe.test(screen);
}

export function hasPollingEvidence(screen: string): boolean {
  const recent = nonChromeLines(screen).slice(-2).join('\n');
  return POLLING_RE.test(recent);
}

function nonChromeLines(screen: string): string[] {
  return screen
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^[─━═-]{8,}$/u.test(trimmed)) return false;
      return !CHROME_LINE_RE.test(trimmed);
    });
}

function screenLines(screen: string): string[] {
  return screen.split(/\r?\n/u);
}

export class FleetScreenReadError extends Error {
  readonly handle: string;

  constructor(handle: string, detail: string) {
    super(`${handle} unreadable: ${detail}`);
    this.name = 'FleetScreenReadError';
    this.handle = handle;
  }
}

export class FileFleetStateStore implements FleetPollingStore {
  readonly root: string;

  constructor(primary: string, env: NodeJS.ProcessEnv = process.env) {
    const runtime = env.XDG_RUNTIME_DIR?.trim();
    if (!runtime) throw new Error('XDG_RUNTIME_DIR is required for fleet-sweep state');
    this.root = join(runtime, 'fleet-sweep', basename(resolve(primary)));
  }

  private pollingPath(handle: string): string {
    const key = createHash('sha256').update(handle).digest('hex').slice(0, 24);
    return join(this.root, `poll-${key}.mark`);
  }

  hasPollingMark(handle: string): boolean {
    return existsSync(this.pollingPath(handle));
  }

  setPollingMark(handle: string): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.pollingPath(handle), `${handle}\n`, 'utf8');
  }

  clearPollingMark(handle: string): void {
    rmSync(this.pollingPath(handle), { force: true });
  }
}

export function defaultOrcaExecutor(args: readonly string[]): OrcaCommandResult {
  const result = runProcessSync({
    command: 'orca',
    args,
    timeoutMs: 15_000,
    inheritParentEnv: true,
  });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr || result.error || '',
    exitCode: result.exitCode,
  };
}

function terminalCensus(payload: unknown): FleetTerminal[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('terminal list unreadable: malformed census');
  }
  const record = payload as Record<string, unknown>;
  const result = record.result;
  if (record.ok !== true || !result || typeof result !== 'object') {
    throw new Error('terminal list unreadable: malformed census');
  }
  const resultRecord = result as Record<string, unknown>;
  const terminals = resultRecord.terminals;
  const totalCount = resultRecord.totalCount;
  const truncated = resultRecord.truncated;
  if (!Array.isArray(terminals)
    || truncated !== false
    || typeof totalCount !== 'number'
    || !Number.isInteger(totalCount)
    || totalCount !== terminals.length) {
    throw new Error('terminal list unreadable: incomplete census');
  }
  return terminals.map((value, index): FleetTerminal => {
    if (!value || typeof value !== 'object') {
      throw new Error(`terminal list unreadable: malformed row ${index}`);
    }
    const item = value as Record<string, unknown>;
    const handle = typeof item.handle === 'string' ? item.handle.trim() : '';
    const worktreePath = typeof item.worktreePath === 'string' ? item.worktreePath.trim() : '';
    if (!handle || !worktreePath) {
      throw new Error(`terminal list unreadable: malformed row ${index}`);
    }
    return {
      handle,
      title: typeof item.title === 'string' ? item.title : '',
      worktreePath,
    };
  });
}

export function listFleetTerminals(executor: OrcaExecutor = defaultOrcaExecutor): FleetTerminal[] {
  const response = executor(['terminal', 'list', '--json']);
  if (!response.ok) {
    throw new Error(`terminal list unreadable: ${response.stderr || `exit ${String(response.exitCode)}`}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.stdout) as unknown;
  } catch (error) {
    throw new Error(`terminal list unreadable: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return terminalCensus(parsed);
}

export function readFleetScreen(handle: string, executor: OrcaExecutor = defaultOrcaExecutor): string {
  const response = executor(['terminal', 'read', '--terminal', handle, '--screen']);
  if (!response.ok) {
    throw new FleetScreenReadError(handle, response.stderr || `exit ${String(response.exitCode)}`);
  }
  return response.stdout;
}

export function selectAgentTerminals(
  terminals: readonly FleetTerminal[],
  primary: string,
  workspaceRe: RegExp = defaultWorkspaceRegex(primary),
): FleetTerminal[] {
  const primaryPath = normalizedPath(primary);
  return terminals.filter((terminal) => {
    if (!terminal.worktreePath) return false;
    const worktree = terminal.worktreePath.replaceAll('\\', '/');
    workspaceRe.lastIndex = 0;
    if (!workspaceRe.test(worktree)) return false;
    if (normalizedPath(terminal.worktreePath) === primaryPath) return false;
    return looksLikeAgentPane(terminal.title);
  });
}

export function classifyFleetPane(
  screen: string,
  handle: string,
  store: FleetPollingStore,
  busyRe: RegExp = DEFAULT_BUSY_RE,
): FleetPaneState {
  const busy = isBusyScreen(screen, busyRe);
  const recent = screenLines(screen).slice(-30).join('\n');
  if (!busy) {
    store.clearPollingMark(handle);
    return /\bPARKED on\b/iu.test(recent) ? 'PARKED' : 'STOPPED';
  }

  if (!hasPollingEvidence(screen)) {
    store.clearPollingMark(handle);
    return 'busy';
  }

  const consecutive = store.hasPollingMark(handle);
  store.setPollingMark(handle);
  return consecutive ? 'POLLING' : 'busy';
}

export function runFleetSweep(options: FleetSweepOptions): FleetPaneObservation[] {
  const executor = options.executor ?? defaultOrcaExecutor;
  const store = options.store ?? new FileFleetStateStore(options.primary);
  const terminals = options.terminals ?? listFleetTerminals(executor);
  const selected = selectAgentTerminals(
    terminals,
    options.primary,
    options.workspaceRe ?? defaultWorkspaceRegex(options.primary),
  );
  const lineCount = options.lines ?? 4;
  if (!Number.isInteger(lineCount) || lineCount < 0) throw new Error('--lines must be a non-negative integer');
  const busyRe = options.busyRe ?? DEFAULT_BUSY_RE;

  return selected.map((terminal) => {
    let screen: string;
    try {
      screen = readFleetScreen(terminal.handle, executor);
    } catch (error) {
      store.clearPollingMark(terminal.handle);
      throw error;
    }
    return {
      ...terminal,
      state: classifyFleetPane(screen, terminal.handle, store, busyRe),
      lines: lineCount === 0 ? [] : nonChromeLines(screen).slice(-lineCount),
    };
  });
}

export function formatFleetSweep(observations: readonly FleetPaneObservation[]): string {
  return observations
    .flatMap((pane) => [
      `=== ${pane.state}  ${pane.handle}  ${pane.title}`,
      ...pane.lines,
    ])
    .join('\n');
}

interface SweepCliOptions {
  primary: string;
  workspaceRe?: RegExp;
  busyRe?: RegExp;
  lines: number;
  json: boolean;
}

export function parseSweepCli(argv: readonly string[], cwd = process.cwd()): SweepCliOptions {
  let primary = cwd;
  let workspaceRaw: string | undefined;
  let busyRaw: string | undefined;
  let lines = 4;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--primary') {
      const value = argv[++index];
      if (!value) throw new Error('--primary requires a path');
      primary = value;
    } else if (token === '--workspace-re') {
      const value = argv[++index];
      if (!value) throw new Error('--workspace-re requires a pattern');
      workspaceRaw = value;
    } else if (token === '--busy-re') {
      const value = argv[++index];
      if (!value) throw new Error('--busy-re requires a pattern');
      busyRaw = value;
    } else if (token === '--lines') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0) throw new Error('--lines must be a non-negative integer');
      lines = value;
    } else if (token === '--json') {
      json = true;
    } else if (token === '--help' || token === '-h') {
      throw new Error('Usage: fleet-sweep [--primary <path>] [--workspace-re <regex>] [--busy-re <regex>] [--lines <n>] [--json]');
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return {
    primary,
    ...(workspaceRaw ? { workspaceRe: compileRegex(workspaceRaw, defaultWorkspaceRegex(primary)) } : {}),
    ...(busyRaw ? { busyRe: compileRegex(busyRaw, DEFAULT_BUSY_RE) } : {}),
    lines,
    json,
  };
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1]) && resolve(process.argv[1]!) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const options = parseSweepCli(process.argv.slice(2));
    const observations = runFleetSweep(options);
    process.stdout.write(options.json ? `${JSON.stringify(observations, null, 2)}\n` : `${formatFleetSweep(observations)}${observations.length ? '\n' : ''}`);
  } catch (error) {
    process.stderr.write(`fleet-sweep: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
