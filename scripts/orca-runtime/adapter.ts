import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { runProcessSync } from '../kernel/subprocess.ts';
import { promisify } from 'node:util';
import {
  runtimeFailure,
  runtimeUnsupported,
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeBoundedOutput,
  type RuntimeCallOptions,
  type RuntimeComposerControl,
  type RuntimeComposerControlRequest,
  type RuntimeDispatchResult,
  type RuntimeDispatchWitness,
  type RuntimeInboxCheckResult,
  type RuntimeInboxMessage,
  type RuntimeLivenessResult,
  type RuntimeObservationToken,
  type RuntimeReadiness,
  type RuntimeResult,
  type RuntimeOpenCodeHealth,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
  type RuntimeWorkerProvenance,
  type RuntimeWorkerTaskBindingCallOptions,
  type RuntimeWorkerTaskBindingObservation,
  type RuntimeWorkerTaskBindingOutcome,
} from '../runtime/contracts.ts';
import {
  parseOrcaJsonOutput,
  runOrcaJson,
  resolveOrcaExecutable,
  resolveOrcaOperation,
  type OrcaJsonResponse,
  type OrcaRunOptions,
  type OrcaTerminalHandle,
  type OrcaTerminalReadResult,
  type OrcaTerminalSummary,
  type OrcaTerminalWaitResult,
  type OrcaWorktreeCurrent,
  type OrcaWorktreeShow,
} from './native.ts';

const execFileAsync = promisify(execFile);

const OPEN_CODE_HTTP_SCRIPT = [
  "const [url, method, body] = process.argv.slice(1);",
  "try {",
  "  const response = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body || undefined });",
  "  process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }));",
  "} catch (error) {",
  "  process.stderr.write(error instanceof Error ? error.message : String(error));",
  "  process.exitCode = 1;",
  "}",
].join('\n');

function openCodeUrlFromCommand(command: string): string | undefined {
  if (!/(?:^|\s)opencode(?:\s|$)/iu.test(command)) return undefined;
  const hostname = command.match(/--hostname\s+(?:'([^']+)'|"([^"]+)"|(\S+))/iu);
  const port = command.match(/--port\s+(?:'([1-9]\d*)'|"([1-9]\d*)"|([1-9]\d*))/iu);
  const host = hostname?.[1] ?? hostname?.[2] ?? hostname?.[3];
  const number = port?.[1] ?? port?.[2] ?? port?.[3];
  if (host !== '127.0.0.1' || !number) return undefined;
  return `http://${host}:${number}`;
}

function defaultOpenCodeHttpRequest(input: {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly body?: string;
  readonly timeoutMs: number;
}): { readonly status: number; readonly body: string } {
  const result = runProcessSync({
    command: process.execPath,
    args: ['--input-type=module', '-e', OPEN_CODE_HTTP_SCRIPT, input.url, input.method, input.body ?? ''],
    encoding: 'utf8',
    timeoutMs: input.timeoutMs,
    inheritParentEnv: true,
  });
  if (!result.ok) throw new Error(result.error || result.stderr || 'opencode_http_request_failed');
  const parsed = JSON.parse(result.stdout) as { status?: unknown; body?: unknown };
  const status = parsed.status;
  const body = parsed.body;
  if (typeof status !== 'number' || !Number.isInteger(status) || typeof body !== 'string') throw new Error('opencode_http_response_shape_unsupported');
  return { status, body };
}

function openCodeHttpFailure(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? `opencode_http_request_failed:${error.message.trim()}`
    : 'opencode_http_request_failed';
}

type AsyncExecError = Error & {
  readonly code?: string | number;
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
};

async function runOrcaJsonAsync<T>(
  args: readonly string[],
  options: OrcaRunOptions = {},
): Promise<OrcaJsonResponse<T>> {
  const executable = options.executable ?? resolveOrcaExecutable(options.env);
  const operation = resolveOrcaOperation(args);
  let result: { stdout: string | Buffer; stderr: string | Buffer };
  try {
    result = await execFileAsync(executable, [...args, '--json'], {
      cwd: options.cwd ?? process.cwd(),
      env: options.inheritParentEnv === false ? { ...options.env } : { ...process.env, ...options.env },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: options.killSignal ?? 'SIGKILL' }),
    }) as { stdout: string | Buffer; stderr: string | Buffer };
  } catch (error) {
    const failure = error as AsyncExecError;
    const stdout = failure.stdout === undefined ? '' : String(failure.stdout).trim();
    const childExited = typeof failure.code === 'number';
    if (failure.code !== 'ETIMEDOUT' && failure.stdout !== undefined && (stdout || childExited)) {
      if (!stdout) {
        return {
          ok: false,
          operation,
          outcomeCategory: 'empty_stdout',
          error: {
            code: 'orca_empty_stdout',
            message: String(failure.stderr ?? '').trim() || `orca ${args.join(' ')} produced no output`,
          },
        };
      }
      return parseOrcaJsonOutput<T>(stdout, operation);
    }
    return {
      ok: false,
      operation,
      outcomeCategory: failure.code === 'ETIMEDOUT' ? 'supported_operation_failure' : 'process_launch_failed',
      error: {
        code: failure.code === 'ETIMEDOUT' ? 'orca_operation_timeout' : 'orca_process_launch_failed',
        message: failure.code === 'ETIMEDOUT'
          ? `orca ${args.join(' ')} exceeded ${options.timeoutMs ?? 0}ms`
          : error instanceof Error ? error.message : 'orca process launch failed',
      },
    };
  }
  const stdout = String(result.stdout ?? '').trim();
  if (!stdout) return { ok: false, operation, outcomeCategory: 'empty_stdout', error: { code: 'orca_empty_stdout', message: String(result.stderr ?? '').trim() || `orca ${args.join(' ')} produced no output` } };
  return parseOrcaJsonOutput<T>(stdout, operation);
}

export interface OrcaRuntimeAdapterOptions extends OrcaRunOptions {
  readonly runJson?: typeof runOrcaJson;
  readonly runJsonAsync?: typeof runOrcaJsonAsync;
  readonly now?: () => number;
  readonly openCodeHttpRequest?: (input: {
    readonly url: string;
    readonly method: 'GET' | 'POST';
    readonly body?: string;
    readonly timeoutMs: number;
  }) => { readonly status: number; readonly body: string };
}

interface OwnedWorkerRecord {
  readonly identity: RuntimeWorkerIdentity;
  readonly workspacePath: string;
  readonly workspaceSelector: 'active' | string;
  readonly title: string | null;
  readonly openCodeUrl?: string;
}

interface OpenCodeUrlRecord {
  readonly identity: RuntimeWorkerIdentity;
  readonly url: string;
}

interface OpenCodeSessionRecord {
  readonly id: string;
  readonly directory: string;
}

interface KnownWorkspaceRecord {
  readonly workspaceSelector: 'active' | string;
  readonly workspacePath: string;
}

interface NormalizedTerminalRead {
  readonly lines: readonly string[];
  readonly nativeCursor: string | null;
  readonly terminalState: 'running' | 'exited' | 'unknown';
  readonly source: 'screen' | 'stream' | 'unknown';
}

