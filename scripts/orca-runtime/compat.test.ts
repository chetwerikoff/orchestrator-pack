import { describe, expect, it, vi } from 'vitest';
import { readOrcaTerminal } from './compat.ts';

describe('Issue #1835 legacy screen observation', () => {
  it('does not expose or replay a synthetic screen cursor', () => {
    const runner = vi.fn((_command: string, args: readonly string[]) => ({
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        result: {
          terminal: {
            handle: args[args.indexOf('--terminal') + 1],
            status: 'running',
            tail: ['visible'],
            nextCursor: 'screen-frame',
            source: 'screen',
          },
        },
      }),
      stderr: '',
      status: 0,
      signal: null,
      error: undefined,
    })) as unknown as NonNullable<Parameters<typeof readOrcaTerminal>[1]>['runner'];

    const first = readOrcaTerminal('screen-terminal', { runner });
    expect(first.ok).toBe(true);
    expect(first.result?.source).toBe('screen');
    expect(first.result?.nextCursor).toBeUndefined();

    readOrcaTerminal('screen-terminal', { runner, cursor: first.result?.nextCursor });
    expect((runner as unknown as { mock: { calls: readonly [string, readonly string[]][] } }).mock.calls[1]?.[1]).not.toContain('--cursor');
  });
});
