import { realpathSync } from 'node:fs';
import type { OrcaRunOptions } from '../orca-runtime/native.ts';
import {
  type RuntimeAdapter,
  type RuntimeCallOptions,
  type RuntimeObservationToken,
  type RuntimeOperationFailure,
  type RuntimeOperationName,
  type RuntimeWorkerIdentity,
} from './contracts.ts';
import {
  selectRuntimeAdapterFactory,
  type RuntimeAdapterInstanceOptions,
} from './registry.ts';

export const ORCA_WORKER_SMOKE_CONTRACT_EVIDENCE_DIR =
  'tests/external-output-references/captures/orca-worker-smoke';

export const ORCA_SMOKE_CONTROL_PLANE_CODES = [
  'channel_stale_handle',
  'channel_lookup_empty',
  'channel_control_unavailable',
  'channel_control_overwritten',
] as const;

export type OrcaSmokeControlPlaneCode = (typeof ORCA_SMOKE_CONTROL_PLANE_CODES)[number];

export type OrcaOperationName =
  | 'worktree_current'
  | 'terminal_create'
  | 'terminal_list'
  | 'terminal_show'
  | 'terminal_send'
  | 'terminal_read'
  | 'terminal_wait'
  | 'terminal_submit'
  | 'terminal_close';

export type OrcaLocalOutcomeCategory =
  | 'process_launch_failed'
  | 'empty_stdout'
  | 'invalid_json'
  | 'recognized_control_plane_code'
  | 'supported_operation_failure';

export interface OrcaJsonResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
  operation?: OrcaOperationName;
  outcomeCategory?: OrcaLocalOutcomeCategory;
}

export interface OrcaTerminalHandle {
  handle: string;
  tabId?: string;
  worktreeId?: string;
  title?: string | null;
  ptyId?: string | null;
  incarnationId?: string | null;
}

export interface OrcaTerminalReadResult {
  lines?: string[];
  nextCursor?: number;
  oldestCursor?: number;
}

export interface OrcaOperationFailure {
  ok: false;
  reason: string;
  operation: OrcaOperationName;
  outcomeCategory?: OrcaLocalOutcomeCategory;
  errorCode?: string;
}

export type OrcaWorktreeProbeResult =
  | {
    ok: true;
    worktreePath: string;
    headSha?: string;
    linkedIssue?: number | null;
  }
  | OrcaOperationFailure;

export type OrcaTerminalCreateResult =
  | { ok: true; terminal: OrcaTerminalHandle }
  | OrcaOperationFailure;

type LegacyOptions = OrcaRunOptions;

interface CursorBinding {
  readonly token: RuntimeObservationToken;
  readonly worker: RuntimeWorkerIdentity;
}

interface CursorState {
  next: number;
  latest?: number;
  readonly byCompat: Map<number, CursorBinding>;
}

function legacyOperation(operation: RuntimeOperationName): OrcaOperationName {
  switch (operation) {
    case 'readiness': return 'worktree_current';
    case 'list_workers': return 'terminal_list';
    case 'find_worker_by_id':
    case 'find_worker': return 'terminal_show';
    case 'spawn_worker': return 'terminal_create';
    case 'dispatch_input': return 'terminal_send';
    case 'read_bounded_output': return 'terminal_read';
    case 'liveness': return 'terminal_wait';
    case 'stop_worker': return 'terminal_close';
  }
}

function failureCode(failure: RuntimeOperationFailure): string {
  return failure.reason || `runtime_${failure.status}`;
}

function legacyFailure(
  failure: RuntimeOperationFailure,
  operation = legacyOperation(failure.operation),
): OrcaOperationFailure {
  const code = failureCode(failure);
  return {
    ok: false,
    operation,
    reason: code,
    errorCode: code,
    outcomeCategory: code === 'runtime_unavailable'
      ? 'process_launch_failed'
      : code === 'runtime_response_invalid'
        ? 'invalid_json'
        : code === 'runtime_control_unavailable'
          ? 'recognized_control_plane_code'
          : 'supported_operation_failure',
  };
}

