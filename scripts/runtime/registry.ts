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

/** Static literal map: no discovery, registration side effects, or fallback. */
const DEFAULT_FACTORIES: Readonly<Record<string, RuntimeAdapterFactory>> = {
  orca: async (options = {}) => {
    const [{ OrcaTaskRuntimeAdapter }, { runOrcaJson }] = await Promise.all([
      import('../orca-runtime/task-adapter.ts'),
      import('../orca-runtime/native.ts'),
    ]);
    return new OrcaTaskRuntimeAdapter({
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      executable: options.transport?.executable,
      runner: options.transport?.runner as typeof runOrcaJson extends (
        args: readonly string[],
        options?: infer T,
      ) => unknown
        ? T extends { runner?: infer R }
          ? R
          : never
        : never,
      env: options.transport?.env,
      killSignal: options.transport?.killSignal,
    });
  },
};

export interface RuntimeSelectionOptions {
  readonly adapter?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimeAdapterFactory>>;
}

function resolveSelection(options: RuntimeSelectionOptions): {
  readonly requested: string;
  readonly factory: RuntimeAdapterFactory;
} {
  const requested = options.adapter
    ?? options.env?.OPK_RUNTIME_ADAPTER
    ?? process.env.OPK_RUNTIME_ADAPTER
    ?? 'orca';
  const factories = options.factories ?? DEFAULT_FACTORIES;
  const factory = factories[requested];
  if (!factory) {
    throw new Error(`unsupported_runtime_adapter:${requested}`);
  }
  return { requested, factory };
}

/**
 * The only composition root for runtime selection.
 * Unknown selections fail before any adapter module or factory is loaded.
 */
export async function selectRuntimeAdapterFactory(
  options: RuntimeSelectionOptions = {},
): Promise<(instanceOptions?: RuntimeAdapterInstanceOptions) => RuntimeAdapter> {
  const { factory } = resolveSelection(options);
  return asyncFactoryToLoadedFactory(factory);
}

async function asyncFactoryToLoadedFactory(
  factory: RuntimeAdapterFactory,
): Promise<(instanceOptions?: RuntimeAdapterInstanceOptions) => RuntimeAdapter> {
  /*
   * Load the selected adapter exactly once before exposing a synchronous caller
   * factory. The default factory returns a fresh adapter for every invocation;
   * focused tests can still supply a deterministic synchronous factory.
   */
  const first = await factory();
  if (!(first instanceof Promise)) {
    let firstAvailable = true;
    return (instanceOptions = {}) => {
      if (firstAvailable && Object.keys(instanceOptions).length === 0) {
        firstAvailable = false;
        return first;
      }
      const next = factory(instanceOptions);
      if (next instanceof Promise) {
        throw new Error('runtime_adapter_factory_became_async_after_selection');
      }
      return next;
    };
  }
  throw new Error('runtime_adapter_factory_load_contract_invalid');
}

export async function selectRuntimeAdapter(
  options: RuntimeSelectionOptions = {},
  instanceOptions: RuntimeAdapterInstanceOptions = {},
): Promise<RuntimeAdapter> {
  const { factory } = resolveSelection(options);
  return factory(instanceOptions);
}
