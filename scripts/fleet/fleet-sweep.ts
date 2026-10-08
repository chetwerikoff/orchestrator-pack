#!/usr/bin/env -S node --experimental-strip-types
import '../toolchain/native-entrypoint-preflight.ts';

import { createHash } from 'node:crypto';
import { runProcessSync } from '../kernel/subprocess.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetContext } from '../lib/target-context.ts';

export type FleetPaneState = 'busy' | 'STOPPED' | 'POLLING' | 'PARKED';

export interface FleetTerminal {
  readonly handle: string;
  readonly title: string;
  readonly worktreePath: string;
  // Set by Orca only for panes that run an agent CLI, not for plain shells.
  readonly agentIdentity?: string;
  readonly branch?: string;
  readonly incarnationId?: string;
  readonly status?: string;
}

export interface FleetPaneObservation extends FleetTerminal {
  readonly state: FleetPaneState;
  readonly lines: readonly string[];
  readonly wait?: string;
  readonly taskBinding?: string;
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
  readPaneWait?(handle: string): FleetPaneWait | undefined;
  writePaneWait?(handle: string, wait: FleetPaneWait): void;
  clearPaneWait?(handle: string): void;
  prunePaneWaits?(handles: ReadonlySet<string>): void;
}

export interface FleetPaneWait {
  readonly binding: string;
  readonly wait: string;
}

export interface FleetSweepOptions {
  readonly projectId?: string;
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
const CHROME_LINE_RE = /^(?:Cursor Agent|OpenCode|Claude Code)(?:\s|$)|^(?:model|context|tokens?)\s*:|^(?:\+\s*)?Thought\s*[·:]/iu;
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