function responseFailure(
  failure: RuntimeOperationFailure,
  operation = legacyOperation(failure.operation),
): OrcaJsonResponse {
  const mapped = legacyFailure(failure, operation);
  return {
    ok: false,
    operation: mapped.operation,
    outcomeCategory: mapped.outcomeCategory,
    error: { code: mapped.errorCode, message: mapped.reason },
  };
}

function callOptions(options: LegacyOptions): RuntimeCallOptions {
  return {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
  };
}

function instanceOptions(options: LegacyOptions): RuntimeAdapterInstanceOptions {
  return {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    transport: {
      executable: options.executable,
      runner: options.runner,
      env: options.env,
      killSignal: options.killSignal,
    },
  };
}

export function isOrcaSmokeControlPlaneCode(
  value: string | undefined,
): value is OrcaSmokeControlPlaneCode {
  return (ORCA_SMOKE_CONTROL_PLANE_CODES as readonly string[]).includes(value ?? '');
}

export class RuntimeTaskCompatibilityFacade {
  readonly #defaultAdapter: RuntimeAdapter;
  readonly #adapterForOptions?: (options: LegacyOptions) => RuntimeAdapter;
  readonly #identities = new WeakMap<RuntimeAdapter, Map<string, RuntimeWorkerIdentity>>();
  readonly #cursors = new WeakMap<RuntimeAdapter, Map<string, CursorState>>();

  constructor(input: {
    readonly adapter: RuntimeAdapter;
    readonly adapterForOptions?: (options: LegacyOptions) => RuntimeAdapter;
  }) {
    this.#defaultAdapter = input.adapter;
    this.#adapterForOptions = input.adapterForOptions;
  }

