// @vitest-ci-lane light
import { describe, expect, it } from 'vitest';
import { OrcaTaskRuntimeAdapter } from './task-adapter.ts';
import type { OrcaJsonResponse } from './native.ts';

describe('Issue #2814 producer-terminal assignment lifecycle', () => {
  it.each([
    ['completed', 'succeeded', 'settled'],
    ['failed', 'abandoned', 'terminal_missing'],
    ['failed', 'abandoned', 'terminal_missing'],
    ['failed', 'abandoned', 'terminal_missing'],
    ['circuit_broken', 'failed', 'terminal'],
  ])('classifies %s / %s / %s with a missing terminal as gone', (status, state, stage) => {
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: (() => ({ ok: true, result: {
      dispatch: { status }, worker: { state, stage },
      observation: { exactWorker: false, status: 'missing' },
      terminalResource: { releaseState: 'not_requested' },
    } })) as never });
    expect(adapter.observeAssignmentLifecycle({ provider: 'orca', bindingKey: 'dispatch-2814' }))
      .toEqual({ status: 'ok', value: { kind: 'gone', evidence: 'producer_exact_absence' } });
  });

  it.each([
    ['failed', 'live'], ['dispatched', 'missing'], ['', 'missing'], ['completed', 'unknown'],
  ])('keeps %s / inexact %s unresolved', (status, observationStatus) => {
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: (() => ({ ok: true, result: {
      dispatch: { status }, observation: { exactWorker: false, status: observationStatus },
    } })) as never });
    expect(adapter.observeAssignmentLifecycle({ provider: 'orca', bindingKey: 'dispatch-2814' }))
      .toMatchObject({ status: 'failed', reason: 'assignment_target_unresolved' });
  });

  it.each<OrcaJsonResponse>([
    { ok: true, result: null },
    { ok: false, error: { code: 'timeout', message: 'timed out' } },
  ])('never turns malformed or failed reads into absence', (response) => {
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: (() => response) as never });
    expect(adapter.observeAssignmentLifecycle({ provider: 'orca', bindingKey: 'dispatch-2814' }).status)
      .toBe('failed');
  });
});
