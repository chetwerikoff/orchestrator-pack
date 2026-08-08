// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { describe, expect, it } from 'vitest';
import { scanRetiredRuntimeSurfaces } from './retired-surface-guard.ts';

describe('Issue 1352 active test scan diagnostic', () => {
  it('prints every current retired-surface hit', () => {
    const result = scanRetiredRuntimeSurfaces({ repoRoot: process.cwd() });
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