  #adapter(options: LegacyOptions = {}): RuntimeAdapter {
    return this.#adapterForOptions?.(options) ?? this.#defaultAdapter;
  }

  #identityMap(adapter: RuntimeAdapter): Map<string, RuntimeWorkerIdentity> {
    let map = this.#identities.get(adapter);
    if (!map) {
      map = new Map();
      this.#identities.set(adapter, map);
    }
    return map;
  }

  #cursorMap(adapter: RuntimeAdapter): Map<string, CursorState> {
    let map = this.#cursors.get(adapter);
    if (!map) {
      map = new Map();
      this.#cursors.set(adapter, map);
    }
    return map;
  }

  #cursorState(adapter: RuntimeAdapter, handle: string): CursorState {
    const map = this.#cursorMap(adapter);
    let state = map.get(handle);
    if (!state) {
      state = { next: 1, byCompat: new Map() };
      map.set(handle, state);
    }
    return state;
  }

  #remember(adapter: RuntimeAdapter, identity: RuntimeWorkerIdentity): void {
    this.#identityMap(adapter).set(identity.id, identity);
  }

  #resolveIdentity(
    adapter: RuntimeAdapter,
    handle: string,
    options: LegacyOptions,
  ):
    | { ok: true; identity: RuntimeWorkerIdentity }
    | { ok: false; response: OrcaJsonResponse } {
    const remembered = this.#identityMap(adapter).get(handle);
    if (remembered) return { ok: true, identity: remembered };
    const found = adapter.findWorkerById(handle, callOptions(options));
    if (found.status !== 'ok') {
      return { ok: false, response: responseFailure(found) };
    }
    if (!found.value) {
      return {
        ok: false,
        response: {
          ok: false,
          operation: 'terminal_show',
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'worker_not_found', message: 'worker_not_found' },
        },
      };
    }
    this.#remember(adapter, found.value.identity);
    return { ok: true, identity: found.value.identity };
  }

  probeWorktree(cwd: string, options: LegacyOptions = {}): OrcaWorktreeProbeResult {
    const adapter = this.#adapter({ ...options, cwd });
    const result = adapter.readiness(callOptions({ ...options, cwd }));
    if (result.status !== 'ok') return legacyFailure(result, 'worktree_current');
    let resolvedCwd: string;
    let resolvedWorktree: string;
    try {
      resolvedCwd = realpathSync(cwd);
      resolvedWorktree = realpathSync(result.value.workspacePath);
    } catch {
      return {
        ok: false,
        operation: 'worktree_current',
        reason: 'cwd_not_orca_managed_worktree',
        errorCode: 'cwd_not_orca_managed_worktree',
        outcomeCategory: 'supported_operation_failure',
      };
    }
    if (resolvedCwd !== resolvedWorktree) {
      return {
        ok: false,
        operation: 'worktree_current',
        reason: 'cwd_not_orca_managed_worktree',
        errorCode: 'cwd_not_orca_managed_worktree',
        outcomeCategory: 'supported_operation_failure',
      };
    }
    return {
      ok: true,
      worktreePath: resolvedWorktree,
      headSha: result.value.headSha,
      linkedIssue: result.value.linkedIssue ?? null,
    };
  }

  createTerminal(input: {
    readonly cwd: string;
    readonly title: string;
    readonly command: string;
    readonly executable?: string;
    readonly runner?: OrcaRunOptions['runner'];
    readonly timeoutMs?: number;
  }): OrcaTerminalCreateResult {
    const adapter = this.#adapter(input);
    const result = adapter.spawnWorker(
      { title: input.title, command: input.command, workspace: 'active' },
      callOptions(input),
    );
    if (result.status !== 'ok') return legacyFailure(result, 'terminal_create');
    this.#remember(adapter, result.value.identity);
    return {
      ok: true,
      terminal: {
        handle: result.value.identity.id,
        title: result.value.title,
        incarnationId: result.value.identity.generation,
      },
    };
  }

  dispatch(
    handle: string,
    input: { readonly text?: string; readonly submitOnly?: boolean },
    options: LegacyOptions = {},
  ): OrcaJsonResponse {
    const adapter = this.#adapter(options);
    const resolved = this.#resolveIdentity(adapter, handle, options);
    if (!resolved.ok) return resolved.response;
    const result = adapter.dispatchInput(
      { worker: resolved.identity, text: input.text, submitOnly: input.submitOnly },
      callOptions(options),
    );
    if (result.status === 'dispatched') {
      return { ok: true, operation: input.submitOnly ? 'terminal_submit' : 'terminal_send' };
    }
    return {
      ok: false,
      operation: input.submitOnly ? 'terminal_submit' : 'terminal_send',
      outcomeCategory: result.status === 'dispatch_unknown'
        ? 'invalid_json'
        : 'supported_operation_failure',
      error: { code: result.reason, message: result.reason },
    };
  }

  readTerminal(
    handle: string,
    options: LegacyOptions & { readonly cursor?: number; readonly limit?: number } = {},
  ): OrcaJsonResponse<OrcaTerminalReadResult> {
    const adapter = this.#adapter(options);
    const resolved = this.#resolveIdentity(adapter, handle, options);
    if (!resolved.ok) return resolved.response;
    const state = this.#cursorState(adapter, handle);
    const previous = options.cursor === undefined ? undefined : state.byCompat.get(options.cursor);
    if (options.cursor !== undefined && !previous) {
      return {
        ok: false,
        operation: 'terminal_read',
        outcomeCategory: 'supported_operation_failure',
        error: {
          code: 'observation_token_unsupported',
          message: 'observation_token_unsupported',
        },
      };
    }
    const result = adapter.readBoundedOutput(
      {
        worker: resolved.identity,
        previousToken: previous?.token,
        limit: options.limit,
      },
      callOptions(options),
    );
    if (result.status !== 'ok') return responseFailure(result, 'terminal_read');
    let cursor = state.latest;
    if (!cursor || result.value.changed || !state.byCompat.has(cursor)) {
      cursor = state.next++;
      state.latest = cursor;
      state.byCompat.set(cursor, {
        token: result.value.observationToken,
        worker: result.value.worker,
      });
    }
    return {
      ok: true,
      operation: 'terminal_read',
      result: { lines: [...result.value.lines], nextCursor: cursor },
    };
  }

  waitTerminal(
    handle: string,
    input: LegacyOptions & { readonly for: 'exit' | 'tui-idle'; readonly timeoutMs: number },
  ): OrcaJsonResponse {
    const adapter = this.#adapter(input);
    const resolved = this.#resolveIdentity(adapter, handle, input);
    if (!resolved.ok) return resolved.response;
    const result = adapter.liveness(
      { worker: resolved.identity, observationWindowMs: input.timeoutMs },
      callOptions(input),
    );
    const exited = result.status === 'gone';
    const idle = result.status === 'idle';
    return {
      ok: true,
      operation: 'terminal_wait',
      result: {
        wait: {
          handle,
          condition: input.for,
          satisfied: input.for === 'exit' ? exited : idle,
          status: exited ? 'exited' : result.status === 'unknown' ? 'unknown' : 'running',
        },
      },
    };
  }

  closeTerminal(handle: string, options: LegacyOptions = {}): OrcaJsonResponse {
    const adapter = this.#adapter(options);
    const resolved = this.#resolveIdentity(adapter, handle, options);
    if (!resolved.ok) return resolved.response;
    const result = adapter.stopWorker(resolved.identity, callOptions(options));
    if (result.status !== 'ok') return responseFailure(result, 'terminal_close');
    this.#identityMap(adapter).delete(handle);
    this.#cursorMap(adapter).delete(handle);
    return { ok: true, operation: 'terminal_close', result: { stopped: true } };
  }
}

