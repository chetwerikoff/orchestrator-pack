import type { RuntimeAdapter } from './contracts.ts';

export type RuntimeAdapterFactory = () => RuntimeAdapter | Promise<RuntimeAdapter>;

/** Static literal map: no discovery, registration side effects, or fallback. */
const DEFAULT_FACTORIES: Readonly<Record<string, RuntimeAdapterFactory>> = {
  orca: async () => {
    const { OrcaRuntimeAdapter } = await import('../orca-runtime/adapter.ts');
    return new OrcaRuntimeAdapter();
  },
};

export interface RuntimeSelectionOptions {
  readonly adapter?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Readonly<Record<string, RuntimeAdapterFactory>>;
}

/**
 * The only composition root for runtime selection.
 * Unknown selections fail before any adapter module or factory is loaded.
 */
export async function selectRuntimeAdapter(
  options: RuntimeSelectionOptions = {},
): Promise<RuntimeAdapter> {
  const requested = options.adapter
    ?? options.env?.OPK_RUNTIME_ADAPTER
    ?? process.env.OPK_RUNTIME_ADAPTER
    ?? 'orca';
  const factories = options.factories ?? DEFAULT_FACTORIES;
  const factory = factories[requested];
  if (!factory) {
    throw new Error(`unsupported_runtime_adapter:${requested}`);
  }
  return factory();
}
