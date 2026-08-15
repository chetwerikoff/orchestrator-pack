import type { OrcaRunOptions } from '../orca-runtime/native.ts';
import type { RuntimeAdapter } from './contracts.ts';

export interface RuntimeAdapterInstanceOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Composition-root-only transport overrides used by focused adapter tests. */
  readonly transport?: {
    readonly executable?: string;
    readonly runner?: unknown;
    readonly env?: NodeJS.ProcessEnv;
    readonly killSignal?: NodeJS.Signals;
  };
}

export type RuntimeAdapterFactory = (
  options?: RuntimeAdapterInstanceOptions,
) => RuntimeAdapter | Promise<RuntimeAdapter>;

type LoadedRuntimeAdapterFactory = (
  options?: RuntimeAdapterInstanceOptions,
) => RuntimeAdapter;

type RuntimeAdapterLoader = () => Promise<LoadedRuntimeAdapterFactory>;

/** Static literal map: no discovery, registration side effects, or fallback. */
const DEFAULT_LOADERS: Readonly<Record<string, RuntimeAdapterLoader>> = {
  orca: async () => {
    const { OrcaTaskRuntimeAdapter } = await import('../orca-runtime/task-adapter.ts');
    return (options = {}) => new OrcaTaskRuntimeAdapter({
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      executable: options.transport?.executable,
      runner: options.transport?.runner as OrcaRunOptions['runner'],
      env: options.transport?.env,
      killSignal: options.transport?.killSignal,
    });
  },
};

export interface RuntimeSelectionOptions {
  readonly adapter?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test-only deterministic factories; production selection uses DEFAULT_LOADERS. */
  readonly factories?: Readonly<Record<string, RuntimeAdapterFactory>>;
}

function requestedAdapter(options: RuntimeSelectionOptions): string {
  return options.adapter
    ?? options.env?.OPK_RUNTIME_ADAPTER
    ?? process.env.OPK_RUNTIME_ADAPTER
    ?? 'orca';
}

function isVitestHarness(options: RuntimeSelectionOptions): boolean {
  return (options.env?.OPK_VITEST_HARNESS ?? process.env.OPK_VITEST_HARNESS) === '1';
}

/**
 * The only composition root for runtime selection.
 * Unknown selections fail before any adapter module or factory is loaded.
 */
export async function selectRuntimeAdapterFactory(
  options: RuntimeSelectionOptions = {},
): Promise<LoadedRuntimeAdapterFactory> {
  const requested = requestedAdapter(options);
  if (options.factories) {
    const factory = options.factories[requested];
    if (!factory) {
      throw new Error(`unsupported_runtime_adapter:${requested}`);
    }
    const first = await factory();
    let firstAvailable = true;
    return (instanceOptions = {}) => {
      if (firstAvailable && Object.keys(instanceOptions).length === 0) {
        firstAvailable = false;
        return first;
      }
      const next = factory(instanceOptions);
      if (next instanceof Promise) {
        throw new Error('runtime_test_factory_requires_async_selection');
      }
      return next;
    };
  }

  if (requested === 'process-fixture') {
    if (!isVitestHarness(options)) throw new Error('unsupported_runtime_adapter:process-fixture');
    const { ProcessFixtureRuntimeAdapter } = await import('./process-fixture-adapter.ts');
    return (instanceOptions = {}) => new ProcessFixtureRuntimeAdapter(instanceOptions.transport?.env ?? process.env);
  }

  const loader = DEFAULT_LOADERS[requested];
  if (!loader) {
    throw new Error(`unsupported_runtime_adapter:${requested}`);
  }
  return loader();
}

export async function selectRuntimeAdapter(
  options: RuntimeSelectionOptions = {},
  instanceOptions: RuntimeAdapterInstanceOptions = {},
): Promise<RuntimeAdapter> {
  if (options.factories) {
    const requested = requestedAdapter(options);
    const factory = options.factories[requested];
    if (!factory) {
      throw new Error(`unsupported_runtime_adapter:${requested}`);
    }
    return factory(instanceOptions);
  }
  const factory = await selectRuntimeAdapterFactory(options);
  return factory(instanceOptions);
}
