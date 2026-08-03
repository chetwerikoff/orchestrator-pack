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
}

interface OwnedWorkerRecord {
  readonly identity: RuntimeWorkerIdentity;
  readonly workspacePath: string;
  readonly title: string | null;
}

interface NormalizedTerminalRead {
  readonly lines: readonly string[];
  readonly nativeCursor: string | null;
  readonly terminalState: 'running' | 'exited' | 'unknown';
}

interface EncodedObservation {
  readonly version: 1;
  readonly workerId: string;
  readonly generation: string;
  readonly cursor: string;
}

const OBSERVATION_TOKEN_PREFIX = 'opk-orca-output-v1.';

function failureReason(response: OrcaJsonResponse, fallback: string): string {
  return response.error?.code ?? response.error?.message ?? fallback;
}

function nativeGeneration(terminal: OrcaTerminalSummary | OrcaTerminalHandle): string | null {
  const generation = terminal.incarnationId?.trim() || terminal.ptyId?.trim();
  return generation || null;
}

function encodeObservationToken(
  worker: RuntimeWorkerIdentity,
  cursor: string | null,
): RuntimeObservationToken | null {
  if (cursor === null) return null;
  const payload: EncodedObservation = {
    version: 1,
    workerId: worker.id,
    generation: worker.generation,
    cursor,
  };
  return {
    opaque: `${OBSERVATION_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`,
  };
}

function decodeObservationToken(
  worker: RuntimeWorkerIdentity,
  token: RuntimeObservationToken,
): RuntimeResult<string> {
  if (!token.opaque.startsWith(OBSERVATION_TOKEN_PREFIX)) {
    return runtimeUnsupported('read_bounded_output', 'observation_token_unsupported');
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(token.opaque.slice(OBSERVATION_TOKEN_PREFIX.length), 'base64url').toString('utf8'),
    ) as Partial<EncodedObservation>;
    if (decoded.version !== 1
      || decoded.workerId !== worker.id
      || decoded.generation !== worker.generation
      || typeof decoded.cursor !== 'string') {
      return runtimeFailure('read_bounded_output', 'observation_token_scope_mismatch');
    }
    return { status: 'ok', value: decoded.cursor };
  } catch {
    return runtimeUnsupported('read_bounded_output', 'observation_token_unsupported');
  }
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
  readonly #owned = new Map<string, OwnedWorkerRecord>();

  constructor(options: OrcaRuntimeAdapterOptions = {}) {
    this.#options = options;
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
      const generation = owned?.identity.generation ?? nativeGeneration(terminal);
      if (!generation) {
        return runtimeUnsupported('list_workers', 'orca_terminal_generation_missing');
      }
      workers.push({
        identity: { runtime: 'orca', id: handle, generation },
        workspacePath,
        title: typeof terminal.title === 'string' ? terminal.title : null,
        provenance: owned ? 'internal' : 'external',
      });
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
    const listed = this.listWorkers({ workspace: 'active' }, options);
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
    const readiness = this.readiness(options);
    const workspacePath = readiness.status === 'ok'
      ? readiness.value.workspacePath
      : workspace === 'active' ? options.cwd ?? this.#options.cwd ?? process.cwd() : workspace;
    const identity: RuntimeWorkerIdentity = {
      runtime: 'orca',
      id: handle,
      generation: nativeGeneration(terminal) ?? randomUUID(),
    };
    const worker: RuntimeWorker = {
      identity,
      workspacePath,
      title: terminal.title ?? input.title,
      provenance: 'internal',
    };
    this.#owned.set(handle, { identity, workspacePath, title: worker.title });
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
    const args = ['terminal', 'read', '--terminal', input.worker.id];
    if (input.previousToken) {
      const decoded = decodeObservationToken(input.worker, input.previousToken);
      if (decoded.status !== 'ok') return decoded;
      args.push('--cursor', decoded.value);
    }
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    const response = this.#run<OrcaTerminalReadResult>(args, options);
    if (!response.ok) {
      return runtimeFailure('read_bounded_output', failureReason(response, 'orca_terminal_read_failed'));
    }
    const normalized = normalizeTerminalRead(response.result);
    if (normalized.status !== 'ok') return normalized;
    const observationToken = encodeObservationToken(input.worker, normalized.value.nativeCursor);
    return {
      status: 'ok',
      value: {
        worker: input.worker,
        lines: normalized.value.lines,
        observationToken,
        changed: input.previousToken?.opaque !== observationToken?.opaque,
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
    const current = this.findWorker(input.worker, options);
    if (current.status !== 'ok') return { status: 'unknown', worker: input.worker };
    if (current.value === null) return { status: 'gone', worker: input.worker };

    const response = this.#run<OrcaTerminalWaitResult>(
      [
        'terminal', 'wait', '--terminal', input.worker.id,
        '--for', 'tui-idle', '--timeout-ms', String(input.observationWindowMs),
      ],
      { ...options, timeoutMs: input.observationWindowMs + 1_000 },
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
    const response = this.#run(['terminal', 'close', '--terminal', worker.id], options);
    if (!response.ok) {
      return runtimeFailure('stop_worker', failureReason(response, 'orca_terminal_close_failed'));
    }
    this.#owned.delete(worker.id);
    return { status: 'ok', value: { stopped: true } };
  }
}
