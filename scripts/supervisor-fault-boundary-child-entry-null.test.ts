import { describe, expect, it } from 'vitest';
import { supervisorTestTimeoutMs, runFaultBoundaryInjectionCase } from './supervisor-fault-boundary.shared.js';

describe.sequential('supervisor-fault-boundary (Issue #450 C5)', () => {
  it('keeps supervisor alive after ChildEntry null binding', async () => {
    await runFaultBoundaryInjectionCase('child-entry-null');
  }, supervisorTestTimeoutMs);
});
