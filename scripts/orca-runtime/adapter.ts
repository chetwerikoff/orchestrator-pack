import { randomUUID } from 'node:crypto';
import {
  asRuntimeObservationToken,
  type RuntimeAdapter,
  type RuntimeBoundedOutput,
  type RuntimeDispatchResult,
  type RuntimeHealth,
  type RuntimeLiveness,
  type RuntimeObservationToken,
  type RuntimeResult,
  type RuntimeWorker,
  type RuntimeWorkerIdentity,
} from '../runtime/contracts.ts';
import {
  closeOrcaTerminal,
  createOrcaTerminal,
  orcaExecutableLooksAvailable,
  probeOrcaWorktree,
  readOrcaTerminal,
  resolveOrcaExecutable,
  runOrcaJson,
  sendOrcaTerminal,
  submitOrcaTerminalComposer,
  waitOrcaTerminal,
  type OrcaJsonResponse,
  type OrcaRunOptions,
  type OrcaTerminalCreateResult,
  type OrcaTerminalReadResult,
  type OrcaWorktreeProbeResult,
} from './transport.ts';
import {
  confirmedGone,
  dispatchResult,
  failure,
  identityKey,
  nativeReason,
  object,
  opaqueHash,
  parseBoundedOutputPayload,
  parseTerminalRows,
  success,
  type NativeCursor,
} from './mapping.ts';

const ORCA_RUNTIME_NAME = 'orca';

type WorkerBinding = {
  readonly worker: RuntimeWorker;
  readonly handle: string;
  readonly nativeGeneration?: string;
};

type ObservationBinding = {
  readonly identityKey: string;
  readonly nativeCursor: NativeCursor;
  readonly outputFingerprint: string;
};

export interface OrcaRuntimeAdapterOptions extends OrcaRunOptions {
  readonly ownedWorkspacePaths?: readonly string[];
}

export class OrcaRuntimeAdapter implements RuntimeAdapter {
  readonly name = ORCA_RUNTIME_NAME;

  private readonly options: OrcaRuntimeAdapterOptions;
  private readonly bindingByGeneration = new Map<string, WorkerBinding>();
  private readonly ownedGenerations = new Set<string>();
  private readonly ownedWorkspacePaths: Set<string>;
  private readonly observationByToken = new Map<RuntimeObservationToken, ObservationBinding>();

  constructor(options: OrcaRuntimeAdapterOptions = {}) {
    this.options = options;
    this.ownedWorkspacePaths = new Set(options.ownedWorkspacePaths ?? []);
  }

  isAvailable(): boolean {
    if (this.options.runner) return true;
    const executable = this.options.executable ?? resolveOrcaExecutable(this.options.env);
    return orcaExecutableLooksAvailable(executable, this.options.env);
  }

  runJson<T>(args: readonly string[], options: OrcaRunOptions = {}): OrcaJsonResponse<T> {
    return runOrcaJson<T>(args, { ...this.options, ...options });
  }

  probeWorktree(cwd: string, options: Pick<OrcaRunOptions, 'timeoutMs'> = {}): OrcaWorktreeProbeResult {
    return probeOrcaWorktree(cwd, { ...this.options, ...options });
  }

  createTerminal(input: {
    readonly cwd: string;
    readonly title: string;
    readonly command: string;
    readonly worktree?: string;
    readonly timeoutMs?: number;
  }): OrcaTerminalCreateResult {
    return createOrcaTerminal({ ...this.options, ...input });
  }

  sendTerminal(handle: string, text: string, options: OrcaRunOptions = {}): OrcaJsonResponse {
    return sendOrcaTerminal(handle, text, { ...this.options, ...options });
  }

  submitTerminal(handle: string, options: OrcaRunOptions = {}): OrcaJsonResponse {
    return submitOrcaTerminalComposer(handle, { ...this.options, ...options });
  }

  readTerminal(
    handle: string,
    options: OrcaRunOptions & { readonly cursor?: number; readonly limit?: number } = {},
  ): OrcaJsonResponse<OrcaTerminalReadResult> {
    return readOrcaTerminal(handle, { ...this.options, ...options });
  }

  waitTerminal(
    handle: string,
    input: OrcaRunOptions & { readonly for: 'exit' | 'tui-idle'; readonly timeoutMs: number },
  ): OrcaJsonResponse {
    return waitOrcaTerminal(handle, { ...this.options, ...input });
  }

  closeTerminal(handle: string, options: OrcaRunOptions = {}): OrcaJsonResponse {
    return closeOrcaTerminal(handle, { ...this.options, ...options });
  }

  health(input: { readonly timeoutMs?: number } = {}): RuntimeResult<RuntimeHealth> {
    const response = this.runJson<unknown>(['status'], input);
    if (!response.ok) return failure('unavailable', nativeReason(response));
    const result = object(response.result);
    const runtime = object(result?.runtime);
    const reachable = runtime?.reachable;
    const state = runtime?.state;
    if (reachable === true || state === 'ready') return success('ready');
    if (reachable === false || typeof state === 'string') return failure('unavailable', 'orca_runtime_unavailable');
    return failure('unsupported', 'orca_status_unsupported');
  }

