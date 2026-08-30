import { resolve } from 'node:path';
import {
  runtimeFailure,
  runtimeUnsupported,
  sameRuntimeWorker,
  type RuntimeCallOptions,
  type RuntimeOperationFailure,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  neutralFailureReason,
  OrcaRuntimeAdapter,
  type OrcaRuntimeAdapterOptions,
} from './adapter.ts';
import {
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaTerminalSummary,
  type OrcaWorktreeRemoveResult,
  type OrcaWorktreeShow,
} from './native.ts';
import {
  maybeNotifyRunOnTerminalDispatch,
  snapshotFromWorkerShow,
  TERMINAL_DISPATCH_STATES,
  TERMINAL_WORKER_STATES,
} from './dispatch-terminal-mail.ts';
import { resolveDispatchTerminalMailLedgerPath } from '../pr2-foundation/wake-supervisor-state-root.ts';

function usesNativePtyFallback(generation: string): boolean {
  // Orca's terminal-create response currently exposes ptyId while the
  // exact incarnationId is available only from terminal-show. The ptyId
  // shape is deliberately recognized here so a spawned RuntimeWorker never
  // carries that fallback into later exact-identity reads.
  return generation.includes('@@');
}

type RuntimeFailureWithNativeError = RuntimeOperationFailure & {
  readonly nativeError?: Readonly<{
    code: string;
    message: string;
  }>;
};

type UnprovenOwnedPresence = Readonly<{
  identity: RuntimeWorkerIdentity;
  reason: string;
}>;

type OrcaWorkerShowResult = Readonly<{
  dispatch?: Readonly<{
    status?: string | null;
    last_heartbeat_at?: string | null;
  }>;
  worker?: Readonly<{
    agent_terminal_handle?: string | null;
    worktree_id?: string | null;
    state?: string | null;
    stage?: string | null;
  }>;
  terminal?: Readonly<{ handle?: string | null }> | null;
  observation?: Readonly<{ exactWorker?: boolean; status?: string }>;
  terminalResource?: Readonly<{
    terminalHandle?: string | null;
    worktreeId?: string | null;
    originDispatchId?: string | null;
    ownerDispatchId?: string | null;
    releaseState?: string | null;
  }> | null;
}>;

type OrcaTerminalListResult = Readonly<{
  terminals?: OrcaTerminalSummary[];
  totalCount?: number;
  truncated?: boolean;
}>;

type OrcaAssignmentActivity = 'active' | 'inactive' | 'unresolved';

// Pinned Orca producer contract evidence (stablyai/orca@
// f5fd7303ab00bcfeff72c92f2bc33ba9364cd622):
// - orchestration-worker-control.ts emits `live` and documents legacy `running`
//   as the same compatibility-boundary liveness observation;
// - lifecycle-reconciliation.ts authorizes heartbeat messages against the exact
//   assignee before dispatch-completion.ts records last_heartbeat_at, and that
//   write is guarded by status='dispatched';
// - coordinator-task-dispatch.ts defines stale Dispatch liveness as 10 minutes
//   (two documented five-minute heartbeat intervals).
// PACK reuses those producer semantics instead of inventing a separate TTL.
const DISPATCH_HEARTBEAT_STALE_AFTER_MS = 10 * 60 * 1_000;
const SQLITE_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u;
const RFC3339_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
function failureDetail(failure: RuntimeOperationFailure): string {
  return `${failure.operation}:${failure.status}:${failure.reason}`;
}

