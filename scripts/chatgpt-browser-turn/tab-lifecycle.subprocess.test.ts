import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runProcess } from '../kernel/subprocess.ts';

const fixture = join(import.meta.dirname, 'tab-lifecycle-subprocess-fixture.ts');

async function killAtBarrier(mode: 'before-link' | 'after-link') {
  const root = mkdtempSync(join(tmpdir(), `opk-1238-${mode}-`));
  const barrier = join(root, `${mode}.barrier`);
  const controller = new AbortController();
  const child = runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', fixture, mode, root],
    cwd: resolve(import.meta.dirname, '../..'),
    inheritParentEnv: true,
    signal: controller.signal,
    killGraceMs: 100,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(barrier)) {
      if (Date.now() >= deadline) throw new Error('fixture_barrier_timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const result = await child;
    expect(result.outcome).toBe('cancelled');
    return root;
  } catch (error) {
    controller.abort();
    await child.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe('Issue #1238 helper-termination publication barriers', () => {
  it('leaves no final path and no page-close actuation before final-link creation', async () => {
    const root = await killAtBarrier('before-link');
    try {
      expect(existsSync(join(root, 'reply.txt'))).toBe(false);
      expect(existsSync(join(root, 'before-link.page-close'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves exact final bytes recoverable and the page unclosed after final-link creation', async () => {
    const root = await killAtBarrier('after-link');
    try {
      expect(readFileSync(join(root, 'reply.txt'), 'utf8')).toBe('subprocess after-link reply');
      expect(existsSync(join(root, 'after-link.page-close'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
