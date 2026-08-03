import type { RuntimeAdapter } from './contracts.ts';

export type RuntimeAdapterFactory = () => RuntimeAdapter;

export type RuntimeSelectionFailureCode =
  | 'runtime_unknown'
  | 'runtime_unavailable';

export class RuntimeSelectionError extends Error {
  readonly code: RuntimeSelectionFailureCode;

  constructor(code: RuntimeSelectionFailureCode, runtimeName: string) {
    super(`${code}:${runtimeName}`);
    this.name = 'RuntimeSelectionError';
    this.code = code;
  }
}

export function selectRuntimeAdapter(input: {
  readonly runtimeName: string;
  readonly factories: Readonly<Record<string, RuntimeAdapterFactory>>;
}): RuntimeAdapter {
  const runtimeName = input.runtimeName.trim();
  const factory = input.factories[runtimeName];
  if (!factory) {
    throw new RuntimeSelectionError('runtime_unknown', runtimeName);
  }
  const adapter = factory();
  if (!adapter.isAvailable()) {
    throw new RuntimeSelectionError('runtime_unavailable', runtimeName);
  }
  return adapter;
}
