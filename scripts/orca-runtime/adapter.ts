import { randomUUID } from 'node:crypto';
import {
  runtimeFailure,
  runtimeUnsupported,
  sameRuntimeWorker,
  type RuntimeAdapter,
  type RuntimeBoundedOutput,
  type RuntimeCallOptions,
  type RuntimeDispatchResult,
  type RuntimeLivenessResult,
  type RuntimeObservationToken,
  type RuntimeReadiness,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaRunOptions,
  type OrcaTerminalHandle,
  type OrcaTerminalReadResult,
  type OrcaTerminalSummary,
  type OrcaTerminalWaitResult,
  type OrcaWorktreeCurrent,
} from './native.ts';

export interface OrcaRuntimeAdapterOptions extends OrcaRunOptions {
  readonly runJson?: typeof runOrcaJson;
  readonly now?: () => number;
}

interface OwnedWorkerRecord {
  readonly identity: RuntimeWorkerIdentity;
  readonly workspacePath: string;
  readonly workspaceSelector: 'active' | string;
  readonly title: string | null;
}

interface KnownWorkspaceRecord {
  readonly workspaceSelector: 'active' | string;
  readonly workspacePath: string;
}

interface NormalizedTerminalRead {
  readonly lines: readonly string[];
  readonly nativeCursor: string;
  readonly terminalState: 'running' | 'exited' | 'unknown';
}

interface ObservationBinding {
  readonly workerKey: string;
  readonly nativeCursor: string;
}

interface DecodedObservation {
  readonly nativeCursor: string;
}

const OBSERVATION_TOKEN_PREFIX = 'opk-orca-output-v3.';

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

function dispatchOutcomeUnknown(response: OrcaJsonResponse): boolean {
  return isNativeTimeout(response)
    || response.outcomeCategory === 'empty_stdout'
    || response.outcomeCategory === 'invalid_json';
}

function nativeGeneration(terminal: OrcaTerminalSummary | OrcaTerminalHandle): string | null {
  const generation = terminal.incarnationId?.trim() || terminal.ptyId?.trim();
  return generation || null;
}

function identityKey(identity: RuntimeWorkerIdentity): string {
  return `${identity.runtime}\u0000${identity.id}\u0000${identity.generation}`;
}

function normalizeTerminalRead(
  result: OrcaTerminalReadResult | undefined,
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
    const nativeCursor = current.nextCursor ?? current.latestCursor ?? null;
    if (nativeCursor === null) {
      return runtimeUnsupported('read_bounded_output', 'runtime_output_progress_unavailable');
    }
    return {
      status: 'ok',
      value: {
        lines: current.tail,
        nativeCursor,
        terminalState: current.status!,
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
  if (result.nextCursor === null) {
    return runtimeUnsupported('read_bounded_output', 'runtime_output_progress_unavailable');
  }
  return {
    status: 'ok',
    value: {
      lines: result.lines,
      nativeCursor: String(result.nextCursor),
      terminalState: 'unknown',
    },
  };
}

export class OrcaRuntimeAdapter implements RuntimeAdapter {
  readonly id = 'orca' as const;
  readonly #options: OrcaRuntimeAdapterOptions;
  readonly #now: () => number;
  readonly #owned = new Map<string, OwnedWorkerRecord>();
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

  #rememberWorkspace(
    identity: RuntimeWorkerIdentity,
    workspaceSelector: 'active' | string,
    workspacePath: string,
  ): void {
    this.#knownWorkspace.set(identityKey(identity), { workspaceSelector, workspacePath });
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
    return { status: 'ok', value: { nativeCursor: binding.nativeCursor } };
  }

  #observationToken(
    worker: RuntimeWorkerIdentity,
    nativeCursor: string,
    changed: boolean,
    previousToken?: RuntimeObservationToken | null,
  ): RuntimeObservationToken {
    if (previousToken && !changed) return previousToken;
    const token = { opaque: `${OBSERVATION_TOKEN_PREFIX}${randomUUID()}` };
    this.#observations.set(token.opaque, {
      workerKey: identityKey(worker),
      nativeCursor,
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

  readiness(options: RuntimeCallOptions = {}): RuntimeResult<RuntimeReadiness> {
    const response = this.#run<OrcaWorktreeCurrent>(['worktree', 'current'], options);
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
      if (listed.status === 'ok') {
        const discovered = listed.value.find((candidate) => candidate.identity.id === handle);
        if (discovered) {
          generation = discovered.identity.generation;
          discoveredWorkspacePath = discovered.workspacePath;
        }
      }
      if (!generation) {
        const exact = this.findWorkerById(handle, options);
        if (exact.status !== 'ok' || exact.value === null) {
          return runtimeUnsupported('spawn_worker', 'runtime_worker_generation_unresolved');
        }
        generation = exact.value.identity.generation;
        discoveredWorkspacePath = exact.value.workspacePath;
      }
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
    this.#owned.set(handle, {
      identity,
      workspacePath: worker.workspacePath,
      workspaceSelector: workspace,
      title: worker.title,
    });
    this.#rememberWorkspace(identity, workspace, worker.workspacePath);
    return { status: 'ok', value: worker };
  }

  dispatchInput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly text?: string;
      readonly submitOnly?: boolean;
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
    const args = ['terminal', 'send', '--terminal', input.worker.id];
    if (!input.submitOnly) args.push('--text', input.text ?? '');
    args.push('--enter');
    const response = this.#run(args, options);
    if (response.ok) return { status: 'dispatched' };
    const reason = neutralFailureReason(response);
    return dispatchOutcomeUnknown(response)
      ? { status: 'dispatch_unknown', reason }
      : { status: 'send_failed', reason };
  }

  readBoundedOutput(
    input: {
      readonly worker: RuntimeWorkerIdentity;
      readonly previousToken?: RuntimeObservationToken | null;
      readonly limit?: number;
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
    if (previous?.status === 'ok') {
      args.push('--cursor', previous.value.nativeCursor);
    }
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    const readOptions = deadline === null ? options : this.#boundedOptions(deadline, options);
    if (!readOptions) return runtimeFailure('read_bounded_output', 'runtime_timeout');
    const response = this.#run<OrcaTerminalReadResult>(args, readOptions);
    if (!response.ok) {
      return runtimeFailure('read_bounded_output', neutralFailureReason(response));
    }
    const normalized = normalizeTerminalRead(response.result);
    if (normalized.status !== 'ok') return normalized;
    const changed = previous?.status === 'ok'
      ? previous.value.nativeCursor !== normalized.value.nativeCursor
      : normalized.value.lines.length > 0;
    const observationToken = this.#observationToken(
      input.worker,
      normalized.value.nativeCursor,
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
    const deadline = this.#now() + input.observationWindowMs;
    const lookupOptions = this.#boundedOptions(deadline, options);
    if (!lookupOptions) return { status: 'unknown', worker: input.worker };
    const current = this.findWorker(input.worker, lookupOptions);
    if (current.status !== 'ok') return { status: 'unknown', worker: input.worker };
    if (current.value === null) return { status: 'gone', worker: input.worker };

    const waitOptions = this.#boundedOptions(deadline, options);
    if (!waitOptions) return { status: 'unknown', worker: input.worker };
    const waitBudget = waitOptions.timeoutMs ?? 1;
    const response = this.#run<OrcaTerminalWaitResult>(
      [
        'terminal', 'wait', '--terminal', input.worker.id,
        '--for', 'tui-idle', '--timeout-ms', String(waitBudget),
      ],
      waitOptions,
    );
    if (!response.ok) return { status: 'unknown', worker: input.worker };
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
