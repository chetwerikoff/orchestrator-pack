import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { FALLBACK_DENYLIST, resolveIssueDenylist } from '../lib/denylist.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

describe('resolveIssueDenylist', () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('falls back to the pack-standard denylist when gh is unavailable', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('gh unavailable');
    });

    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(resolveIssueDenylist('.', 99)).toEqual([...FALLBACK_DENYLIST]);
    } finally {
      if (previous === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previous;
      }
    }
  });

  it('skips gh lookup under vitest and uses the fallback denylist', () => {
    process.env.VITEST = 'true';
    expect(resolveIssueDenylist('.', 99)).toEqual([...FALLBACK_DENYLIST]);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
