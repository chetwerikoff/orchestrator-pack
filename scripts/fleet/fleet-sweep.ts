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
  readonly coordinatorHandle?: string;
  readonly coordinatorTitleRe?: RegExp;
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
// Agent TUIs frame content with box glyphs and add a model line and a status bar; none of it is
// pane content. OpenCode: `┃  …`, `╹▀▀▀…`, `▣  Pack-Opk-… · GPT-… · medium`, `⬝⬝■■ esc interrupt  175K (64%)  ctrl+p commands`.
const TUI_FRAME_PREFIX_RE = /^[\s┃│╹╻▀▄█▌▐⬝■▣◆●•·]+/u;
const TUI_STATUS_LINE_RE = /esc\s+(?:to\s+)?interrupt|ctrl\+[cp]\s+(?:to\s+stop|commands)|\b\d+(?:\.\d+)?K\s*\(\d+%\)|^Pack-Opk-|\s·\s*(?:GPT|OpenAI|Claude)\b|^Click to expand$|^Tip:|^…$/iu;
const GLYPH_ONLY_LINE_RE = /^(?:[▀▄╹╻⬝■┃│\s]+|\s*[─━═-]{8,}\s*)$/u;
// A braille spinner in front of a line marks the command or step that is running right now.
const RUNNING_SPINNER_PREFIX_RE = /^[\u2800-\u28FF]\s+/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizedPath(value: string): string {
  return resolve(value).replaceAll('\\', '/');
}

export function defaultWorkspaceRegex(primary: string): RegExp {
  const normalizedPrimary = normalizedPath(primary);
  const workspaceMatch = normalizedPrimary.match(/(?:^|\/)orca\/workspaces\/([^/]+)\/[^/]+(?:\/|$)/u);
  const project = workspaceMatch?.[1] ?? basename(resolve(primary));
  return new RegExp(`(?:^|/)orca/workspaces/${escapeRegExp(project)}/`, 'u');
}

export function compileRegex(raw: string | undefined, fallback: RegExp): RegExp {
  if (!raw?.trim()) return fallback;
  return new RegExp(raw, 'iu');
}

export function looksLikeAgentPane(title: string): boolean {
  return DEFAULT_AGENT_TITLE_RE.test(title);
}

// Every supported TUI renders its running-turn marker in the bottom status region. Scrollback
// above it can quote another pane's screen (e.g. `orca terminal read` output), whose status bar
// must not make an idle pane look busy. A marker pushed above the window yields a spurious
// STOPPED (one extra alarm), which is the safe direction; a false busy silences alarms.
export const BUSY_MARKER_WINDOW_LINES = 12;

export function isBusyScreen(screen: string, busyRe: RegExp = DEFAULT_BUSY_RE): boolean {
  const statusRegion = screen
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .slice(-BUSY_MARKER_WINDOW_LINES)
    .join('\n');
  busyRe.lastIndex = 0;
  return busyRe.test(statusRegion);
}

export function hasPollingEvidence(screen: string): boolean {
  const content = contentLines(screen);
  const recent = content.slice(-2).map((line) => line.text).join('\n');
  if (POLLING_RE.test(recent)) return true;
  // A long running command wraps over several lines; its first line carries the spinner.
  const running = [...content].reverse().find((line) => line.running);
  return running !== undefined && POLLING_RE.test(running.text);
}

interface ContentLine {
  readonly text: string;
  readonly running: boolean;
}

function contentLines(screen: string): ContentLine[] {
  const lines: ContentLine[] = [];
  for (const raw of screen.split(/\r?\n/u)) {
    const framed = raw.replace(/\s+$/u, '').replace(TUI_FRAME_PREFIX_RE, '');
    if (!framed.trim() || GLYPH_ONLY_LINE_RE.test(framed)) continue;
    const running = RUNNING_SPINNER_PREFIX_RE.test(framed);
    const text = framed.replace(RUNNING_SPINNER_PREFIX_RE, '').trim();
    if (!text || CHROME_LINE_RE.test(text) || TUI_STATUS_LINE_RE.test(text)) continue;
    lines.push({ text, running });
  }
  return lines;
}

function nonChromeLines(screen: string): string[] {
  return contentLines(screen).map((line) => line.text);
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

export const DEFAULT_ORCHESTRATOR_TITLE_RE = /Cursor/iu;

export function selectAgentTerminals(
  terminals: readonly FleetTerminal[],
  primary: string,
  workspaceRe: RegExp = defaultWorkspaceRegex(primary),
  coordinatorHandle?: string,
  coordinatorTitleRe: RegExp = DEFAULT_ORCHESTRATOR_TITLE_RE,
): FleetTerminal[] {
  const primaryPath = normalizedPath(primary);
  return terminals.filter((terminal) => {
    if (!terminal.worktreePath) return false;
    if (terminal.handle === coordinatorHandle) return false;
    coordinatorTitleRe.lastIndex = 0;
    if (normalizedPath(terminal.worktreePath) === primaryPath && coordinatorTitleRe.test(terminal.title)) return false;
    const worktree = terminal.worktreePath.replaceAll('\\', '/');
    workspaceRe.lastIndex = 0;
    if (!workspaceRe.test(worktree)) return false;
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
    options.coordinatorHandle ?? process.env.ORCH_HANDLE?.trim(),
    options.coordinatorTitleRe ?? compileRegex(process.env.ORCH_TITLE_RE, DEFAULT_ORCHESTRATOR_TITLE_RE),
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
