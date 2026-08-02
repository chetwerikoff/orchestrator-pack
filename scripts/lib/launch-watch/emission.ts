import { once } from 'node:events';
import type { AnyResult } from './contract.ts';

export type EmissionResult = {
  readonly serialized: string;
  readonly serializationFallback: boolean;
};

function fallback(schema: 'launch-result/v1' | 'watch-result/v1'): Record<string, unknown> {
  const launch = schema === 'launch-result/v1';
  return {
    schema,
    outcome: 'emission-failed',
    phase: launch ? 'emission' : null,
    operation: null,
    sourceId: null,
    predicateId: null,
    reasonCode: 'emission_serialize_failed',
    retryAllowed: false,
    sourceIds: [launch ? 'pack.launch.emission' : 'pack.watch.emission'],
    observedAt: new Date().toISOString(),
    deadlineMs: launch ? 120_000 : 30_000,
    remediation: { action: 'record-and-stop', owner: 'wrapper', detail: '' },
    operatorDisposition: 'record-and-stop',
    evidence: {},
    terminal: null,
    containment: null,
    cleanup: null,
    primaryOutcome: null,
    primaryPhase: null,
    primaryOperation: null,
    primaryReasonCode: null,
  };
}

export function serializeResult(result: AnyResult | unknown): EmissionResult {
  const schema = result !== null && typeof result === 'object' && 'schema' in result
    && ((result as { readonly schema?: unknown }).schema === 'launch-result/v1'
      || (result as { readonly schema?: unknown }).schema === 'watch-result/v1')
    ? (result as { readonly schema: 'launch-result/v1' | 'watch-result/v1' }).schema
    : 'watch-result/v1';
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error('serializer returned undefined');
    return { serialized, serializationFallback: false };
  } catch {
    return { serialized: JSON.stringify(fallback(schema)), serializationFallback: true };
  }
}

export async function emitResult(
  result: AnyResult | unknown,
  output: NodeJS.WritableStream = process.stdout,
): Promise<{ readonly transportOk: boolean; readonly serializationFallback: boolean }> {
  const serialized = serializeResult(result);
  try {
    const data = `${serialized.serialized}\n`;
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      output.once('error', onError);
      const callback = (error?: Error | null): void => {
        output.removeListener('error', onError);
        if (error) reject(error); else resolvePromise();
      };
      const accepted = output.write(data, callback);
      if (!accepted && typeof output.once === 'function') void once(output, 'drain').catch(() => undefined);
    });
    return { transportOk: true, serializationFallback: serialized.serializationFallback };
  } catch {
    return { transportOk: false, serializationFallback: serialized.serializationFallback };
  }
}