function attachNativeRuntimeError(
  failure: RuntimeOperationFailure,
  response: OrcaJsonResponse,
): RuntimeOperationFailure {
  const code = String(response.error?.code ?? '');
  const message = String(response.error?.message ?? '');
  if (!code && !message) return failure;
  Object.defineProperty(failure as RuntimeFailureWithNativeError, 'nativeError', {
    value: Object.freeze({ code, message }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return failure;
}

function isRetryableTabNotFound(response: OrcaJsonResponse): boolean {
  return response.error?.code?.trim() === 'runtime_error'
    && response.error?.message?.trim() === 'tab_not_found';
}

/**
 * The pinned Orca worker-show producer has no `observation.status="gone"` shape.
 * A missing local Dispatch is instead reported as this exact control-plane error.
 * Match the producer's structured code plus its dispatch-specific message so the
 * distinct federated "has no worker record" error (same code) remains fail-closed.
 */
function isProducerBackedDispatchAbsent(
  response: OrcaJsonResponse,
  dispatchId: string,
): boolean {
  return response.outcomeCategory === 'supported_operation_failure'
    && response.error?.code?.trim() === 'dispatch_not_found'
    && response.error?.message?.trim() === `Worker Dispatch ${dispatchId} was not found.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNullableStringField(record: Record<string, unknown>, field: string): boolean {
  return !(field in record) || record[field] === null || typeof record[field] === 'string';
}

/**
 * Runtime shape boundary for `orca orchestration worker-show --dispatch`.
 * The generic JSON transport is intentionally not trusted to make the payload
 * typed: malformed lifecycle fields must fail closed before any absence or S2
 * authority is derived from them.
 */
function parseOrcaWorkerShowResult(input: unknown): OrcaWorkerShowResult | null {
  if (!isRecord(input)) return null;

  const observation = input.observation;
  if (
    !isRecord(observation)
    || typeof observation.exactWorker !== 'boolean'
    || typeof observation.status !== 'string'
  ) {
    return null;
  }

  const dispatch = input.dispatch;
  if (dispatch !== undefined) {
    if (
      !isRecord(dispatch)
      || !hasNullableStringField(dispatch, 'status')
      || !hasNullableStringField(dispatch, 'last_heartbeat_at')
    ) return null;
  }

  const worker = input.worker;
  if (worker !== undefined) {
    if (
      !isRecord(worker)
      || !hasNullableStringField(worker, 'agent_terminal_handle')
      || !hasNullableStringField(worker, 'worktree_id')
      || !hasNullableStringField(worker, 'state')
      || !hasNullableStringField(worker, 'stage')
    ) return null;
  }

  const terminal = input.terminal;
  if (terminal !== undefined && terminal !== null) {
    if (!isRecord(terminal) || !hasNullableStringField(terminal, 'handle')) return null;
  }

  const resource = input.terminalResource;
  if (resource !== undefined && resource !== null) {
    if (
      !isRecord(resource)
      || !hasNullableStringField(resource, 'terminalHandle')
      || !hasNullableStringField(resource, 'worktreeId')
      || !hasNullableStringField(resource, 'originDispatchId')
      || !hasNullableStringField(resource, 'ownerDispatchId')
    ) return null;
  }

  return input as OrcaWorkerShowResult;
}

function normalizedWorkerLifecycle(result: OrcaWorkerShowResult | undefined): {
  readonly observationStatus: string;
  readonly workerState: string;
  readonly workerStage: string;
  readonly dispatchStatus: string;
  readonly lastHeartbeatAt: string;
} {
  return {
    observationStatus: result?.observation?.status?.trim().toLowerCase() ?? '',
    workerState: result?.worker?.state?.trim().toLowerCase() ?? '',
    workerStage: result?.worker?.stage?.trim().toLowerCase() ?? '',
    dispatchStatus: result?.dispatch?.status?.trim().toLowerCase() ?? '',
    lastHeartbeatAt: result?.dispatch?.last_heartbeat_at?.trim() ?? '',
  };
}

function utcTimestampFromMatch(match: RegExpMatchArray): number | null {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0') || '0');
  if (year < 1970) return null;
  const value = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  if (!Number.isFinite(value)) return null;
  const parsed = new Date(value);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
    || parsed.getUTCMilliseconds() !== millisecond
  ) return null;
  return value;
}

function parseOrcaHeartbeatTimestamp(value: string): number | null {
  const sqlite = value.match(SQLITE_UTC_TIMESTAMP);
  if (sqlite) return utcTimestampFromMatch(sqlite);
  const rfc3339 = value.match(RFC3339_UTC_TIMESTAMP);
  if (rfc3339) return utcTimestampFromMatch(rfc3339);
  return null;
}

function hasCurrentDispatchHeartbeat(lastHeartbeatAt: string, nowMs = Date.now()): boolean {
  const heartbeatMs = parseOrcaHeartbeatTimestamp(lastHeartbeatAt);
  return heartbeatMs !== null
    && heartbeatMs <= nowMs
    && nowMs - heartbeatMs <= DISPATCH_HEARTBEAT_STALE_AFTER_MS;
}

function classifyWorkerLifecycle(result: OrcaWorkerShowResult | undefined): OrcaAssignmentActivity {
  const lifecycle = normalizedWorkerLifecycle(result);
  if (lifecycle.observationStatus === 'exited') return 'inactive';
  if (lifecycle.observationStatus !== 'live' && lifecycle.observationStatus !== 'running') {
    return 'unresolved';
  }

  if (TERMINAL_WORKER_STATES.has(lifecycle.workerState)) return 'inactive';
  if (TERMINAL_DISPATCH_STATES.has(lifecycle.dispatchStatus)) return 'inactive';

  // `ready/input_accepted` is only prompt-injection acceptance. Positive S2
  // authority additionally requires the current dispatched row plus a fresh,
  // producer-authorized heartbeat under the pinned Orca contract above.
  if (
    lifecycle.workerState !== 'ready'
    || lifecycle.workerStage !== 'input_accepted'
    || lifecycle.dispatchStatus !== 'dispatched'
    || !hasCurrentDispatchHeartbeat(lifecycle.lastHeartbeatAt)
  ) {
    return 'unresolved';
  }
  return 'active';
}

/**
 * Production Orca adapter for task lifecycle callers.
 *
 * Orca closes by opaque handle. The adapter permits one close attempt for an
 * identity spawned by this adapter instance and revalidated by exact runtime +
 * id + generation immediately before the destructive call. The sole bounded
 * exception is native runtime_error/tab_not_found with immediate exact presence:
 * one retry of that same consumed authority is allowed. Authority is consumed
 * before transport, so no caller can replay either attempt.
 */
export class OrcaTaskRuntimeAdapter extends OrcaRuntimeAdapter {
  readonly #options: OrcaRuntimeAdapterOptions;
  readonly #ownedForStop = new Map<string, RuntimeWorkerIdentity>();
  readonly #stopWorkspace = new Map<string, 'active' | string>();
  readonly #assignmentOwned = new Map<string, RuntimeWorkerIdentity>();
  readonly #unprovenOwnedPresence = new Map<string, UnprovenOwnedPresence>();
  readonly #runJson: typeof runOrcaJson;

  constructor(options: OrcaRuntimeAdapterOptions = {}) {
    super(options);
    this.#options = options;
    this.#runJson = options.runJson ?? runOrcaJson;
  }

  #run<T>(args: readonly string[], options: RuntimeCallOptions): OrcaJsonResponse<T> {
    return this.#runJson<T>(args, {
      cwd: options.cwd ?? this.#options.cwd,
      timeoutMs: options.timeoutMs ?? this.#options.timeoutMs,
      executable: this.#options.executable,
      runner: this.#options.runner,
      env: this.#options.env,
      killSignal: this.#options.killSignal,
    });
  }

  #recordUnprovenOwnedPresence(
    worker: RuntimeWorkerIdentity,
    reason: string,
  ): RuntimeOperationFailure {
    this.#ownedForStop.delete(worker.id);
    this.#stopWorkspace.delete(worker.id);
    this.#unprovenOwnedPresence.set(worker.id, { identity: worker, reason });
    return runtimeFailure('stop_worker', reason);
  }

  #findOwnedPresence(
    worker: RuntimeWorkerIdentity,
    options: RuntimeCallOptions,
    strict = false,
  ): RuntimeResult<RuntimeWorker | null> {
    const current = super.findWorker(worker, options);
    if (!strict && current.status !== 'ok') return current;
    if (!strict && current.status === 'ok') return current;
    if (
      current.status === 'ok'
      && current.value
      && !sameRuntimeWorker(current.value.identity, worker)
    ) {
      // The worker-smoke identity stabilizer deliberately returns its
      // independently probed identity from the patched base lookup.
      return current;
    }
    const workspace = this.#stopWorkspace.get(worker.id) ?? 'active';
    const response = this.#run<OrcaTerminalListResult>(
      ['terminal', 'list', '--worktree', workspace],
      options,
    );
    if (!response.ok) {
      return runtimeFailure('find_worker', neutralFailureReason(response));
    }

    const terminals = response.result?.terminals;
    const totalCount = response.result?.totalCount;
    if (
      !Array.isArray(terminals)
      || response.result?.truncated !== false
      || !Number.isInteger(totalCount)
      || totalCount !== terminals.length
    ) {
      return runtimeFailure('find_worker', 'runtime_worker_list_incomplete');
    }

    const matches: RuntimeWorker[] = [];
    for (const terminal of terminals) {
      const id = terminal.handle?.trim();
      const generation = terminal.incarnationId?.trim();
      const workspacePath = terminal.worktreePath?.trim();
      if (!id || !generation || !workspacePath) {
        return runtimeUnsupported('find_worker', 'runtime_worker_identity_missing');
      }
      if (id !== worker.id) continue;
      matches.push({
        identity: { runtime: 'orca', id, generation },
        workspacePath,
        title: typeof terminal.title === 'string' ? terminal.title : null,
        provenance: 'external',
      });
    }
    if (matches.length > 1) {
      return runtimeFailure('find_worker', 'worker_identity_ambiguous');
    }
    const match = matches[0];
    if (match && !sameRuntimeWorker(match.identity, worker)) {
      return runtimeFailure('find_worker', 'worker_generation_mismatch');
    }
    if (match) return { status: 'ok', value: this.#assignmentProvenance(match) };
    return { status: 'ok', value: null };
  }

  #assignmentProvenance(worker: RuntimeWorker): RuntimeWorker {
    const assignmentOwned = this.#assignmentOwned.get(worker.identity.id);
    return assignmentOwned && sameRuntimeWorker(assignmentOwned, worker.identity)
      ? { ...worker, provenance: 'internal' }
      : worker;
  }

  override listWorkers(
    input: { readonly workspace?: 'active' | string },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<readonly RuntimeWorker[]> {
    const current = super.listWorkers(input, options);
    if (current.status !== 'ok') return current;
    return {
      status: 'ok',
      value: current.value.map((worker) => this.#assignmentProvenance(worker)),
    };
  }

  override findWorker(
    worker: RuntimeWorkerIdentity,
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker | null> {
    const unproven = this.#unprovenOwnedPresence.get(worker.id);
    if (unproven && sameRuntimeWorker(unproven.identity, worker)) {
      return runtimeFailure('find_worker', unproven.reason);
    }
    const current = super.findWorker(worker, options);
    if (current.status !== 'ok' || current.value === null) return current;
    return { status: 'ok', value: this.#assignmentProvenance(current.value) };
  }

  resolveAssignmentWorker(
    input: { readonly provider: string; readonly bindingKey: string },
    options: RuntimeCallOptions = {},
  ): ReturnType<NonNullable<import('../runtime/contracts.ts').RuntimeAdapter['resolveAssignmentWorker']>> {
    if (input.provider.trim().toLowerCase() !== 'orca') {
      return runtimeUnsupported('resolve_assignment_worker', 'assignment_provider_unsupported');
    }
    const dispatchId = input.bindingKey.trim();
    if (!dispatchId) return runtimeFailure('resolve_assignment_worker', 'assignment_binding_missing');
    const shown = this.#run<unknown>(
      ['orchestration', 'worker-show', '--dispatch', dispatchId],
      options,
    );
    if (!shown.ok) {
      if (isProducerBackedDispatchAbsent(shown, dispatchId)) {
        return { status: 'ok', value: { kind: 'gone' } };
      }
      return runtimeFailure('resolve_assignment_worker', neutralFailureReason(shown));
    }
    const parsed = parseOrcaWorkerShowResult(shown.result);
    if (!parsed) {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    const exact = parsed.observation?.exactWorker === true;
    if (!exact) {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    const observationStatus = parsed.observation?.status?.trim().toLowerCase() ?? '';
    if (observationStatus === 'exited'
      && parsed.terminalResource?.releaseState === 'released') {
      const resource = parsed.terminalResource;
      const resourceOwner = String(resource?.ownerDispatchId ?? '').trim();
      const workerId = String(
        resourceOwner === dispatchId
          ? resource?.terminalHandle
          : '',
      ).trim();
      const value = workerId
        ? { kind: 'gone' as const, workerId }
        : { kind: 'gone' as const };
      return { status: 'ok', value };
    }
    // Exact terminal presence is deliberately weaker than active Dispatch
    // authority. The active predicate additionally requires Orca's current
    // dispatch row plus a fresh accepted exact-assignee heartbeat; missing,
    // stale, malformed, unsupported, or contradictory lifecycle facts remain
    // fail-closed.
    const activity = classifyWorkerLifecycle(parsed);
    if (activity === 'unresolved') {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    if (activity === 'inactive') {
      const terminalSnapshot = snapshotFromWorkerShow(dispatchId, parsed);
      if (terminalSnapshot) {
        maybeNotifyRunOnTerminalDispatch(terminalSnapshot, {
          ledgerPath: resolveDispatchTerminalMailLedgerPath({ env: this.#options.env }),
          env: this.#options.env,
          runJson: this.#runJson,
        });
      }
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_inactive');
    }
    const terminalHandle = parsed.terminal?.handle?.trim()
      ?? parsed.worker?.agent_terminal_handle?.trim()
      ?? '';
    if (!terminalHandle) {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    const current = super.findWorkerById(terminalHandle, options);
    if (current.status !== 'ok') {
      return runtimeFailure('resolve_assignment_worker', current.reason);
    }
    if (current.value === null) {
      return runtimeFailure('resolve_assignment_worker', 'assignment_target_unresolved');
    }
    // A current PACK WorkerAssignment plus Orca's exact Dispatch-to-terminal
    // observation is the durable ownership witness across bounded adapter
    // processes. Retain only the resolved composite identity in memory so later
    // same-tick inventory/freshness checks preserve PACK provenance; generic
    // terminal discovery remains external and no runtime-private identity becomes durable.
    this.#assignmentOwned.set(current.value.identity.id, current.value.identity);
    return {
      status: 'ok',
      value: {
        kind: 'resolved',
        worker: this.#assignmentProvenance(current.value),
      },
    };
  }

  override spawnWorker(
    input: {
      readonly title: string;
      readonly command: string;
      readonly workspace?: 'active' | string;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<RuntimeWorker> {
    const result = super.spawnWorker(input, options);
    if (result.status === 'ok') {
      let worker = result.value;
      if (usesNativePtyFallback(worker.identity.generation)) {
        const exact = super.findWorkerById(worker.identity.id, options);
        if (exact.status !== 'ok') {
          return runtimeFailure('spawn_worker', `runtime_worker_identity_readback_failed:${exact.reason}`);
        }
        if (!exact.value) {
          return runtimeUnsupported('spawn_worker', 'runtime_worker_identity_missing');
        }
        this.rebindOpenCodeUrl(worker.identity, exact.value.identity);
        worker = { ...exact.value, provenance: 'internal' };
      }
      this.#unprovenOwnedPresence.delete(worker.identity.id);
      this.#ownedForStop.set(worker.identity.id, worker.identity);
      this.#stopWorkspace.set(worker.identity.id, input.workspace ?? 'active');
      return { status: 'ok', value: worker };
    }
    return result;
  }

  override stopWorker(
    worker: RuntimeWorkerIdentity,
    options: RuntimeCallOptions = {},
  ): RuntimeResult<{ readonly stopped: true }> {
    const owned = this.#ownedForStop.get(worker.id);
    if (!owned || !sameRuntimeWorker(owned, worker)) {
      return runtimeFailure('stop_worker', 'worker_not_owned_by_runtime_instance');
    }

    const current = this.#findOwnedPresence(worker, options);
    if (current.status !== 'ok') {
      return this.#recordUnprovenOwnedPresence(
        worker,
        `unproven_already_absent;inventory_error=${failureDetail(current)}`,
      );
    }
    if (current.value === null) {
      this.#ownedForStop.delete(worker.id);
      this.#stopWorkspace.delete(worker.id);
      return { status: 'ok', value: { stopped: true } };
    }

    // Consume authority before the destructive transport. A later caller cannot
    // infer from a failed or malformed response that the close did not happen.
    this.#ownedForStop.delete(worker.id);
    const response = this.#run(
      ['terminal', 'close', '--terminal', worker.id],
      options,
    );
    if (!response.ok) {
      const presence = this.#findOwnedPresence(
        worker,
        options,
        isRetryableTabNotFound(response),
      );
      if (presence.status === 'ok' && presence.value === null) {
        this.#stopWorkspace.delete(worker.id);
        return { status: 'ok', value: { stopped: true } };
      }
      if (presence.status !== 'ok') {
        const failure = this.#recordUnprovenOwnedPresence(
          worker,
          `unproven_already_absent;close_error=${neutralFailureReason(response)};inventory_error=${failureDetail(presence)}`,
        );
        return attachNativeRuntimeError(failure, response);
      }
      if (isRetryableTabNotFound(response)) {
        const retry = this.#run(
          ['terminal', 'close', '--terminal', worker.id],
          options,
        );
        if (retry.ok) {
          this.#stopWorkspace.delete(worker.id);
          return { status: 'ok', value: { stopped: true } };
        }

        const retryPresence = this.#findOwnedPresence(worker, options, true);
        if (retryPresence.status === 'ok' && retryPresence.value === null) {
          this.#stopWorkspace.delete(worker.id);
          return { status: 'ok', value: { stopped: true } };
        }
        if (retryPresence.status !== 'ok') {
          const failure = this.#recordUnprovenOwnedPresence(
            worker,
            `unproven_already_absent;close_error=${neutralFailureReason(retry)};inventory_error=${failureDetail(retryPresence)}`,
          );
          return attachNativeRuntimeError(failure, retry);
        }
        return attachNativeRuntimeError(
          runtimeFailure('stop_worker', neutralFailureReason(retry)),
          retry,
        );
      }
      return attachNativeRuntimeError(
        runtimeFailure('stop_worker', neutralFailureReason(response)),
        response,
      );
    }

    this.#stopWorkspace.delete(worker.id);
    return { status: 'ok', value: { stopped: true } };
  }

  removeWorkspace(
    input: {
      readonly workspacePath: string;
      readonly expectedHeadSha: string;
    },
    options: RuntimeCallOptions = {},
  ): RuntimeResult<{ readonly removed: true }> {
    const rawPath = input.workspacePath.trim();
    if (!rawPath) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_path_missing');
    }
    const expectedHeadSha = input.expectedHeadSha.trim().toLowerCase();
    if (!expectedHeadSha) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_expected_head_missing');
    }
    const requestedPath = resolve(rawPath);

    const shown = this.#run<OrcaWorktreeShow>(
      ['worktree', 'show', '--worktree', `path:${requestedPath}`],
      options,
    );
    if (!shown.ok) {
      return runtimeFailure('remove_workspace', neutralFailureReason(shown));
    }
    const worktree = shown.result?.worktree;
    const observedPath = worktree?.path?.trim();
    const worktreeId = worktree?.id?.trim();
    if (!observedPath || !worktreeId) {
      return runtimeUnsupported('remove_workspace', 'runtime_workspace_identity_missing');
    }
    if (resolve(observedPath) !== requestedPath) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_path_mismatch');
    }
    const observedHeadSha = worktree?.head?.trim().toLowerCase();
    if (observedHeadSha !== expectedHeadSha) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_head_mismatch');
    }

    const removed = this.#run<OrcaWorktreeRemoveResult>(
      ['worktree', 'rm', '--worktree', `id:${worktreeId}`, '--force'],
      options,
    );
    if (!removed.ok) {
      return runtimeFailure('remove_workspace', neutralFailureReason(removed));
    }
    if (removed.result?.removed === false) {
      return runtimeFailure('remove_workspace', 'runtime_workspace_not_removed');
    }
    return { status: 'ok', value: { removed: true } };
  }
}
