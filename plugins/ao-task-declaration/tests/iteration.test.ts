import { afterEach, describe, expect, it } from 'vitest';
import { resolveIterationId } from '../lib/iteration.js';

describe('resolveIterationId', () => {
  const originalSessionId = process.env.AO_SESSION_ID;

  afterEach(() => {
    if (originalSessionId === undefined) {
      delete process.env.AO_SESSION_ID;
    } else {
      process.env.AO_SESSION_ID = originalSessionId;
    }
  });

  it('uses AO_SESSION_ID when present', () => {
    const identity = resolveIterationId({ AO_SESSION_ID: 'sess-123' });
    expect(identity).toEqual({
      iteration_id: 'sess-123',
      iteration_id_source: 'ao_session',
    });
  });

  it('falls back to wrapper-generated ids when AO session id is missing', () => {
    const identity = resolveIterationId({});
    expect(identity.iteration_id_source).toBe('wrapper_generated');
    expect(identity.iteration_id).toMatch(/^wrap-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  });
});