  listWorkers(input: {
    readonly workspacePath?: string;
    readonly timeoutMs?: number;
  }): RuntimeResult<readonly RuntimeWorker[]> {
    const args = ['terminal', 'list'];
    if (input.workspacePath) args.push('--worktree', `path:${input.workspacePath}`);
    const response = this.runJson<unknown>(args, input);
    if (!response.ok) {
      return failure(confirmedGone(response) ? 'gone' : 'unavailable', nativeReason(response));
    }
    const parsed = parseTerminalRows(response.result);
    if (!parsed.ok) return failure('unsupported', parsed.reason);
    const workers: RuntimeWorker[] = [];
    for (const row of parsed.rows) {
      if (input.workspacePath && row.worktreePath !== input.workspacePath) continue;
      const known = [...this.bindingByGeneration.values()].find((binding) => binding.handle === row.handle);
      const nativeGeneration = row.incarnationId ?? row.ptyId ?? row.handle;
      const preserveKnown = known?.nativeGeneration === nativeGeneration
        || (known?.worker.provenance === 'internal' && known.nativeGeneration === undefined);
      const worker = preserveKnown
        ? known!.worker
        : {
          identity: {
            id: opaqueHash('worker', [row.worktreePath, row.title ?? '', row.tabId ?? '', row.leafId ?? ''].join('\u0000')),
            generation: opaqueHash('generation', `${nativeGeneration}\u0000${randomUUID()}`),
          },
          workspacePath: row.worktreePath,
          provenance: 'external',
          runtime: this.name,
          ...(row.title === undefined ? {} : { title: row.title }),
        } satisfies RuntimeWorker;
      if (known && known.worker.identity.generation !== worker.identity.generation) {
        this.bindingByGeneration.delete(known.worker.identity.generation);
      }
      this.bindingByGeneration.set(worker.identity.generation, {
        worker,
        handle: row.handle,
        nativeGeneration,
      });
      workers.push(worker);
    }
    return success(workers);
  }

