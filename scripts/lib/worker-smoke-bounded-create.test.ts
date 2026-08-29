import { describe, expect, it } from 'vitest';
import { hasExecutorStartupBanner } from './worker-smoke-bounded-create.ts';

describe('Issue #1835 executor-aware worker startup witness', () => {
  it('accepts an OpenCode identity without accepting a Cursor-only banner', () => {
    const openCodeLines = ['OpenCode 1.18.25', 'OpenCode Zen · high'];
    expect(hasExecutorStartupBanner('opencode --agent pack-opk-fixture', openCodeLines)).toBe(true);
    expect(hasExecutorStartupBanner('cursor-agent', openCodeLines)).toBe(false);
  });

  it('keeps the Cursor startup witness intact', () => {
    const cursorLines = ['Cursor Agent', 'v1.2.3'];
    expect(hasExecutorStartupBanner('cursor-agent', cursorLines)).toBe(true);
    expect(hasExecutorStartupBanner('opencode --agent pack-opk-fixture', cursorLines)).toBe(false);
  });

  it('fails closed for ambiguous or unknown startup observations', () => {
    expect(hasExecutorStartupBanner('opencode --agent pack-opk-fixture', ['OpenCode'])).toBe(false);
    expect(hasExecutorStartupBanner('other-agent', ['OpenCode 1.18.25'])).toBe(false);
  });
});
