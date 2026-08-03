import { createHash, randomUUID } from 'node:crypto';
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
  readonly nativeCursor: string | null;
  readonly terminalState: 'running' | 'exited' | 'unknown';
}

interface ObservationBinding {
  readonly workerKey: string;
  readonly nativeCursor: string | null;
  readonly fingerprint: string;
}

interface DecodedObservation {
  readonly nativeCursor: string | null;
  readonly fingerprint: string;
}

const OBSERVATION_TOKEN_PREFIX = 'opk-orca-output-v2.';

function failureReason(response: OrcaJsonResponse, fallback: string): string {
  return response.error?.code ?? response.error?.message ?? fallback;
}

function nativeGeneration(terminal: OrcaTerminalSummary | OrcaTerminalHandle): string | null {
  const generation = terminal.incarnationId?.trim() || terminal.ptyId?.trim();
  return generation || null;
}

function identityKey(identity: RuntimeWorkerIdentity): string {
  return `${identity.runtime}\u0000${identity.id}\u0000${identity.generation}`;
}

function outputFingerprint(
  lines: readonly string[],
  terminalState: NormalizedTerminalRead['terminalState'],
): string {
  return createHash('sha256')
    .update(JSON.stringify({ lines, terminalState }), 'utf8')
    .digest('base64url');
}

