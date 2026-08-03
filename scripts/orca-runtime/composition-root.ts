import { createOrcaRuntimeAdapter, type OrcaRuntimeAdapterOptions } from './adapter.ts';
import { RuntimeSelectionError, selectRuntimeAdapter } from '../runtime/registry.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';

export const DEFAULT_RUNTIME_ADAPTER = 'orca';
export const RUNTIME_ADAPTER_ENV = 'OPK_RUNTIME_ADAPTER';

export function createSelectedRuntime(input: {
  readonly runtimeName?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly orca?: OrcaRuntimeAdapterOptions;
  readonly availabilityTimeoutMs?: number;
} = {}): RuntimeAdapter {
  const runtimeName = input.runtimeName
    ?? input.env?.[RUNTIME_ADAPTER_ENV]
    ?? process.env[RUNTIME_ADAPTER_ENV]
    ?? DEFAULT_RUNTIME_ADAPTER;
  const adapter = selectRuntimeAdapter({
    runtimeName,
    factories: {
      orca: () => createOrcaRuntimeAdapter({ env: input.env, ...input.orca }),
    },
  });
  const health = adapter.health({ timeoutMs: input.availabilityTimeoutMs ?? 5_000 });
  if (health.status !== 'ok') {
    throw new RuntimeSelectionError('runtime_unavailable', runtimeName);
  }
  return adapter;
}
