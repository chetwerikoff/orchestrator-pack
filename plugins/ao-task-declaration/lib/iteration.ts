import { randomUUID } from 'node:crypto';
import type { IterationIdSource } from '@orchestrator-pack/shared/lib/declaration_schema.js';

export interface IterationIdentity {
  iteration_id: string;
  iteration_id_source: IterationIdSource;
}

function utcTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Resolve iteration identity per architecture decision #3.B.
 */
export function resolveIterationId(env: NodeJS.ProcessEnv = process.env): IterationIdentity {
  const sessionId = env.AO_SESSION_ID?.trim();
  if (sessionId) {
    return {
      iteration_id: sessionId,
      iteration_id_source: 'ao_session',
    };
  }

  const shortUuid = randomUUID().split('-')[0];
  return {
    iteration_id: `wrap-${utcTimestamp()}-${shortUuid}`,
    iteration_id_source: 'wrapper_generated',
  };
}