function normalizeTerminalRead(
  result: OrcaTerminalReadResult | undefined,
): RuntimeResult<NormalizedTerminalRead> {
  const current = result?.terminal;
  if (current) {
    if (!Array.isArray(current.tail)
      || !current.tail.every((line) => typeof line === 'string')
      || (current.nextCursor !== null && typeof current.nextCursor !== 'string')
      || !['running', 'exited', 'unknown'].includes(current.status ?? '')) {
      return runtimeUnsupported('read_bounded_output', 'orca_terminal_read_shape_unsupported');
    }
    return {
      status: 'ok',
      value: {
        lines: current.tail,
        nativeCursor: current.nextCursor,
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
    return runtimeUnsupported('read_bounded_output', 'orca_terminal_read_shape_unsupported');
  }
  return {
    status: 'ok',
    value: {
      lines: result.lines,
      nativeCursor: result.nextCursor === null ? null : String(result.nextCursor),
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
      value: { nativeCursor: binding.nativeCursor, fingerprint: binding.fingerprint },
    };
  }

  #observationToken(
    worker: RuntimeWorkerIdentity,
    nativeCursor: string | null,
    fingerprint: string,
    previousToken?: RuntimeObservationToken | null,
  ): RuntimeObservationToken {
    if (previousToken) {
      const previous = this.#observations.get(previousToken.opaque);
      if (previous?.workerKey === identityKey(worker)
        && previous.nativeCursor === nativeCursor
        && previous.fingerprint === fingerprint) {
        return previousToken;
      }
    }
    const token = { opaque: `${OBSERVATION_TOKEN_PREFIX}${randomUUID()}` };
    this.#observations.set(token.opaque, {
      workerKey: identityKey(worker),
      nativeCursor,
      fingerprint,
    });
    return token;
  }

  #dropObservations(worker: RuntimeWorkerIdentity): void {
    const workerKey = identityKey(worker);
    for (const [token, binding] of this.#observations) {
      if (binding.workerKey === workerKey) this.#observations.delete(token);
    }
  }

  readiness(options: RuntimeCallOptions = {}): RuntimeResult<RuntimeReadiness> {
    const response = this.#run<OrcaWorktreeCurrent>(['worktree', 'current'], options);
    if (!response.ok) {
      return runtimeFailure('readiness', failureReason(response, 'orca_worktree_current_failed'));
    }
    const path = response.result?.worktree?.path?.trim();
    if (!path) {
      return runtimeUnsupported('readiness', 'orca_worktree_path_missing');
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
      return runtimeFailure('list_workers', failureReason(response, 'orca_terminal_list_failed'));
    }
    const terminals = response.result?.terminals;
    if (!Array.isArray(terminals)) {
      return runtimeUnsupported('list_workers', 'orca_terminal_list_shape_unsupported');
    }
    const workers: RuntimeWorker[] = [];
    for (const terminal of terminals) {
      const handle = terminal.handle?.trim();
      const workspacePath = terminal.worktreePath?.trim();
      if (!handle || !workspacePath) {
        return runtimeUnsupported('list_workers', 'orca_terminal_identity_field_missing');
      }
      const owned = this.#owned.get(handle);
      const reportedGeneration = nativeGeneration(terminal);
      if (owned && reportedGeneration && reportedGeneration !== owned.identity.generation) {
        this.#owned.delete(handle);
        this.#knownWorkspace.delete(identityKey(owned.identity));
        this.#dropObservations(owned.identity);
      }
      const currentOwned = this.#owned.get(handle);
      const generation = reportedGeneration;
      if (!generation) {
        return runtimeUnsupported('list_workers', 'orca_terminal_generation_missing');
      }
      const identity: RuntimeWorkerIdentity = { runtime: 'orca', id: handle, generation };
      const worker: RuntimeWorker = {
        identity,
        workspacePath,
        title: typeof terminal.title === 'string' ? terminal.title : null,
        provenance: currentOwned ? 'internal' : 'external',
      };
      this.#rememberWorkspace(identity, workspace, workspacePath);
      workers.push(worker);
    }
    return { status: 'ok', value: workers };
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
    const workspace = known?.workspaceSelector ?? owned?.workspaceSelector ?? 'active';
    const listed = this.listWorkers({ workspace }, options);
    if (listed.status !== 'ok') return listed;
    return {
      status: 'ok',
      value: listed.value.find((worker) => sameRuntimeWorker(worker.identity, identity)) ?? null,
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
    const terminal = response.result?.terminal;
    const handle = terminal?.handle?.trim();
    if (!response.ok || !terminal || !handle) {
      return runtimeFailure('spawn_worker', failureReason(response, 'orca_terminal_create_failed'));
    }

    let generation = nativeGeneration(terminal);
    let discoveredWorkspacePath: string | null = null;
    if (!generation) {
      const listed = this.listWorkers({ workspace }, options);
      if (listed.status !== 'ok') {
        return runtimeFailure('spawn_worker', 'orca_terminal_generation_unresolved');
      }
      const discovered = listed.value.find((candidate) => candidate.identity.id === handle);
      if (!discovered) {
        return runtimeUnsupported('spawn_worker', 'orca_terminal_generation_unresolved');
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
    const reason = failureReason(response, 'orca_terminal_send_failed');
    if (response.error?.code === 'orca_operation_timeout'
      || response.outcomeCategory === 'empty_stdout'
      || response.outcomeCategory === 'invalid_json') {
      return { status: 'dispatch_unknown', reason };
    }
    return { status: 'send_failed', reason };
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
    const previous = input.previousToken
      ? this.#resolveObservation(input.worker, input.previousToken)
      : null;
    if (previous && previous.status !== 'ok') return previous;

    const current = this.findWorker(input.worker, options);
    if (current.status !== 'ok') {
      return runtimeFailure('read_bounded_output', current.reason);
    }
    if (current.value === null) {
      return runtimeFailure('read_bounded_output', 'worker_generation_not_found');
    }

    const args = ['terminal', 'read', '--terminal', input.worker.id];
    if (previous?.status === 'ok' && previous.value.nativeCursor !== null) {
      args.push('--cursor', previous.value.nativeCursor);
    }
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    const response = this.#run<OrcaTerminalReadResult>(args, options);
    if (!response.ok) {
      return runtimeFailure('read_bounded_output', failureReason(response, 'orca_terminal_read_failed'));
    }
    const normalized = normalizeTerminalRead(response.result);
    if (normalized.status !== 'ok') return normalized;
    const fingerprint = outputFingerprint(normalized.value.lines, normalized.value.terminalState);
    const observationToken = this.#observationToken(
      input.worker,
      normalized.value.nativeCursor,
      fingerprint,
      input.previousToken,
    );
    const changed = previous?.status === 'ok'
      ? previous.value.nativeCursor !== normalized.value.nativeCursor
        || previous.value.fingerprint !== fingerprint
      : normalized.value.lines.length > 0;
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
    const lookupBudget = this.#remaining(deadline);
    if (lookupBudget <= 0) return { status: 'unknown', worker: input.worker };
    const current = this.findWorker(input.worker, {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? lookupBudget, lookupBudget),
    });
    if (current.status !== 'ok') return { status: 'unknown', worker: input.worker };
    if (current.value === null) return { status: 'gone', worker: input.worker };

    const waitBudget = this.#remaining(deadline);
    if (waitBudget <= 0) return { status: 'unknown', worker: input.worker };
    const response = this.#run<OrcaTerminalWaitResult>(
      [
        'terminal', 'wait', '--terminal', input.worker.id,
        '--for', 'tui-idle', '--timeout-ms', String(waitBudget),
      ],
      { ...options, timeoutMs: Math.min(options.timeoutMs ?? waitBudget, waitBudget) },
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
    options: RuntimeCallOptions = {},
  ): RuntimeResult<{ readonly stopped: true }> {
    const owned = this.#owned.get(worker.id);
    if (!owned || !sameRuntimeWorker(owned.identity, worker)) {
      return runtimeFailure('stop_worker', 'worker_not_owned_by_runtime_instance');
    }
    const current = this.findWorker(worker, options);
    if (current.status !== 'ok') {
      return runtimeFailure('stop_worker', current.reason);
    }
    const refreshedOwned = this.#owned.get(worker.id);
    if (current.value === null
      || !refreshedOwned
      || !sameRuntimeWorker(refreshedOwned.identity, worker)) {
      return runtimeFailure('stop_worker', 'worker_generation_not_found');
    }
    const response = this.#run(['terminal', 'close', '--terminal', worker.id], options);
    if (!response.ok) {
      return runtimeFailure('stop_worker', failureReason(response, 'orca_terminal_close_failed'));
    }
    this.#owned.delete(worker.id);
    this.#knownWorkspace.delete(identityKey(worker));
    this.#dropObservations(worker);
    return { status: 'ok', value: { stopped: true } };
  }
}
