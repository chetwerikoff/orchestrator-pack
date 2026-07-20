import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  installEgressTrap,
  runThreeSubjectAssembly,
  tempRoot,
} from './task-311-common.test-support.js';

declare global {
  interface Array<T> {
    findLast(
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): T | undefined;
  }
}

describe('TASK-311 real surviving review-cycle assembly gate', () => {
  it('diagnostic: drives only the three real subjects through the egress trap', async () => {
    const trapRoot = tempRoot('task-311-egress-');
    const trap = installEgressTrap(trapRoot);
    try {
      expect(trap.active).toBe(true);
      expect(trap.attempts()).toEqual([]);
      const assembled = await runThreeSubjectAssembly(trap);
      expect((assembled.assembly as any).binding.consumer.source).toBe('cache');
      expect((assembled.assembly as any).identity).toBe('one-pr-head-worker-chain');
      expect(trap.attempts()).toEqual([]);
    } finally {
      trap.restore();
      rmSync(trapRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
