// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { describe, expect, it } from 'vitest';
import { settleSchedulerAndComposer } from './scheduler.ts';

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
    }
  });
});