  constructor(projectId: string, env: NodeJS.ProcessEnv = process.env) {
    const runtime = env.XDG_RUNTIME_DIR?.trim();
    if (!runtime) throw new Error('XDG_RUNTIME_DIR is required for fleet-sweep state');
    if (!projectId.trim()) throw new Error('projectId is required for fleet-sweep state');
    this.root = join(runtime, 'fleet-sweep', projectId.trim());
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

  private waitPath(handle: string): string {
    const key = createHash('sha256').update(handle).digest('hex').slice(0, 24);
    return join(this.root, `wait-${key}.json`);
  }

  readPaneWait(handle: string): FleetPaneWait | undefined {
    try {
      const value = JSON.parse(readFileSync(this.waitPath(handle), 'utf8')) as FleetPaneWait;
      return typeof value.binding === 'string' && typeof value.wait === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  writePaneWait(handle: string, wait: FleetPaneWait): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.waitPath(handle), JSON.stringify({ handle, ...wait }), 'utf8');
  }

  clearPaneWait(handle: string): void {
    rmSync(this.waitPath(handle), { force: true });
  }

  prunePaneWaits(handles: ReadonlySet<string>): void {
    if (!existsSync(this.root)) return;
    for (const name of readdirSync(this.root)) {
      if (!/^wait-[0-9a-f]{24}\.json$/u.test(name)) continue;
      try {
        const value = JSON.parse(readFileSync(join(this.root, name), 'utf8')) as { handle?: string };
        if (!value.handle || !handles.has(value.handle)) rmSync(join(this.root, name), { force: true });
      } catch {
        rmSync(join(this.root, name), { force: true });
      }
    }
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
      ...(typeof item.agentIdentity === 'string' && item.agentIdentity ? { agentIdentity: item.agentIdentity } : {}),
      ...(typeof item.branch === 'string' && item.branch ? { branch: item.branch } : {}),
      ...(typeof item.incarnationId === 'string' && item.incarnationId ? { incarnationId: item.incarnationId } : {}),
      ...(typeof item.status === 'string' ? { status: item.status } : {}),
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
  // Orca's CLI header describes this read, not a quoted foreign pane in its screen.
  const boundary = response.stdout.indexOf('\n\n');
  return response.stdout.startsWith(`handle: ${handle}\n`) && boundary >= 0
    ? response.stdout.slice(boundary + 2) : response.stdout;
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

// Only the final own response is an outcome. A park quoted in a tool result, instruction,
// table or older response does not authorize waiting. Wrapped outcome lines are joined.
export function ownPaneOutcome(screen: string): { wait?: string; acknowledgment: boolean } {
  const toolLine = /^(?:Tool:|\$|#\s*Running\b|[→⚙]\s|Click to expand\b|[\[{]|"[^"]+"\s*:|```|===|handle:|source:|(?:[┌└├]\s*)?(?:Bash|Shell|Read|Write|Edit|Grep|Glob)\b|(?:orca|gh|git|node|npm|mise|python|curl|bash|sh)\s)/iu;
  // Raw OpenCode gutters render both incoming messages and own tools. Only a
  // non-tool block advances the incoming boundary; subsequent tool blocks stay own work.
  const rawLines = screen.split(/\r?\n/u);
  let incoming = -1;
  let toolBlock = false;
  for (let index = 0; index < rawLines.length;) {
    if (!/^\s*┃/u.test(rawLines[index]!)) { index += 1; continue; }
    const start = index;
    while (index < rawLines.length && /^\s*┃/u.test(rawLines[index]!)) index += 1;
    const block = rawLines.slice(start, index);
    const first = block.find((raw) => raw.replace(TUI_FRAME_PREFIX_RE, '').trim());
    if (!first || !/^\s*┃[ \t]{2,}/u.test(first)) continue;
    if (toolLine.test(first.replace(TUI_FRAME_PREFIX_RE, '').trim())) toolBlock = true;
    else if (nonChromeLines(block.join('\n')).length > 0) { incoming = index - 1; toolBlock = false; }
  }
  screen = rawLines.slice(incoming + 1).join('\n');
  const paragraphs = screen.split(/\r?\n\s*(?:[┃│]\s*)?\r?\n/u).map((part) => nonChromeLines(part)
    .filter((line) => !/^(?:>|→ Add a follow-up|\d+ tasks?)\s*$/u.test(line))).filter((part) => part.length > 0);
  const lines = paragraphs.at(-1) ?? [];
  const boundary = lines.reduce((last, line, index) => /^(?:>\s+|User:|Assistant:)/iu.test(line) ? index : last, -1);
  const own = boundary < 0 ? lines : /^Assistant:/iu.test(lines[boundary]!)
    ? [lines[boundary]!.replace(/^Assistant:\s*/iu, ''), ...lines.slice(boundary + 1)].filter(Boolean)
    : lines.slice(boundary + 1);
  const start = own.reduce((last, line, index) => /^PARKED(?: on\b|:)/iu.test(line) ? index : last, -1);
  const response = own.slice(Math.max(0, start)).join(' ').trim();
  const context = own.slice(0, Math.max(0, start));
  const newOutcome = /\?\s*$|\b(?:STOPPED|done|finished|handed[- ]off|worker_done|error)\b/iu;
  const foreign = (boundary >= 0 && /^User:/iu.test(lines[boundary]!)) || context.some((line) => toolLine.test(line));
  const superseded = own.slice(Math.max(0, start) + 1).some((line) => toolLine.test(line) || newOutcome.test(line));
  const wait = !foreign && !superseded && /^PARKED(?: on\s+|:\s*(?:wait\s+)?)(.+)$/iu.exec(response)?.[1];
  // The turn, including tool paragraphs before its final summary, must be a short own
  // response with no work or new outcome. Its natural language does not authorize parking.
  const turn = paragraphs.flat();
  const turnBoundary = turn.reduce((last, line, index) => /^(?:>\s+|User:|PARKED(?: on\b|:))/iu.test(line) ? index : last, -1);
  const turnLines = turn.slice(turnBoundary + 1).map((line) => line.replace(/^Assistant:\s*/iu, '')).filter(Boolean);
  const acknowledgment = !foreign && !toolBlock && turnLines.length <= 3
    && !turnLines.some((line) => toolLine.test(line) || newOutcome.test(line));
  return { ...(wait ? { wait: `PARKED on ${wait}` } : {}), acknowledgment };
}

// Use the already-owned Orca task/runtime evidence; screen text never supplies task identity.
function liveTaskBinding(terminal: FleetTerminal, projectId: string, executor: OrcaExecutor): string | undefined {
  const read = (args: readonly string[]): Record<string, unknown> | undefined => {
    const result = executor(args);
    if (!result.ok) return undefined;
    try {
      const receipt = JSON.parse(result.stdout) as { ok?: boolean; result?: Record<string, unknown> };
      return receipt.ok === true ? receipt.result : undefined;
    } catch { return undefined; }
  };
  const rows: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const census = read(['orchestration', 'worker-list', ...(cursor ? ['--cursor', cursor] : []), '--json']);
    const page = census?.page as { hasMore?: boolean; nextCursor?: string } | undefined;
    if (!Array.isArray(census?.workers) || typeof page?.hasMore !== 'boolean') return undefined;
    rows.push(...census.workers.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'));
    if (!page.hasMore) break;
    if (!page.nextCursor || cursors.has(page.nextCursor)) return undefined;
    cursor = page.nextCursor;
    cursors.add(cursor);
  } while (cursor);
  const matches = rows.filter((value) => value.agentTerminalHandle === terminal.handle
    && value.dispatchStatus === 'dispatched');
  if (matches.length !== 1) return undefined;
  const row = matches[0] as { dispatchId?: string; taskId?: string };
  if (!row.dispatchId || !row.taskId) return undefined;
  const worker = read(['orchestration', 'worker-show', '--dispatch', row.dispatchId, '--json']);
  const dispatch = worker?.dispatch as { id?: string; taskId?: string; status?: string } | undefined;
  const observed = worker?.terminal as FleetTerminal | undefined;
  const observation = worker?.observation as { status?: string; exactWorker?: boolean } | undefined;
  if (dispatch?.id !== row.dispatchId || dispatch.taskId !== row.taskId || dispatch.status !== 'dispatched'
    || observation?.status !== 'live' || observation.exactWorker !== true
    || observed?.handle !== terminal.handle || observed.incarnationId !== terminal.incarnationId
    || observed.worktreePath !== terminal.worktreePath || observed.branch !== terminal.branch) return undefined;
  return JSON.stringify([projectId, terminal.handle, terminal.incarnationId, terminal.worktreePath, terminal.branch, row.taskId, row.dispatchId]);
}
export function classifyFleetPane(
  screen: string,
  handle: string,
  store: FleetPollingStore,
  busyRe: RegExp = DEFAULT_BUSY_RE,
): FleetPaneState {
  const busy = isBusyScreen(screen, busyRe);
  if (!busy) {
    store.clearPollingMark(handle);
    return ownPaneOutcome(screen).wait ? 'PARKED' : 'STOPPED';
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
  const store = options.store ?? new FileFleetStateStore(options.projectId ?? '');
  const terminals = options.terminals ?? listFleetTerminals(executor);
  const selected = selectAgentTerminals(
    terminals,
    options.primary,
    options.workspaceRe ?? defaultWorkspaceRegex(options.primary),
    options.coordinatorHandle ?? process.env.ORCH_HANDLE?.trim(),
    options.coordinatorTitleRe ?? compileRegex(process.env.ORCH_TITLE_RE, DEFAULT_ORCHESTRATOR_TITLE_RE),
  );
  const lineCount = options.lines ?? 4;
  store.prunePaneWaits?.(new Set(selected.map((terminal) => terminal.handle)));
  if (!Number.isInteger(lineCount) || lineCount < 0) throw new Error('--lines must be a non-negative integer');
  const busyRe = options.busyRe ?? DEFAULT_BUSY_RE;
  const censusCache = new Map<string, OrcaCommandResult>();
  const bindingExecutor: OrcaExecutor = (args) => {
    if (args[0] !== 'orchestration' || args[1] !== 'worker-list') return executor(args);
    const key = JSON.stringify(args);
    if (!censusCache.has(key)) censusCache.set(key, executor(args));
    return censusCache.get(key)!;
  };

  return selected.map((terminal) => {
    let screen: string;
    try {
      screen = readFleetScreen(terminal.handle, executor);
    } catch (error) {
      store.clearPollingMark(terminal.handle);
      throw error;
    }
    const outcome = ownPaneOutcome(screen);
    const binding = terminal.incarnationId && terminal.status !== 'exited'
      ? liveTaskBinding(terminal, options.projectId ?? '', bindingExecutor)
        ?? JSON.stringify([options.projectId ?? '', terminal.handle, terminal.incarnationId, terminal.worktreePath, terminal.branch])
      : undefined;
    const previous = store.readPaneWait?.(terminal.handle);
    const retained = binding && previous?.binding === binding && outcome.acknowledgment ? previous.wait : undefined;
    const state = classifyFleetPane(screen, terminal.handle, store, busyRe);
    const stale = previous && previous.binding !== binding && previous.wait === outcome.wait;
    const wait = terminal.status !== 'exited' && state !== 'busy' && state !== 'POLLING' && !stale
      ? outcome.wait ?? retained : undefined;
    if (state !== 'busy' && state !== 'POLLING') {
      if (binding && wait) store.writePaneWait?.(terminal.handle, { binding, wait });
      // Keep a mismatched old outcome only as rejection evidence until it leaves the screen.
      else if (!stale) store.clearPaneWait?.(terminal.handle);
    }
    return {
      ...terminal,
      state: wait ? 'PARKED' : state === 'PARKED' ? 'STOPPED' : state,
      ...(wait ? { wait } : {}),
      ...(binding ? { taskBinding: binding } : {}),
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
  projectId: string;
  primary: string;
  workspaceRe: RegExp;
  coordinatorTitleRe: RegExp;
  busyRe?: RegExp;
  lines: number;
  json: boolean;
}

export function parseSweepCli(
  argv: readonly string[],
  _cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): SweepCliOptions {
  let projectId: string | undefined;
  let busyRaw: string | undefined;
  let lines = 4;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project') {
      const value = argv[++index];
      if (!value) throw new Error('--project requires an id');
      projectId = value;
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
      throw new Error('Usage: fleet-sweep [--project <id>] [--busy-re <regex>] [--lines <n>] [--json]');
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  const target = resolveTargetContext({ projectId, env });
  return {
    projectId: target.projectId,
    primary: target.primaryRoot,
    workspaceRe: compileRegex(target.orcaWorkspacePattern, defaultWorkspaceRegex(target.primaryRoot)),
    coordinatorTitleRe: compileRegex(target.orchestratorTitlePattern, DEFAULT_ORCHESTRATOR_TITLE_RE),
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
