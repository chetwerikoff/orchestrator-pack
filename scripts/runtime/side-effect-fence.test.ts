import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSideEffectFence,
  releaseSideEffectFence,
  withSideEffectFence,
} from './side-effect-fence.ts';

describe('TypeScript side-effect fence', () => {
  it('admits one owner and rejects a competing owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fence-'));
    try {
      const path = join(root, 'effect.lock');
      const first = acquireSideEffectFence({ path, metadata: { operation: 'review-start' } });
      expect(first.acquired).toBe(true);
      const second = acquireSideEffectFence({ path });
      expect(second).toEqual({ acquired: false, reason: 'side_effect_busy' });
      if (first.acquired) expect(releaseSideEffectFence(first.handle)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never deletes a replaced owner record on release', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fence-'));
    try {
      const path = join(root, 'effect.lock');
      const acquired = acquireSideEffectFence({ path });
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired) return;
      writeFileSync(path, JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        nonce: 'replacement',
        startedAtMs: Date.now(),
        metadata: {},
      }), 'utf8');
      expect(releaseSideEffectFence(acquired.handle)).toBe(false);
      expect(readFileSync(path, 'utf8')).toContain('replacement');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases after a fenced action', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-fence-'));
    try {
      const path = join(root, 'effect.lock');
      const result = await withSideEffectFence({ path, action: () => 42 });
      expect(result).toEqual({ ok: true, value: 42 });
      expect(acquireSideEffectFence({ path }).acquired).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
