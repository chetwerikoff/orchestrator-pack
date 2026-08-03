import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSingleInstanceLease,
  readLiveSingleInstanceLease,
  releaseSingleInstanceLease,
} from './single-instance-lease.ts';

describe('single-instance process-generation lease', () => {
  it('rejects a second live owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-lease-'));
    try {
      const lockDir = join(root, 'supervisor.lock');
      const first = acquireSingleInstanceLease({ lockDir });
      expect(() => acquireSingleInstanceLease({ lockDir })).toThrow(/single_instance_busy/);
      expect(readLiveSingleInstanceLease(lockDir)?.generation).toBe(first.owner.generation);
      expect(releaseSingleInstanceLease(first)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not release a different generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-lease-'));
    try {
      const lockDir = join(root, 'supervisor.lock');
      const first = acquireSingleInstanceLease({ lockDir });
      expect(releaseSingleInstanceLease({
        ...first,
        owner: { ...first.owner, generation: 'foreign-generation' },
      })).toBe(false);
      expect(readLiveSingleInstanceLease(lockDir)).not.toBeNull();
      expect(releaseSingleInstanceLease(first)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