interface ObservationBinding {
  readonly workerKey: string;
  readonly nativeCursor: string | null;
  readonly source: 'screen' | 'stream' | 'unknown';
}

interface DecodedObservation {
  readonly nativeCursor: string | null;
  readonly source: 'screen' | 'stream' | 'unknown';
}

interface OrcaInboxDeliveryShape {
  readonly run_id?: unknown;
  readonly runId?: unknown;
  readonly delivery_id?: unknown;
  readonly deliveryId?: unknown;
  readonly messages?: unknown;
}

interface OrcaInboxCheckShape extends OrcaInboxDeliveryShape {
  readonly count?: unknown;
  readonly delivery?: unknown;
}

interface OrcaTerminalSendResult {
  readonly send?: {
    readonly accepted?: unknown;
  };
}

const OBSERVATION_TOKEN_PREFIX = 'opk-orca-output-v3.';

export const orcaWorkerTaskBindingStrategy = 'complete_ab_revalidation' as const;
export const orcaWorkerTaskBindingMaxWorktrees = 6 as const;
export const orcaWorkerTaskBindingNativeSliceMs = 250 as const;
export const orcaWorkerTaskBindingMarginMs = 500 as const;
export const orcaLivenessTransportMarginMs = 2_500 as const;
export const orcaWorkerTaskBindingRequiredBudgetMs =
  (2 + (2 * orcaWorkerTaskBindingMaxWorktrees))
  * orcaWorkerTaskBindingNativeSliceMs
  + orcaWorkerTaskBindingMarginMs;

interface OrcaBindingTerminalEvidence {
  readonly handle: string;
  readonly generation: string | null;
  readonly incarnationId: string | null;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly provenance: RuntimeWorkerProvenance;
}

interface OrcaBindingWorktreeEvidence {
  readonly id: string;
  readonly path: string;
  readonly head: string;
  readonly linkedIssue: number | null;
}

interface OrcaBindingSnapshot {
  readonly terminals: readonly OrcaBindingTerminalEvidence[];
  readonly worktrees: ReadonlyMap<string, OrcaBindingWorktreeEvidence>;
}

interface OrcaBindingTerminalListResult {
  readonly terminals?: OrcaTerminalSummary[];
  readonly totalCount: number;
  readonly truncated: boolean;
}

function isNativeTimeout(response: OrcaJsonResponse): boolean {
  return response.error?.code === 'orca_operation_timeout';
}

export function neutralFailureReason(response: OrcaJsonResponse): string {
  if (isNativeTimeout(response)) return 'runtime_timeout';
  switch (response.outcomeCategory) {
    case 'process_launch_failed':
      return 'runtime_unavailable';
    case 'empty_stdout':
    case 'invalid_json':
      return 'runtime_response_invalid';
    case 'recognized_control_plane_code':
      return 'runtime_control_unavailable';
    case 'supported_operation_failure':
    default:
      return 'runtime_operation_failed';
  }
}

function nativeGeneration(terminal: OrcaTerminalSummary | OrcaTerminalHandle): string | null {
  const generation = terminal.incarnationId?.trim() || terminal.ptyId?.trim();
  return generation || null;
}

