import { describe, expect, it } from 'vitest';
import {
  checkPrScope,
  formatScopeCheckComment,
  RUNTIME_HISTORY_DELIVERY_BRANCH,
  RUNTIME_HISTORY_DELIVERY_PATH,
  type PrScopeCheckInput,
} from './pr-scope-check.js';

const baseInput: PrScopeCheckInput = {
  repoRoot: '.',
  prBody: 'generated runtime-history refresh',
  issueBody: null,
  prPaths: [RUNTIME_HISTORY_DELIVERY_PATH],
  degradedMode: false,
  forkPr: false,
  prHeadRef: RUNTIME_HISTORY_DELIVERY_BRANCH,
};

describe('runtime-history delivery closing-reference exemption', () => {
  it('passes only the same-repo fixed branch with the exact single-file diff', () => {
    const result = checkPrScope(baseInput);

    expect(result).toMatchObject({
      ok: true,
      mode: 'runtime-history-delivery',
      checkedPaths: [RUNTIME_HISTORY_DELIVERY_PATH],
    });
    expect(formatScopeCheckComment(result)).toContain(
      'Scope guard — passed (runtime-history delivery)',
    );
  });

  it.each([
    ['missing branch signal', { prHeadRef: '' }],
    ['wrong branch', { prHeadRef: 'feature/not-runtime-history-delivery' }],
    ['fork PR', { forkPr: true }],
  ])('does not exempt %s', (_name, overrides) => {
    expect(checkPrScope({ ...baseInput, ...overrides })).toMatchObject({
      ok: false,
      reason: 'missing_issue_link',
    });
  });

  it('keeps the exact path constraint independent from the closing-ref exemption', () => {
    expect(
      checkPrScope({
        ...baseInput,
        prPaths: [RUNTIME_HISTORY_DELIVERY_PATH, 'README.md'],
      }),
    ).toMatchObject({
      ok: false,
      reason: 'scope_violation',
      violations: {
        outOfScope: ['README.md'],
      },
    });
  });

  it('rejects a wrong single file on the otherwise exempt branch', () => {
    expect(
      checkPrScope({
        ...baseInput,
        prPaths: ['scripts/other.json'],
      }),
    ).toMatchObject({
      ok: false,
      reason: 'scope_violation',
    });
  });
});
