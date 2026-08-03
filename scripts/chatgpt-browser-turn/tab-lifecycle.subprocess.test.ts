import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

const fixture = join(import.meta.dirname, 'tab-lifecycle-subprocess-fixture.ts');

async function killAtBarrier(mode: 'before-link' | 'after-link') {
  const root = mkdtempSync(join(tmpdir(), `opk-1238-${mode}-`));
  const barrier = join(root, `${mode}.barrier`);
  const child = spawn(process.execPath, ['--experimental-strip-types', fixture, mode, root], {
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(barrier)) {
      if (child.exitCode !== null) throw new Error(`fixture_exited_before_barrier:${child.exitCode}`);
      if (Date.now() >= deadline) throw new Error('fixture_barrier_timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill('SIGKILL');
    await once(child, 'close');
    return root;
  } catch (error) {
    child.kill('SIGKILL');
    await once(child, 'close').catch(() => undefined);
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
