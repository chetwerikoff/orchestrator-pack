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

    expect(resolveIssueDenylist('.', 99)).toEqual([...FALLBACK_DENYLIST]);
  });
});