const selectedFactory = await selectRuntimeAdapterFactory();
const defaultAdapter = selectedFactory();
const runnerAdapters = new WeakMap<object, RuntimeAdapter>();
const transportAdapters = new Map<string, RuntimeAdapter>();

function defaultAdapterForOptions(options: LegacyOptions): RuntimeAdapter {
  if (options.runner && (typeof options.runner === 'function' || typeof options.runner === 'object')) {
    const key = options.runner as object;
    let adapter = runnerAdapters.get(key);
    if (!adapter) {
      adapter = selectedFactory(instanceOptions(options));
      runnerAdapters.set(key, adapter);
    }
    return adapter;
  }
  if (options.executable || options.env || options.killSignal) {
    const key = JSON.stringify({
      executable: options.executable ?? '',
      path: options.env?.PATH ?? '',
      killSignal: options.killSignal ?? '',
    });
    let adapter = transportAdapters.get(key);
    if (!adapter) {
      adapter = selectedFactory(instanceOptions(options));
      transportAdapters.set(key, adapter);
    }
    return adapter;
  }
  return defaultAdapter;
}

const defaultFacade = new RuntimeTaskCompatibilityFacade({
  adapter: defaultAdapter,
  adapterForOptions: defaultAdapterForOptions,
});

export function probeOrcaWorktree(
  cwd: string,
  options: { readonly executable?: string; readonly runner?: OrcaRunOptions['runner']; readonly timeoutMs?: number } = {},
): OrcaWorktreeProbeResult {
  return defaultFacade.probeWorktree(cwd, options);
}

export function createOrcaTerminal(input: {
  readonly cwd: string;
  readonly title: string;
  readonly command: string;
  readonly executable?: string;
  readonly runner?: OrcaRunOptions['runner'];
  readonly timeoutMs?: number;
}): OrcaTerminalCreateResult {
  return defaultFacade.createTerminal(input);
}

export function sendOrcaTerminal(
  handle: string,
  text: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return defaultFacade.dispatch(handle, { text }, options);
}

export function submitOrcaTerminalComposer(
  handle: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return defaultFacade.dispatch(handle, { submitOnly: true }, options);
}

export function readOrcaTerminal(
  handle: string,
  options: OrcaRunOptions & { readonly cursor?: number; readonly limit?: number } = {},
): OrcaJsonResponse<OrcaTerminalReadResult> {
  return defaultFacade.readTerminal(handle, options);
}

export function waitOrcaTerminal(
  handle: string,
  input: OrcaRunOptions & { readonly for: 'exit' | 'tui-idle'; readonly timeoutMs: number },
): OrcaJsonResponse {
  return defaultFacade.waitTerminal(handle, input);
}

export function closeOrcaTerminal(
  handle: string,
  options: OrcaRunOptions = {},
): OrcaJsonResponse {
  return defaultFacade.closeTerminal(handle, options);
}
