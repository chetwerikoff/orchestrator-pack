import { describe, expect, it } from 'vitest';
import { resolveIterationId } from '../lib/iteration.js';

describe('resolveIterationId', () => {
  it('uses an explicit iteration id when provided', () => {
    expect(resolveIterationId({ explicitIterationId: 'iteration-123' })).toEqual({
      iteration_id: 'iteration-123',
      iteration_id_source: 'explicit',
    });
  });

  it('falls back to wrapper-generated ids', () => {
    const identity = resolveIterationId();
    expect(identity.iteration_id_source).toBe('wrapper_generated');
    expect(identity.iteration_id).toMatch(/^wrap-\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  });

  it('reuses a provided fallback iteration id for local amend flows', () => {
    expect(resolveIterationId({ fallbackIterationId: 'wrap-existing' })).toEqual({
      iteration_id: 'wrap-existing',
      iteration_id_source: 'wrapper_generated',
    });
  });

  it('prefers explicit iteration ids over fallback values', () => {
    expect(resolveIterationId({
      explicitIterationId: 'explicit-id', fallbackIterationId: 'wrap-existing',
    }).iteration_id).toBe('explicit-id');
  });
});
