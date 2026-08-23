// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { describe, expect, it } from 'vitest';
import { formatSchedulerError, settleSchedulerAndComposer } from './scheduler.ts';

describe('scheduler/composer concurrency settlement', () => {
  it('preserves both failures when both concurrent phases reject', () => {
    const schedulerFailure = new Error('fleet failed');
    const composerFailure = new Error('composer failed');

    expect(() => settleSchedulerAndComposer(
      { status: 'rejected', reason: schedulerFailure },
      { status: 'rejected', reason: composerFailure },
    )).toThrowError(AggregateError);

    try {
      settleSchedulerAndComposer(
        { status: 'rejected', reason: schedulerFailure },
        { status: 'rejected', reason: composerFailure },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([schedulerFailure, composerFailure]);
      expect(formatSchedulerError(error)).toContain('fleet failed; composer failed');
    }
  });

  it('promotes a failed composer result so a fleet rejection keeps both causes', () => {
    expect(() => settleSchedulerAndComposer(
      { status: 'rejected', reason: new Error('fleet failed') },
      { status: 'fulfilled', value: { ok: false, terminals: [{ reason: 'screen unavailable' }] } },
    )).toThrow(/scheduler_and_composer_failed/);
    try {
      settleSchedulerAndComposer(
        { status: 'rejected', reason: new Error('fleet failed') },
        { status: 'fulfilled', value: { ok: false, terminals: [{ reason: 'screen unavailable' }] } },
      );
    } catch (error) {
      expect(formatSchedulerError(error)).toContain('fleet failed; composer_pass_failed:screen unavailable');
    }
  });
});
