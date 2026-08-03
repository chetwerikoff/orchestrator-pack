import { describe, expect, it } from 'vitest';
import {
  RUNTIME_CALLER_CENSUS,
  validateRuntimeCallerCensus,
} from './caller-census.ts';

describe('runtime caller census', () => {
  it('is complete for mandatory supervisor invariants', () => {
    expect(validateRuntimeCallerCensus()).toEqual([]);
  });

  it('keeps AO service operations outside RuntimeAdapter', () => {
    const serviceRows = RUNTIME_CALLER_CENSUS.filter(
      (row) => row.kind === 'non-runtime-ao-service',
    );
    expect(serviceRows.length).toBeGreaterThan(0);
    expect(serviceRows.every((row) => row.disposition === 'defer-1250')).toBe(true);
  });

  it('retains the closed send outcome in the runtime contract', async () => {
    const { RUNTIME_DISPATCH_RESULTS } = await import('./contracts.ts');
    expect(RUNTIME_DISPATCH_RESULTS).toEqual([
      'dispatched',
      'send_failed',
      'dispatch_unknown',
    ]);
  });
});