function identityKey(identity: RuntimeWorkerIdentity): string {
  return `${identity.runtime}\u0000${identity.id}\u0000${identity.generation}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveIssueNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function sameBindingWorktree(
  left: OrcaBindingWorktreeEvidence,
  right: OrcaBindingWorktreeEvidence,
): boolean {
  return left.id === right.id
    && left.path === right.path
    && left.head === right.head
    && left.linkedIssue === right.linkedIssue;
}

function normalizeInboxMessage(value: unknown): RuntimeInboxMessage | null {
  const raw = asRecord(value);
  const type = nonEmptyString(raw?.type);
  if (!raw || !type) return null;
  const subject = typeof raw.subject === 'string' ? raw.subject : undefined;
  const body = typeof raw.body === 'string' ? raw.body : undefined;
  return {
    type,
    ...(subject === undefined ? {} : { subject }),
    ...(body === undefined ? {} : { body }),
    ...('payload' in raw ? { payload: raw.payload } : {}),
  };
}

function normalizeInboxCheck(
  runId: string,
  result: OrcaInboxCheckShape | undefined,
): RuntimeInboxCheckResult {
  if (!result || typeof result !== 'object') {
    return { status: 'unsupported', reason: 'runtime_inbox_shape_unsupported' };
  }

  const topRunId = nonEmptyString(result.run_id) ?? nonEmptyString(result.runId);
  if (topRunId && topRunId !== runId) {
    return { status: 'unknown', reason: 'runtime_inbox_run_mismatch' };
  }

  if (result.count === 0 && result.delivery === undefined && result.messages === undefined) {
    return topRunId === runId
      ? { status: 'empty', runId }
      : { status: 'unknown', reason: 'runtime_inbox_run_identity_unproven' };
  }

  const deliveryRaw = asRecord(result.delivery) ?? result as unknown as Record<string, unknown>;
  const delivery = deliveryRaw as OrcaInboxDeliveryShape;
  const deliveryRunId = nonEmptyString(delivery.run_id) ?? nonEmptyString(delivery.runId) ?? topRunId;
  const deliveryId = nonEmptyString(delivery.delivery_id) ?? nonEmptyString(delivery.deliveryId);
  if (!deliveryRunId || deliveryRunId !== runId) {
    return { status: 'unknown', reason: 'runtime_inbox_run_identity_unproven' };
  }
  if (!deliveryId || !Array.isArray(delivery.messages) || delivery.messages.length === 0) {
    return { status: 'unsupported', reason: 'runtime_inbox_delivery_shape_unsupported' };
  }

  const messages: RuntimeInboxMessage[] = [];
  for (const value of delivery.messages) {
    const message = normalizeInboxMessage(value);
    if (!message) {
      return { status: 'unsupported', reason: 'runtime_inbox_message_shape_unsupported' };
    }
    messages.push(message);
  }
  return {
    status: 'delivery',
    delivery: { runId, deliveryId, messages },
  };
}

function normalizeTerminalRead(
  result: OrcaTerminalReadResult | undefined,
  requireScreen = false,
): RuntimeResult<NormalizedTerminalRead> {
  const current = result?.terminal;
  if (current) {
    if (!Array.isArray(current.tail)
      || !current.tail.every((line) => typeof line === 'string')
      || (current.nextCursor !== null && typeof current.nextCursor !== 'string')
      || (current.latestCursor !== undefined && typeof current.latestCursor !== 'string')
      || !['running', 'exited', 'unknown'].includes(current.status ?? '')) {
      return runtimeUnsupported('read_bounded_output', 'runtime_output_shape_unsupported');
    }
    const currentSource = (current as { source?: unknown }).source;
    const source = currentSource === 'screen' || currentSource === 'stream' || currentSource === 'unknown'
      ? currentSource
      : 'unknown';
    if (requireScreen && source !== 'screen') {
      return runtimeUnsupported('read_bounded_output', 'runtime_output_source_unobservable');
    }
    const nativeCursor = source === 'screen'
      ? null
      : current.nextCursor ?? current.latestCursor ?? null;
    if (nativeCursor === null && source !== 'screen') {
      return runtimeUnsupported('read_bounded_output', 'runtime_output_progress_unavailable');
    }
    return {
      status: 'ok',
      value: {
        lines: current.tail,
        nativeCursor,
        terminalState: current.status!,
        source,
      },
    };
  }

  if (!Array.isArray(result?.lines)
    || !result.lines.every((line) => typeof line === 'string')
    || !('nextCursor' in (result ?? {}))
    || (result.nextCursor !== null
      && typeof result.nextCursor !== 'string'
      && typeof result.nextCursor !== 'number')) {
    return runtimeUnsupported('read_bounded_output', 'runtime_output_shape_unsupported');
  }
  const resultSource = (result as { source?: unknown }).source;
  const source = resultSource === 'screen' || resultSource === 'stream' || resultSource === 'unknown'
    ? resultSource
    : 'unknown';
  if (result.nextCursor === null && source !== 'screen') {
    return runtimeUnsupported('read_bounded_output', 'runtime_output_progress_unavailable');
  }
  if (requireScreen && source !== 'screen') {
    return runtimeUnsupported('read_bounded_output', 'runtime_output_source_unobservable');
  }
  return {
    status: 'ok',
    value: {
      lines: result.lines,
      nativeCursor: source === 'screen' ? null : String(result.nextCursor),
      terminalState: 'unknown',
      source,
    },
  };
}

export class OrcaRuntimeAdapter implements RuntimeAdapter {
  readonly id = 'orca' as const;
  readonly #options: OrcaRuntimeAdapterOptions;
  readonly #now: () => number;
  readonly #owned = new Map<string, OwnedWorkerRecord>();
  readonly #openCodeUrls = new Map<string, OpenCodeUrlRecord>();
  readonly #knownWorkspace = new Map<string, KnownWorkspaceRecord>();
  readonly #observations = new Map<string, ObservationBinding>();

  constructor(options: OrcaRuntimeAdapterOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  #run<T>(args: readonly string[], options: RuntimeCallOptions = {}): OrcaJsonResponse<T> {
    const run = this.#options.runJson ?? runOrcaJson;
    return run<T>(args, {
      cwd: options.cwd ?? this.#options.cwd,
      timeoutMs: options.timeoutMs ?? this.#options.timeoutMs,
      executable: this.#options.executable,
      runner: this.#options.runner,
      env: this.#options.env,
      killSignal: this.#options.killSignal,
    });
  }

  async #runAsync<T>(args: readonly string[], options: RuntimeCallOptions = {}): Promise<OrcaJsonResponse<T>> {
    const run: <U>(
      input: readonly string[],
      inputOptions: OrcaRunOptions,
    ) => Promise<OrcaJsonResponse<U>> = this.#options.runJsonAsync
      ?? (this.#options.runJson && this.#options.runJson !== runOrcaJson
        ? async <U>(input: readonly string[], inputOptions: OrcaRunOptions) => this.#options.runJson!(input, inputOptions)
        : runOrcaJsonAsync);
    return run<T>(args, {
      cwd: options.cwd ?? this.#options.cwd,
      timeoutMs: options.timeoutMs ?? this.#options.timeoutMs,
      executable: this.#options.executable,
      env: this.#options.env,
      killSignal: this.#options.killSignal,
    });
  }

  #openCodeRequest(input: {
    readonly url: string;
    readonly method: 'GET' | 'POST';
    readonly body?: string;
    readonly timeoutMs: number;
  }): { readonly status: number; readonly body: string } | { readonly error: string } {
    try {
      const request = this.#options.openCodeHttpRequest ?? defaultOpenCodeHttpRequest;
      return request(input);
    } catch (error) {
      return { error: openCodeHttpFailure(error) };
    }
  }

  #openCodeDispatch(
    worker: RuntimeWorkerIdentity,
    request: RuntimeComposerControlRequest,
    options: RuntimeCallOptions = {},
  ): RuntimeDispatchResult {
    const current = this.findWorker(worker, options);
    if (current.status !== 'ok') return { status: 'send_failed', reason: current.reason };
    if (current.value === null) return { status: 'send_failed', reason: 'worker_generation_not_found' };
    const urlRecord = this.#openCodeUrls.get(worker.id);
    if (!urlRecord || !sameRuntimeWorker(urlRecord.identity, current.value.identity)) {
      return { status: 'send_failed', reason: 'runtime_opencode_control_unavailable' };
    }
    if (request.action !== 'submit-prompt' || typeof request.text !== 'string' || !request.text) {
      return { status: 'send_failed', reason: 'runtime_opencode_prompt_request_invalid' };
    }
    const sessions = this.#openCodeRequest({
      url: `${urlRecord.url}/session?directory=${encodeURIComponent(current.value.workspacePath)}`,
      method: 'GET',
      timeoutMs: Math.max(1, options.timeoutMs ?? 10_000),
    });
    if ('error' in sessions) return { status: 'send_failed', reason: sessions.error };
    if (sessions.status < 200 || sessions.status >= 300) {
      return { status: 'send_failed', reason: `opencode_http_status_${sessions.status}` };
    }
    let parsedSessions: unknown;
    try {
      parsedSessions = JSON.parse(sessions.body);
    } catch {
      return { status: 'send_failed', reason: 'opencode_session_schema_mismatch' };
    }
    if (!Array.isArray(parsedSessions)) {
      return { status: 'send_failed', reason: 'opencode_session_schema_mismatch' };
    }
    const matchingSessions: OpenCodeSessionRecord[] = [];
    for (const value of parsedSessions) {
      if (!value || typeof value !== 'object') continue;
      const row = value as { id?: unknown; directory?: unknown };
      if (typeof row.id === 'string' && /^ses/u.test(row.id)
        && row.directory === current.value.workspacePath) {
        matchingSessions.push({ id: row.id, directory: row.directory });
      }
    }
    if (matchingSessions.length !== 1) {
      return { status: 'send_failed', reason: 'runtime_opencode_session_unavailable' };
    }
    const response = this.#openCodeRequest({
      url: `${urlRecord.url}/session/${encodeURIComponent(matchingSessions[0]!.id)}/prompt_async?directory=${encodeURIComponent(current.value.workspacePath)}`,
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text: request.text }] }),
      timeoutMs: Math.max(1, options.timeoutMs ?? 10_000),
    });
    if ('error' in response) return { status: 'send_failed', reason: response.error };
    if (response.status !== 204) {
      return { status: 'send_failed', reason: `opencode_http_status_${response.status}` };
    }
    return {
      status: 'dispatched',
      witness: { operation: 'submit', accepted: true, source: 'runtime-response' },
    };
  }

  #rememberWorkspace(
    identity: RuntimeWorkerIdentity,
    workspaceSelector: 'active' | string,
    workspacePath: string,
  ): void {
    this.#knownWorkspace.set(identityKey(identity), { workspaceSelector, workspacePath });
  }

  #rememberOpenCodeUrl(identity: RuntimeWorkerIdentity, url: string): void {
    this.#openCodeUrls.set(identity.id, { identity, url });
    const owned = this.#owned.get(identity.id);
    if (owned?.openCodeUrl) {
      this.#owned.set(identity.id, { ...owned, identity, openCodeUrl: url });
    }
  }

  #remaining(deadline: number): number {
    return Math.max(0, Math.floor(deadline - this.#now()));
  }

  #boundedOptions(
    deadline: number,
    options: RuntimeCallOptions,
  ): RuntimeCallOptions | null {
    const remaining = this.#remaining(deadline);
    if (remaining <= 0) return null;
    const requested = options.timeoutMs;
    const requestedLimit = requested !== undefined
      && Number.isFinite(requested)
      && requested > 0
      ? Math.floor(requested)
      : remaining;
    return {
      ...options,
      timeoutMs: Math.max(1, Math.min(remaining, requestedLimit)),
    };
  }

  #bindingCallOptions(
    deadline: number,
    options: RuntimeWorkerTaskBindingCallOptions,
  ): RuntimeCallOptions | null {
    const remaining = this.#remaining(deadline);
    if (remaining <= 0) return null;
    return {
      ...options,
      timeoutMs: Math.max(
        1,
        Math.min(orcaWorkerTaskBindingNativeSliceMs, remaining),
      ),
    };
  }

  #bindingTerminalCensus(
    deadline: number,
    options: RuntimeWorkerTaskBindingCallOptions,
  ): { readonly status: 'ok'; readonly value: readonly OrcaBindingTerminalEvidence[] }
    | { readonly status: 'unavailable'; readonly code: 'deadline_exhausted' | 'malformed_or_incomplete' | 'inventory_ambiguous' } {
    const callOptions = this.#bindingCallOptions(deadline, options);
    if (!callOptions) return { status: 'unavailable', code: 'deadline_exhausted' };
    const response = this.#run<OrcaBindingTerminalListResult>(['terminal', 'list'], callOptions);
    if (!response.ok) {
      return {
        status: 'unavailable',
        code: isNativeTimeout(response) ? 'deadline_exhausted' : 'inventory_ambiguous',
      };
    }
    const terminals = response.result?.terminals;
    const totalCount = response.result?.totalCount;
    const truncated = response.result?.truncated;
    if (!Array.isArray(terminals)
      || truncated !== false
      || !Number.isInteger(totalCount)
      || totalCount !== terminals.length) {
      return { status: 'unavailable', code: 'malformed_or_incomplete' };
    }
    const normalized: OrcaBindingTerminalEvidence[] = [];
    for (const terminal of terminals) {
      const handle = nonEmptyString(terminal.handle);
      const worktreeId = nonEmptyString(terminal.worktreeId);
      const worktreePath = nonEmptyString(terminal.worktreePath);
      if (!handle || !worktreeId || !worktreePath) {
        return { status: 'unavailable', code: 'malformed_or_incomplete' };
      }
      const generation = nativeGeneration(terminal);
      const incarnationId = nonEmptyString(terminal.incarnationId);
      const identity = generation
        ? { runtime: 'orca', id: handle, generation }
        : null;
      const owned = this.#owned.get(handle);
      normalized.push({
        handle,
        generation,
        incarnationId,
        worktreeId,
        worktreePath,
        provenance: identity && owned && sameRuntimeWorker(owned.identity, identity)
          ? 'internal'
          : 'external',
      });
    }
    return { status: 'ok', value: normalized };
  }

  #bindingWorktreeCensus(
    terminals: readonly OrcaBindingTerminalEvidence[],
    deadline: number,
    options: RuntimeWorkerTaskBindingCallOptions,
    revalidation: boolean,
  ): { readonly status: 'ok'; readonly value: ReadonlyMap<string, OrcaBindingWorktreeEvidence> }
    | { readonly status: 'unavailable'; readonly code: 'deadline_exhausted' | 'task_metadata_unavailable' | 'snapshot_revalidation_unavailable' | 'inventory_ambiguous' } {
    const paths = [...new Set(terminals.map((terminal) => terminal.worktreePath))].sort();
    if (paths.length > orcaWorkerTaskBindingMaxWorktrees) {
      return { status: 'unavailable', code: 'inventory_ambiguous' };
    }
    const worktrees = new Map<string, OrcaBindingWorktreeEvidence>();
    for (const worktreePath of paths) {
      const callOptions = this.#bindingCallOptions(deadline, options);
      if (!callOptions) return { status: 'unavailable', code: 'deadline_exhausted' };
      const shown = this.#run<OrcaWorktreeShow>(
        ['worktree', 'show', '--worktree', `path:${worktreePath}`],
        callOptions,
      );
      if (!shown.ok) {
        return {
          status: 'unavailable',
          code: isNativeTimeout(shown)
            ? 'deadline_exhausted'
            : revalidation ? 'snapshot_revalidation_unavailable' : 'task_metadata_unavailable',
        };
      }
      const raw = shown.result?.worktree;
      const id = nonEmptyString(raw?.id);
      const path = nonEmptyString(raw?.path);
      const head = nonEmptyString(raw?.head);
      const linkedIssue = positiveIssueNumber(raw?.linkedIssue);
      if (!id || !path || !head || linkedIssue === undefined) {
        return {
          status: 'unavailable',
          code: revalidation ? 'snapshot_revalidation_unavailable' : 'task_metadata_unavailable',
        };
      }
      if (path !== worktreePath || worktrees.has(path)) {
        return { status: 'unavailable', code: 'inventory_ambiguous' };
      }
      worktrees.set(path, { id, path, head, linkedIssue });
    }
    for (const terminal of terminals) {
      const worktree = worktrees.get(terminal.worktreePath);
      if (!worktree || worktree.id !== terminal.worktreeId) {
        return { status: 'unavailable', code: 'inventory_ambiguous' };
      }
    }
    return { status: 'ok', value: worktrees };
  }

  #resolveObservation(
    worker: RuntimeWorkerIdentity,
    token: RuntimeObservationToken,
  ): RuntimeResult<DecodedObservation> {
    if (!token.opaque.startsWith(OBSERVATION_TOKEN_PREFIX)) {
      return runtimeUnsupported('read_bounded_output', 'observation_token_unsupported');
    }
    const binding = this.#observations.get(token.opaque);
    if (!binding) {
      return runtimeUnsupported('read_bounded_output', 'observation_token_unsupported');
    }
    if (binding.workerKey !== identityKey(worker)) {
      return runtimeFailure('read_bounded_output', 'observation_token_scope_mismatch');
    }
    return {
      status: 'ok',
      value: { nativeCursor: binding.nativeCursor, source: binding.source },
    };
  }

  #observationToken(
    worker: RuntimeWorkerIdentity,
    nativeCursor: string | null,
    source: 'screen' | 'stream' | 'unknown',
    changed: boolean,
    previousToken?: RuntimeObservationToken | null,
  ): RuntimeObservationToken {
    if (previousToken && !changed) return previousToken;
    const token = { opaque: `${OBSERVATION_TOKEN_PREFIX}${randomUUID()}` };
    this.#observations.set(token.opaque, {
      workerKey: identityKey(worker),
      nativeCursor,
      source,
    });
    return token;
  }

  #dropObservations(worker: RuntimeWorkerIdentity): void {
    const workerKey = identityKey(worker);
    for (const [token, binding] of this.#observations) {
      if (binding.workerKey === workerKey) this.#observations.delete(token);
    }
  }

  #workerFromTerminal(
    terminal: OrcaTerminalSummary,
    workspaceSelector: 'active' | string,
    operation: 'list_workers' | 'find_worker_by_id',
  ): RuntimeResult<RuntimeWorker> {
    const handle = terminal.handle?.trim();
    const workspacePath = terminal.worktreePath?.trim();
    if (!handle || !workspacePath) {
      return runtimeUnsupported(operation, 'runtime_worker_identity_missing');
    }
    const generation = nativeGeneration(terminal);
    if (!generation) {
      return runtimeUnsupported(operation, 'runtime_worker_generation_missing');
    }

    const owned = this.#owned.get(handle);
    if (owned && generation !== owned.identity.generation) {
      this.#owned.delete(handle);
      this.#dropObservations(owned.identity);
    }
    const currentOwned = this.#owned.get(handle);
    const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: handle, generation };
    const openCodeUrl = typeof terminal.command === 'string'
      ? openCodeUrlFromCommand(terminal.command)
      : undefined;
    if (openCodeUrl) this.#rememberOpenCodeUrl(identity, openCodeUrl);
    const worker: RuntimeWorker = {
      identity,
      workspacePath,
      title: typeof terminal.title === 'string' ? terminal.title : null,
      provenance: currentOwned && sameRuntimeWorker(currentOwned.identity, identity)
        ? 'internal'
        : 'external',
    };
    this.#rememberWorkspace(identity, workspaceSelector, workspacePath);
    return { status: 'ok', value: worker };
  }

  composerControl(
    worker: RuntimeWorkerIdentity,
  ): RuntimeComposerControl | undefined {
    let record = this.#openCodeUrls.get(worker.id);
    if (!record || !sameRuntimeWorker(record.identity, worker)) {
      const current = this.findWorker(worker);
      record = current.status === 'ok' && current.value && sameRuntimeWorker(current.value.identity, worker)
        ? this.#openCodeUrls.get(worker.id)
        : undefined;
    }
    if (!record || !sameRuntimeWorker(record.identity, worker)) return undefined;
    return {
      kind: 'opencode-http',
      dispatch: (request, options) => this.#openCodeDispatch(worker, request, options),
    };
  }

  openCodeHealth(
    worker: RuntimeWorkerIdentity,
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeOpenCodeHealth> {
    const deadline = this.#now() + Math.max(1, options.timeoutMs ?? 10_000);
    const currentOptions = this.#boundedOptions(deadline, options);
    if (!currentOptions) return runtimeFailure('readiness', 'runtime_timeout');
    const current = this.findWorker(worker, currentOptions);
    if (current.status !== 'ok') return current;
    if (current.value === null) return runtimeFailure('readiness', 'worker_generation_not_found');
    const urlRecord = this.#openCodeUrls.get(worker.id);
    if (!urlRecord || !sameRuntimeWorker(urlRecord.identity, current.value.identity)) {
      return runtimeUnsupported('readiness', 'runtime_opencode_control_unavailable');
    }
    const healthOptions = this.#boundedOptions(deadline, options);
    if (!healthOptions) return runtimeFailure('readiness', 'runtime_timeout');
    const response = this.#openCodeRequest({
      url: `${urlRecord.url}/global/health`,
      method: 'GET',
      timeoutMs: healthOptions.timeoutMs!,
    });
    if ('error' in response) return runtimeFailure('readiness', response.error);
    if (response.status < 200 || response.status >= 300) {
      return runtimeFailure('readiness', `opencode_http_status_${response.status}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(response.body); } catch { return runtimeUnsupported('readiness', 'opencode_health_schema_mismatch'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return runtimeUnsupported('readiness', 'opencode_health_schema_mismatch');
    }
    const health = parsed as Record<string, unknown>;
    if (health.healthy !== true || typeof health.version !== 'string' || !health.version.trim()) {
      return runtimeUnsupported('readiness', 'opencode_health_schema_mismatch');
    }
    return {
      status: 'ok',
      value: { healthy: true, version: health.version.trim() },
    };
  }

  readiness(options: RuntimeCallOptions = {}): RuntimeResult<RuntimeReadiness> {
    const current = this.#run<OrcaWorktreeCurrent>(['worktree', 'current'], options);
    const fromCurrent = this.#readinessFromWorktree(current);
    if (fromCurrent.status === 'ok') return fromCurrent;

    const cwd = (options.cwd ?? this.#options.cwd)?.trim();
    if (cwd) {
      const shown = this.#run<OrcaWorktreeShow>(
        ['worktree', 'show', '--worktree', `path:${cwd}`],
        options,
      );
      const fromShown = this.#readinessFromWorktree(shown);
      if (fromShown.status === 'ok') return fromShown;
    }

    if (!current.ok) {
      return runtimeFailure('readiness', neutralFailureReason(current));
    }
    return runtimeUnsupported('readiness', 'runtime_workspace_path_missing');
  }

  #readinessFromWorktree(
    response: OrcaJsonResponse<OrcaWorktreeCurrent | OrcaWorktreeShow>,
  ): RuntimeResult<RuntimeReadiness> {
    if (!response.ok) {
      return runtimeFailure('readiness', neutralFailureReason(response));
    }
    const path = response.result?.worktree?.path?.trim();
    if (!path) {
      return runtimeUnsupported('readiness', 'runtime_workspace_path_missing');
    }
    const headSha = response.result?.worktree?.head?.trim();
    return {
      status: 'ok',
      value: {
        ready: true,
        workspacePath: path,
        ...(headSha ? { headSha } : {}),
        linkedIssue: response.result?.worktree?.linkedIssue ?? null,
      },
    };
  }

  listWorkers(
    input: { readonly workspace?: 'active' | string },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<readonly RuntimeWorker[]> {
    const workspace = input.workspace ?? 'active';
    const response = this.#run<{ terminals?: OrcaTerminalSummary[] }>(
      ['terminal', 'list', '--worktree', workspace],
      options,
    );
    if (!response.ok) {
      return runtimeFailure('list_workers', neutralFailureReason(response));
    }
    const terminals = response.result?.terminals;
    if (!Array.isArray(terminals)) {
      return runtimeUnsupported('list_workers', 'runtime_worker_list_shape_unsupported');
    }
    const workers: RuntimeWorker[] = [];
    for (const terminal of terminals) {
      const normalized = this.#workerFromTerminal(terminal, workspace, 'list_workers');
      if (normalized.status !== 'ok') return normalized;
      workers.push(normalized.value);
    }
    return { status: 'ok', value: workers };
  }

  async listWorkersAsync(
    _input: { readonly workspace?: 'active' | string } = {},
    options: RuntimeCallOptions = {},
  ): Promise<RuntimeResult<readonly RuntimeWorker[]>> {
    const response = await this.#runAsync<{ terminals?: OrcaTerminalSummary[] }>(
      ['terminal', 'list'],
      options,
    );
    if (!response.ok) return runtimeFailure('list_workers', neutralFailureReason(response));
    const terminals = response.result?.terminals;
    if (!Array.isArray(terminals)) {
      return runtimeUnsupported('list_workers', 'runtime_worker_list_shape_unsupported');
    }
    const workers: RuntimeWorker[] = [];
    for (const terminal of terminals) {
      const selector = terminal.worktreePath?.trim() || 'active';
      const normalized = this.#workerFromTerminal(terminal, selector, 'list_workers');
      if (normalized.status !== 'ok') return normalized;
      workers.push(normalized.value);
    }
    return { status: 'ok', value: workers };
  }

  findWorkerById(
    id: string,
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker | null> {
    const handle = id.trim();
    if (!handle) {
      return runtimeFailure('find_worker_by_id', 'runtime_worker_id_missing');
    }
    const response = this.#run<{ terminal?: OrcaTerminalSummary }>(
      ['terminal', 'show', '--terminal', handle],
      options,
    );
    if (!response.ok) {
      return runtimeFailure('find_worker_by_id', neutralFailureReason(response));
    }
    const terminal = response.result?.terminal;
    if (!terminal) {
      return runtimeUnsupported('find_worker_by_id', 'runtime_worker_show_shape_unsupported');
    }
    return this.#workerFromTerminal(
      terminal,
      terminal.worktreePath?.trim() || 'active',
      'find_worker_by_id',
    );
  }

  findWorker(
    identity: RuntimeWorkerIdentity,
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker | null> {
    if (identity.runtime !== 'orca') {
      return runtimeFailure('find_worker', 'runtime_identity_mismatch');
    }
    const known = this.#knownWorkspace.get(identityKey(identity));
    const owned = this.#owned.get(identity.id);
    const workspace = known?.workspaceSelector ?? owned?.workspaceSelector;
    if (workspace) {
      const listed = this.listWorkers({ workspace }, options);
      if (listed.status !== 'ok') return listed;
      return {
        status: 'ok',
        value: listed.value.find((worker) => sameRuntimeWorker(worker.identity, identity)) ?? null,
      };
    }
    const current = this.findWorkerById(identity.id, options);
    if (current.status !== 'ok') return current;
    return {
      status: 'ok',
      value: current.value && sameRuntimeWorker(current.value.identity, identity)
        ? current.value
        : null,
    };
  }

  observeWorkerTaskBindings(
    input: { readonly workers: readonly RuntimeWorkerIdentity[] },
    options: RuntimeWorkerTaskBindingCallOptions,
  ): RuntimeWorkerTaskBindingObservation {
    const workers = [...input.workers];
    if (workers.length > 256
      || workers.some((worker) => !worker.id.trim() || !worker.generation.trim() || !worker.runtime.trim())
      || workers.some((worker, index) => workers.slice(0, index).some((prior) => sameRuntimeWorker(prior, worker)))) {
      return { status: 'unavailable', code: 'malformed_or_incomplete' };
    }
    if (!Number.isFinite(options.timeoutMs)
      || options.timeoutMs < orcaWorkerTaskBindingRequiredBudgetMs) {
      return { status: 'unavailable', code: 'deadline_exhausted' };
    }

    const deadline = this.#now() + Math.floor(options.timeoutMs);
    const terminalA = this.#bindingTerminalCensus(deadline, options);
    if (terminalA.status !== 'ok') return terminalA;
    const pathsA = new Set(terminalA.value.map((terminal) => terminal.worktreePath));
    if (pathsA.size > orcaWorkerTaskBindingMaxWorktrees) {
      return { status: 'unavailable', code: 'inventory_over_cap' };
    }
    const worktreeA = this.#bindingWorktreeCensus(terminalA.value, deadline, options, false);
    if (worktreeA.status !== 'ok') {
      if (worktreeA.code === 'inventory_ambiguous') {
        return { status: 'unavailable', code: 'inventory_ambiguous' };
      }
      return worktreeA;
    }

    const terminalB = this.#bindingTerminalCensus(deadline, options);
    if (terminalB.status !== 'ok') {
      return terminalB.code === 'deadline_exhausted'
        ? terminalB
        : { status: 'unavailable', code: 'snapshot_revalidation_unavailable' };
    }
    const allPaths = new Set([
      ...terminalA.value.map((terminal) => terminal.worktreePath),
      ...terminalB.value.map((terminal) => terminal.worktreePath),
    ]);
    if (allPaths.size > orcaWorkerTaskBindingMaxWorktrees) {
      return { status: 'unavailable', code: 'inventory_over_cap' };
    }
    const pathsB = new Set(terminalB.value.map((terminal) => terminal.worktreePath));
    const unionTerminals = [
      ...terminalB.value,
      ...terminalA.value.filter((terminal) => !pathsB.has(terminal.worktreePath)),
    ];
    const worktreeB = this.#bindingWorktreeCensus(unionTerminals, deadline, options, true);
    if (worktreeB.status !== 'ok') {
      if (worktreeB.code === 'inventory_ambiguous') {
        return { status: 'unavailable', code: 'inventory_ambiguous' };
      }
      return worktreeB;
    }
    if (this.#remaining(deadline) < orcaWorkerTaskBindingMarginMs) {
      return { status: 'unavailable', code: 'deadline_exhausted' };
    }

    const terminalMatches = (
      terminals: readonly OrcaBindingTerminalEvidence[],
      worker: RuntimeWorkerIdentity,
    ): readonly OrcaBindingTerminalEvidence[] => terminals.filter((terminal) => terminal.handle === worker.id);
    const issueClaimCount = (
      snapshot: OrcaBindingSnapshot,
      issueNumber: number,
    ): number => snapshot.terminals.filter((terminal) =>
      snapshot.worktrees.get(terminal.worktreePath)?.linkedIssue === issueNumber).length;
    const snapshotA: OrcaBindingSnapshot = { terminals: terminalA.value, worktrees: worktreeA.value };
    const snapshotB: OrcaBindingSnapshot = { terminals: terminalB.value, worktrees: worktreeB.value };

    const outcomes: RuntimeWorkerTaskBindingOutcome[] = workers.map((worker) => {
      if (worker.runtime !== 'orca') return { status: 'identity_unresolved', worker };
      const matchesA = terminalMatches(snapshotA.terminals, worker);
      if (matchesA.length === 0) return { status: 'absent', worker };
      if (matchesA.length > 1) return { status: 'ambiguous', worker, code: 'duplicate_identity' };
      const a = matchesA[0]!;
      if (!a.generation || a.generation !== worker.generation) return { status: 'replaced', worker };
      if (!a.incarnationId) return { status: 'incarnation_unavailable', worker };
      if (a.incarnationId !== worker.generation) return { status: 'replaced', worker };

      const matchesB = terminalMatches(snapshotB.terminals, worker);
      if (matchesB.length === 0) {
        return { status: 'stale', worker, code: 'disappeared_after_initial' };
      }
      if (matchesB.length > 1) return { status: 'ambiguous', worker, code: 'duplicate_identity' };
      const b = matchesB[0]!;
      if (!b.generation || b.generation !== worker.generation) return { status: 'replaced', worker };
      if (!b.incarnationId) return { status: 'incarnation_unavailable', worker };
      if (b.incarnationId !== worker.generation) return { status: 'replaced', worker };

      const taskA = snapshotA.worktrees.get(a.worktreePath);
      const taskB = snapshotB.worktrees.get(b.worktreePath);
      if (!taskA || !taskB) return { status: 'ambiguous', worker, code: 'workspace_task_conflict' };
      const issueA = taskA.linkedIssue;
      const issueB = taskB.linkedIssue;
      const duplicateIssue = (issueA !== null && issueClaimCount(snapshotA, issueA) > 1)
        || (issueB !== null && issueClaimCount(snapshotB, issueB) > 1);
      if (duplicateIssue) return { status: 'ambiguous', worker, code: 'duplicate_issue' };
      if (a.provenance !== b.provenance) {
        return { status: 'ambiguous', worker, code: 'provenance_conflict' };
      }
      if (a.worktreeId !== b.worktreeId
        || a.worktreePath !== b.worktreePath
        || !sameBindingWorktree(taskA, taskB)) {
        return { status: 'stale', worker, code: 'metadata_changed' };
      }
      if (a.provenance === 'external') return { status: 'external', worker, provenance: 'external' };
      if (issueA === null) return { status: 'unbound', worker, provenance: 'internal' };
      return { status: 'bound', worker, issueNumber: issueA, provenance: 'internal' };
    });
    return { status: 'ok', outcomes };
  }

  spawnWorker(
    input: {
      readonly title: string;
      readonly command: string;
      readonly workspace?: 'active' | string;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker> {
    const workspace = input.workspace ?? 'active';
    const response = this.#run<{ terminal?: OrcaTerminalHandle }>(
      ['terminal', 'create', '--worktree', workspace, '--title', input.title, '--command', input.command],
      options,
    );
    if (!response.ok) {
      return runtimeFailure('spawn_worker', neutralFailureReason(response));
    }
    const terminal = response.result?.terminal;
    const handle = terminal?.handle?.trim();
    if (!terminal || !handle) {
      return runtimeUnsupported('spawn_worker', 'runtime_worker_create_shape_unsupported');
    }

    let generation = nativeGeneration(terminal);
    let discoveredWorkspacePath: string | null = null;
    if (!generation) {
      const listed = this.listWorkers({ workspace }, options);
      if (listed.status !== 'ok') return listed;
      const discovered = listed.value.find((candidate) => candidate.identity.id === handle);
      if (!discovered) {
        return runtimeUnsupported('spawn_worker', 'runtime_worker_generation_unresolved');
      }
      generation = discovered.identity.generation;
      discoveredWorkspacePath = discovered.workspacePath;
    }

    const readiness = workspace === 'active' ? this.readiness(options) : null;
    const workspacePath = workspace === 'active'
      ? readiness?.status === 'ok'
        ? readiness.value.workspacePath
        : options.cwd ?? this.#options.cwd ?? process.cwd()
      : workspace;
    const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: handle, generation };
    const worker: RuntimeWorker = {
      identity,
      workspacePath: discoveredWorkspacePath ?? workspacePath,
      title: terminal.title ?? input.title,
      provenance: 'internal',
    };
    const openCodeUrl = openCodeUrlFromCommand(input.command);
    this.#owned.set(handle, {
      identity,
      workspacePath: worker.workspacePath,
      workspaceSelector: workspace,
      title: worker.title,
      ...(openCodeUrl ? { openCodeUrl } : {}),
    });
    if (openCodeUrl) this.#rememberOpenCodeUrl(identity, openCodeUrl);
    this.#rememberWorkspace(identity, workspace, worker.workspacePath);
    return { status: 'ok', value: worker };
  }

  dispatchInput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly text?: string;
      readonly submitOnly?: boolean;
      readonly writeOnly?: boolean;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeDispatchResult {
    if (input.worker.runtime !== 'orca') {
      return { status: 'send_failed', reason: 'runtime_identity_mismatch' };
    }
    const current = this.findWorker(input.worker, options);
    if (current.status !== 'ok') {
      return { status: 'send_failed', reason: current.reason };
    }
    if (current.value === null) {
      return { status: 'send_failed', reason: 'worker_generation_not_found' };
    }
    const control = this.composerControl(input.worker);
    if (control && (input.writeOnly || input.submitOnly || input.text !== undefined)) {
      return control.dispatch({
        worker: input.worker,
        action: 'submit-prompt',
        ...(input.text !== undefined ? { text: input.text } : {}),
      }, options);
    }
    const args = ['terminal', 'send', '--terminal', input.worker.id];
    if (!input.submitOnly) args.push('--text', input.text ?? '');
    if (!input.writeOnly) args.push('--enter');
    const response = this.#run<OrcaTerminalSendResult>(args, options);
    if (response.ok && response.result?.send?.accepted === true) {
      const witness: RuntimeDispatchWitness = {
        operation: input.writeOnly ? 'write' : 'submit',
        accepted: true,
        source: 'runtime-response',
      };
      if (input.submitOnly) return { status: 'dispatched', witness };
      if (input.writeOnly) return { status: 'dispatch_unknown', reason: 'submit_witness_unavailable', witness };
      return { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' };
    }
    if (response.ok) return { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' };
    const reason = neutralFailureReason(response);
    return response.outcomeCategory === 'process_launch_failed'
      ? { status: 'send_failed', reason }
      : { status: 'dispatch_unknown', reason };
  }

  checkInbox(
    input: {
      readonly runId: string;
      readonly ackDeliveryId?: string;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeInboxCheckResult {
    const runId = input.runId.trim();
    if (!runId) return { status: 'failed', reason: 'runtime_inbox_run_id_missing' };
    const args = ['orchestration', 'check', '--run', runId];
    if (input.ackDeliveryId !== undefined) {
      const deliveryId = input.ackDeliveryId.trim();
      if (!deliveryId) return { status: 'failed', reason: 'runtime_inbox_delivery_id_missing' };
      args.push('--ack', deliveryId);
    }
    const response = this.#run<OrcaInboxCheckShape>(args, options);
    if (!response.ok) {
      const reason = neutralFailureReason(response);
      return response.outcomeCategory === 'process_launch_failed'
        ? { status: 'failed', reason }
        : { status: 'unknown', reason };
    }
    return normalizeInboxCheck(runId, response.result);
  }

  readBoundedOutput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly previousToken?: RuntimeObservationToken | null;
      readonly limit?: number;
      readonly screen?: boolean;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeBoundedOutput> {
    if (input.worker.runtime !== 'orca') {
      return runtimeFailure('read_bounded_output', 'runtime_identity_mismatch');
    }
    let deadline: number | null = null;
    if (options.timeoutMs !== undefined) {
      const timeoutMs = Math.floor(options.timeoutMs);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return runtimeFailure('read_bounded_output', 'runtime_timeout');
      }
      deadline = this.#now() + timeoutMs;
    }

    const previous = input.previousToken
      ? this.#resolveObservation(input.worker, input.previousToken)
      : null;
    if (previous && previous.status !== 'ok') return previous;

    const lookupOptions = deadline === null ? options : this.#boundedOptions(deadline, options);
    if (!lookupOptions) return runtimeFailure('read_bounded_output', 'runtime_timeout');
    const current = this.findWorker(input.worker, lookupOptions);
    if (current.status !== 'ok') {
      return runtimeFailure('read_bounded_output', current.reason);
    }
    if (current.value === null) {
      return runtimeFailure('read_bounded_output', 'worker_generation_not_found');
    }

    const args = ['terminal', 'read', '--terminal', input.worker.id];
    if (input.screen) args.push('--screen');
    if (previous?.status === 'ok'
      && previous.value.source !== 'screen'
      && previous.value.nativeCursor !== null
      && /^\d+$/u.test(previous.value.nativeCursor)) {
      args.push('--cursor', previous.value.nativeCursor);
    }
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    const readOptions = deadline === null ? options : this.#boundedOptions(deadline, options);
    if (!readOptions) return runtimeFailure('read_bounded_output', 'runtime_timeout');
    const response = this.#run<OrcaTerminalReadResult>(args, readOptions);
    if (!response.ok) {
      return runtimeFailure('read_bounded_output', neutralFailureReason(response));
    }
    const normalized = normalizeTerminalRead(response.result, input.screen === true);
    if (normalized.status !== 'ok') return normalized;
    const changed = previous?.status === 'ok'
      ? previous.value.nativeCursor !== normalized.value.nativeCursor
        || previous.value.source !== normalized.value.source
      : normalized.value.lines.length > 0;
    const observationToken = this.#observationToken(
      input.worker,
      normalized.value.nativeCursor,
      normalized.value.source,
      changed,
      input.previousToken,
    );
    return {
      status: 'ok',
      value: {
        worker: input.worker,
        lines: normalized.value.lines,
        observationToken,
        changed,
        terminalState: normalized.value.terminalState,
        source: normalized.value.source,
      },
    };
  }

  async readBoundedOutputAsync(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly previousToken?: RuntimeObservationToken | null;
      readonly limit?: number;
      readonly screen?: boolean;
    },
    options: RuntimeCallOptions = {},
  ): Promise<RuntimeResult<RuntimeBoundedOutput>> {
    if (input.worker.runtime !== 'orca') {
      return runtimeFailure('read_bounded_output', 'runtime_identity_mismatch');
    }
    let deadline: number | null = null;
    if (options.timeoutMs !== undefined) {
      const timeoutMs = Math.floor(options.timeoutMs);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return runtimeFailure('read_bounded_output', 'runtime_timeout');
      }
      deadline = this.#now() + timeoutMs;
    }
    const previous = input.previousToken
      ? this.#resolveObservation(input.worker, input.previousToken)
      : null;
    if (previous && previous.status !== 'ok') return previous;
    const lookupOptions = deadline === null ? options : this.#boundedOptions(deadline, options);
    if (!lookupOptions) return runtimeFailure('read_bounded_output', 'runtime_timeout');
    const shown = await this.#runAsync<{ terminal?: OrcaTerminalSummary }>(
      ['terminal', 'show', '--terminal', input.worker.id],
      lookupOptions,
    );
    if (!shown.ok) return runtimeFailure('read_bounded_output', neutralFailureReason(shown));
    const terminal = shown.result?.terminal;
    if (!terminal) return runtimeFailure('read_bounded_output', 'runtime_worker_show_shape_unsupported');
    const current = this.#workerFromTerminal(
      terminal,
      terminal.worktreePath?.trim() || 'active',
      'find_worker_by_id',
    );
    if (current.status !== 'ok') return runtimeFailure('read_bounded_output', current.reason);
    if (!sameRuntimeWorker(current.value.identity, input.worker)) {
      return runtimeFailure('read_bounded_output', 'worker_generation_not_found');
    }
    const args = ['terminal', 'read', '--terminal', input.worker.id];
    if (input.screen) args.push('--screen');
    if (previous?.status === 'ok'
      && previous.value.source !== 'screen'
      && previous.value.nativeCursor !== null
      && /^\d+$/u.test(previous.value.nativeCursor)) {
      args.push('--cursor', previous.value.nativeCursor);
    }
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    const readOptions = deadline === null ? options : this.#boundedOptions(deadline, options);
    if (!readOptions) return runtimeFailure('read_bounded_output', 'runtime_timeout');
    const response = await this.#runAsync<OrcaTerminalReadResult>(args, readOptions);
    if (!response.ok) return runtimeFailure('read_bounded_output', neutralFailureReason(response));
    const normalized = normalizeTerminalRead(response.result, input.screen === true);
    if (normalized.status !== 'ok') return normalized;
    const changed = previous?.status === 'ok'
      ? previous.value.nativeCursor !== normalized.value.nativeCursor
        || previous.value.source !== normalized.value.source
      : normalized.value.lines.length > 0;
    const observationToken = this.#observationToken(
      input.worker,
      normalized.value.nativeCursor,
      normalized.value.source,
      changed,
      input.previousToken,
    );
    return {
      status: 'ok',
      value: {
        worker: input.worker,
        lines: normalized.value.lines,
        observationToken,
        changed,
        terminalState: normalized.value.terminalState,
        source: normalized.value.source,
      },
    };
  }

  liveness(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly observationWindowMs: number;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeLivenessResult {
    if (input.worker.runtime !== 'orca' || input.observationWindowMs <= 0) {
      return { status: 'unknown', worker: input.worker };
    }
    const requestedTimeout = options.timeoutMs;
    const totalBudget = requestedTimeout !== undefined
      && Number.isFinite(requestedTimeout)
      && requestedTimeout > 0
      ? Math.floor(requestedTimeout)
      : input.observationWindowMs + orcaLivenessTransportMarginMs;
    const deadline = this.#now() + totalBudget;
    const boundedCallOptions = { ...options, timeoutMs: totalBudget };
    const lookupOptions = this.#boundedOptions(deadline, boundedCallOptions);
    if (!lookupOptions) return { status: 'unknown', worker: input.worker };
    const current = this.findWorker(input.worker, lookupOptions);
    if (current.status !== 'ok') return { status: 'unknown', worker: input.worker };
    if (current.value === null) return { status: 'gone', worker: input.worker };

    const waitOptions = this.#boundedOptions(deadline, boundedCallOptions);
    if (!waitOptions) return { status: 'unknown', worker: input.worker };
    const waitBudget = Math.max(
      1,
      Math.min(Math.floor(input.observationWindowMs), waitOptions.timeoutMs ?? 1),
    );
    const response = this.#run<OrcaTerminalWaitResult>(
      [
        'terminal', 'wait', '--terminal', input.worker.id,
        '--for', 'tui-idle', '--timeout-ms', String(waitBudget),
      ],
      waitOptions,
    );
    if (!response.ok) {
      return {
        status: response.error?.code === 'timeout' ? 'busy' : 'unknown',
        worker: input.worker,
      };
    }
    const wait = response.result?.wait;
    if (wait?.status === 'exited') return { status: 'gone', worker: input.worker };
    if (wait?.status !== 'running') return { status: 'unknown', worker: input.worker };
    return {
      status: wait.satisfied === true ? 'idle' : wait.satisfied === false ? 'busy' : 'unknown',
      worker: input.worker,
    };
  }

  stopWorker(
    worker: RuntimeWorkerIdentity,
    _options: RuntimeCallOptions = {},
  ): RuntimeResult<{ readonly stopped: true }> {
    const owned = this.#owned.get(worker.id);
    if (!owned || !sameRuntimeWorker(owned.identity, worker)) {
      return runtimeFailure('stop_worker', 'worker_not_owned_by_runtime_instance');
    }
    return runtimeUnsupported('stop_worker', 'runtime_generation_bound_stop_unsupported');
  }
}