  findWorker(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly workspacePath?: string;
    readonly timeoutMs?: number;
  }): RuntimeResult<RuntimeWorker> {
    const listed = this.listWorkers(input);
    if (listed.status !== 'ok') return listed as RuntimeResult<RuntimeWorker>;
    const found = listed.value.find((worker) => identityKey(worker.identity) === identityKey(input.identity));
    return found ? success(found) : failure('gone', 'worker_generation_not_found');
  }

  spawnWorker(input: {
    readonly workspacePath: string;
    readonly title: string;
    readonly command: string;
    readonly timeoutMs?: number;
  }): RuntimeResult<RuntimeWorker> {
    const created = this.createTerminal({
      cwd: this.options.cwd ?? input.workspacePath,
      worktree: `path:${input.workspacePath}`,
      title: input.title,
      command: input.command,
      timeoutMs: input.timeoutMs,
    });
    if (!created.ok) return failure('unavailable', created.reason);
    const generation = opaqueHash('generation', randomUUID());
    const worker: RuntimeWorker = {
      identity: { id: opaqueHash('worker', randomUUID()), generation },
      workspacePath: input.workspacePath,
      provenance: 'internal',
      runtime: this.name,
      title: input.title,
    };
    this.ownedGenerations.add(generation);
    this.bindingByGeneration.set(generation, {
      worker,
      handle: created.terminal.handle,
      nativeGeneration: created.terminal.incarnationId
        ?? created.terminal.ptyId
        ?? undefined,
    });
    return success(worker);
  }

  sendInput(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly text: string;
    readonly timeoutMs?: number;
  }): RuntimeDispatchResult {
    const binding = this.resolveBinding(input.identity, input.timeoutMs);
    if (binding.status !== 'ok') {
      return { status: 'send_failed', attempts: 1, reason: binding.reason };
    }
    return dispatchResult(this.sendTerminal(binding.value.handle, input.text, { timeoutMs: input.timeoutMs }));
  }

  submitInput(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly timeoutMs?: number;
  }): RuntimeDispatchResult {
    const binding = this.resolveBinding(input.identity, input.timeoutMs);
    if (binding.status !== 'ok') {
      return { status: 'send_failed', attempts: 1, reason: binding.reason };
    }
    return dispatchResult(this.submitTerminal(binding.value.handle, { timeoutMs: input.timeoutMs }));
  }

  readBoundedOutput(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly previousObservationToken?: RuntimeObservationToken;
    readonly limit?: number;
    readonly timeoutMs?: number;
  }): RuntimeResult<RuntimeBoundedOutput> {
    const binding = this.resolveBinding(input.identity, input.timeoutMs);
    if (binding.status !== 'ok') {
      return failure(binding.status === 'gone' ? 'gone' : 'unknown', binding.reason);
    }
    const previous = input.previousObservationToken
      ? this.observationByToken.get(input.previousObservationToken)
      : undefined;
    if (input.previousObservationToken && (!previous || previous.identityKey !== identityKey(input.identity))) {
      return failure('unknown', 'observation_token_invalid_for_generation');
    }
    const args = ['terminal', 'read', '--terminal', binding.value.handle];
    if (previous?.nativeCursor !== null && previous?.nativeCursor !== undefined) {
      args.push('--cursor', String(previous.nativeCursor));
    }
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    const response = this.runJson<unknown>(args, input);
    if (!response.ok) {
      return failure(confirmedGone(response) ? 'gone' : 'unknown', nativeReason(response));
    }
    const parsed = parseBoundedOutputPayload(response.result);
    if (!parsed.ok) return failure('unsupported', parsed.reason);
    const outputFingerprint = opaqueHash('output', parsed.lines.join('\u0000'));
    const changed = previous === undefined
      ? parsed.lines.length > 0
      : parsed.nativeCursor !== previous.nativeCursor
        || outputFingerprint !== previous.outputFingerprint;
    const observationToken = !changed && input.previousObservationToken
      ? input.previousObservationToken
      : asRuntimeObservationToken(`observation_${randomUUID()}`);
    this.observationByToken.set(observationToken, {
      identityKey: identityKey(input.identity),
      nativeCursor: parsed.nativeCursor,
      outputFingerprint,
    });
    return success({ lines: parsed.lines, observationToken, changed });
  }

  liveness(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly boundMs: number;
  }): RuntimeLiveness {
    if (!Number.isFinite(input.boundMs) || input.boundMs <= 0) return 'unknown';
    const startedAt = Date.now();
    const binding = this.resolveBinding(input.identity, input.boundMs);
    if (binding.status !== 'ok') return binding.status === 'gone' ? 'gone' : 'unknown';
    const remainingMs = Math.floor(input.boundMs - (Date.now() - startedAt));
    if (remainingMs <= 0) return 'unknown';
    const response = this.runJson<unknown>([
      'terminal',
      'wait',
      '--terminal',
      binding.value.handle,
      '--for',
      'tui-idle',
      '--timeout-ms',
      String(remainingMs),
    ], { timeoutMs: remainingMs, killSignal: 'SIGKILL' });
    if (!response.ok) return confirmedGone(response) ? 'gone' : 'unknown';
    const result = object(response.result);
    const wait = object(result?.wait);
    if (!wait || typeof wait.satisfied !== 'boolean') return 'unknown';
    if (wait.status === 'exited' || wait.status === 'closed') return 'gone';
    return wait.satisfied ? 'idle' : 'busy';
  }

  stopWorker(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly timeoutMs?: number;
  }): RuntimeResult<{ readonly stopped: true }> {
    const binding = this.resolveBinding(input.identity, input.timeoutMs);
    if (binding.status !== 'ok') {
      return failure(binding.status === 'gone' ? 'gone' : 'unknown', binding.reason);
    }
    if (binding.value.worker.provenance !== 'internal' || !this.ownedGenerations.has(input.identity.generation)) {
      return failure('not_owned', 'external_worker_not_owned');
    }
    const response = this.closeTerminal(binding.value.handle, { timeoutMs: input.timeoutMs });
    if (!response.ok) return failure(confirmedGone(response) ? 'gone' : 'unknown', nativeReason(response));
    this.bindingByGeneration.delete(input.identity.generation);
    this.ownedGenerations.delete(input.identity.generation);
    return success({ stopped: true });
  }

  removeOwnedWorkspace(input: {
    readonly workspacePath: string;
    readonly timeoutMs?: number;
  }): RuntimeResult<{ readonly removed: true }> {
    if (!this.ownedWorkspacePaths.has(input.workspacePath)) {
      return failure('not_owned', 'workspace_not_owned_by_runtime');
    }
    const response = this.runJson<unknown>([
      'worktree',
      'rm',
      '--worktree',
      `path:${input.workspacePath}`,
    ], input);
    if (!response.ok) return failure('unknown', nativeReason(response));
    this.ownedWorkspacePaths.delete(input.workspacePath);
    return success({ removed: true });
  }

  private resolveBinding(
    identity: RuntimeWorkerIdentity,
    timeoutMs?: number,
  ): RuntimeResult<WorkerBinding> {
    const known = this.bindingByGeneration.get(identity.generation);
    const listed = this.listWorkers({
      workspacePath: known?.worker.workspacePath,
      timeoutMs,
    });
    if (listed.status !== 'ok') return listed as RuntimeResult<WorkerBinding>;
    const refreshed = this.bindingByGeneration.get(identity.generation);
    return refreshed && identityKey(refreshed.worker.identity) === identityKey(identity)
      ? success(refreshed)
      : failure('gone', 'worker_generation_not_found');
  }
}

export function createOrcaRuntimeAdapter(options: OrcaRuntimeAdapterOptions = {}): OrcaRuntimeAdapter {
  return new OrcaRuntimeAdapter(options);
}
