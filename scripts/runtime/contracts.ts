export type RuntimeAdapterName = string;

export type RuntimeFailureStatus =
  | 'unsupported'
  | 'unavailable'
  | 'gone'
  | 'unknown'
  | 'not_owned';

export type RuntimeResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: RuntimeFailureStatus; readonly reason: string };

export interface RuntimeWorkerIdentity {
  readonly id: string;
  readonly generation: string;
}

export type RuntimeWorkerProvenance = 'internal' | 'external';

export interface RuntimeWorker {
  readonly identity: RuntimeWorkerIdentity;
  readonly workspacePath: string;
  readonly provenance: RuntimeWorkerProvenance;
  readonly runtime: RuntimeAdapterName;
  readonly title?: string;
}

export interface RuntimeWorkerRecord {
  readonly identity: RuntimeWorkerIdentity;
  readonly workspacePath: string;
  readonly runtime: RuntimeAdapterName;
}

export type RuntimeHealth = 'ready';

export type RuntimeDispatchStatus =
  | 'dispatched'
  | 'send_failed'
  | 'dispatch_unknown';

export interface RuntimeDispatchResult {
  readonly status: RuntimeDispatchStatus;
  readonly attempts: 1;
  readonly reason?: string;
}

export type RuntimeLiveness = 'busy' | 'idle' | 'gone' | 'unknown';

declare const runtimeObservationTokenBrand: unique symbol;

export type RuntimeObservationToken = string & {
  readonly [runtimeObservationTokenBrand]: true;
};

export function asRuntimeObservationToken(value: string): RuntimeObservationToken {
  return value as RuntimeObservationToken;
}

export interface RuntimeBoundedOutput {
  readonly lines: readonly string[];
  readonly observationToken: RuntimeObservationToken;
  readonly changed: boolean;
}

export interface RuntimeAdapter {
  readonly name: RuntimeAdapterName;

  isAvailable(): boolean;

  health(input?: { readonly timeoutMs?: number }): RuntimeResult<RuntimeHealth>;

  listWorkers(input: {
    readonly workspacePath?: string;
    readonly timeoutMs?: number;
  }): RuntimeResult<readonly RuntimeWorker[]>;

  findWorker(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly workspacePath?: string;
    readonly timeoutMs?: number;
  }): RuntimeResult<RuntimeWorker>;

  spawnWorker(input: {
    readonly workspacePath: string;
    readonly title: string;
    readonly command: string;
    readonly timeoutMs?: number;
  }): RuntimeResult<RuntimeWorker>;

  sendInput(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly text: string;
    readonly timeoutMs?: number;
  }): RuntimeDispatchResult;

  submitInput(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly timeoutMs?: number;
  }): RuntimeDispatchResult;

  readBoundedOutput(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly previousObservationToken?: RuntimeObservationToken;
    readonly limit?: number;
    readonly timeoutMs?: number;
  }): RuntimeResult<RuntimeBoundedOutput>;

  liveness(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly boundMs: number;
  }): RuntimeLiveness;

  stopWorker(input: {
    readonly identity: RuntimeWorkerIdentity;
    readonly timeoutMs?: number;
  }): RuntimeResult<{ readonly stopped: true }>;

  removeOwnedWorkspace(input: {
    readonly workspacePath: string;
    readonly timeoutMs?: number;
  }): RuntimeResult<{ readonly removed: true }>;
}
