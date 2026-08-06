import { randomUUID } from 'node:crypto';
import type { IterationIdSource } from '@orchestrator-pack/shared/lib/declaration_schema.js';

export interface IterationIdentity {
  iteration_id: string;
  iteration_id_source: IterationIdSource;
}

function utcTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export interface ResolveIterationOptions {
  explicitIterationId?: string;
  fallbackIterationId?: string | null;
}

/**
 * Resolve iteration identity per architecture decision #3.B.
 */
export function resolveIterationId(
  options: ResolveIterationOptions = {},
): IterationIdentity {
  if (options.explicitIterationId?.trim()) {
    return {
      iteration_id: options.explicitIterationId.trim(),
      iteration_id_source: 'explicit',
    };
  }

  if (options.fallbackIterationId?.trim()) {
    return {
      iteration_id: options.fallbackIterationId.trim(),
      iteration_id_source: 'wrapper_generated',
    };
  }

  const shortUuid = randomUUID().split('-')[0];
  return {
    iteration_id: `wrap-${utcTimestamp()}-${shortUuid}`,
    iteration_id_source: 'wrapper_generated',
  };
}
