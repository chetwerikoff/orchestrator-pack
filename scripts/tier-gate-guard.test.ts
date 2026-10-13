// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { describe, expect, it } from 'vitest';
import { checkTierGateGuard, checkWorkerSafetyFloor, formatTierGatePassMessage, parseComplexityTierFence } from './lib/tier-gate-core.ts';
import { canonicalizeEntry } from './pr-scope-declaration.ts';

const valid = `## Prerequisite
None.

## Goal
Ship it.

~~~behavior-kind
action-producing
~~~

~~~complexity-tier
tier: T2
failure-type: local-behavior
size: single-component-design-judgment
~~~

~~~positive-outcome
asserts: works
input: realistic
~~~

## Binding surface
Current component.

## Files in scope
- scripts/**

## Files out of scope
- vendor/**

~~~denylist
packages/core/**
vendor/**
~~~

~~~allowed-roots
scripts/**
~~~

## Acceptance criteria
1. Works.

## Upgrade-safety check
No duplicate path.

~~~smoke-test-plan
scenarios:
  - action: run | expected: pass
~~~

## Verification
- AC1: run.

~~~contract-evidence
none
~~~
`.replaceAll('~~~', String.fromCharCode(96).repeat(3));

describe('current substantive Issue floor', () => {
  it('accepts a complete T2 action-producing Issue body', () => {
    const result = checkTierGateGuard(valid);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(parseComplexityTierFence(valid)).toMatchObject({ kind: 'tier-fence', tier: 'T2' });
  });

  it('accepts below-the-ladder work without tier review while retaining substantive floors', () => {
    const noTier = valid.replace(
      'tier: T2\nfailure-type: local-behavior\nsize: single-component-design-judgment',
      'skip-line: true',
    );
    const result = checkTierGateGuard(noTier);
    expect(result.ok).toBe(true);
    expect(parseComplexityTierFence(noTier)).toEqual({ kind: 'no-tier', skipLine: true });
    expect(formatTierGatePassMessage(result)).toContain('PASS (no-tier skip-line)');
    const missingWorkerSafety = checkTierGateGuard(noTier.replaceAll('vendor/**\n', ''));
    expect(missingWorkerSafety.ok).toBe(false);
    expect(missingWorkerSafety.errors.join('\n')).toContain('vendor/**');
  });

  it('fails closed on missing worker-safety and body floors', () => {
    const result = checkTierGateGuard(valid
      .replace('packages/core/**\n', '')
      .replace('## Verification\n- AC1: run.\n\n', ''));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('packages/core/**');
    expect(result.errors.join('\n')).toContain('missing ## Verification');
  });

  it('accepts T1 denylist filename suffixes without widening the allowed-roots ceiling', () => {
    const realistic = valid
      .replace('tier: T2', 'tier: T1')
      .replace('size: single-component-design-judgment', 'size: small-obvious-self-contained')
      .replace(
        'packages/core/**\nvendor/**\n',
        'packages/core/**\nvendor/**\n.env*\n.env.*\nsecrets/key*\n',
      );
    expect(checkTierGateGuard(realistic)).toMatchObject({ ok: true, errors: [] });
    expect(checkWorkerSafetyFloor(realistic)).toEqual({ ok: true, errors: [] });
    expect(checkWorkerSafetyFloor(valid.replace('allowed-roots\nscripts/**\n', 'allowed-roots\nsrc/**\n')))
      .toEqual({ ok: true, errors: [] });
    expect(checkWorkerSafetyFloor(valid)).toEqual({ ok: true, errors: [] });
  });

  it('rejects malformed Issue policy entries with exact shared field/index errors', () => {
    const cases: Array<{ field: 'allowed_roots' | 'denylist'; pattern: string }> = [
      { field: 'allowed_roots', pattern: 'src/*.py' },
      { field: 'allowed_roots', pattern: 'scripts/*.ts' },
      { field: 'allowed_roots', pattern: 'plugins/**/tests/*.test.ts' },
      { field: 'allowed_roots', pattern: 'scripts/*/secret/**' },
      { field: 'denylist', pattern: 'scripts/*/secret/**' },
      { field: 'denylist', pattern: '**/credentials/**' },
      { field: 'denylist', pattern: '**/secrets/**' },
      { field: 'denylist', pattern: 'secrets/*.pem' },
      { field: 'denylist', pattern: 'scripts/*.ts' },
      { field: 'denylist', pattern: 'scripts/*' },
      { field: 'denylist', pattern: 'scripts/foo*bar' },
      { field: 'denylist', pattern: 'scripts/foo**' },
    ];
    for (const { field, pattern } of cases) {
      const index = field === 'denylist' ? 2 : 1;
      const canonical = canonicalizeEntry(pattern, field, index);
      expect(canonical.ok).toBe(false);
      if (canonical.ok) throw new Error('expected invalid canonicalization');
      const issue = field === 'denylist'
        ? valid.replace('packages/core/**\nvendor/**\n', 'packages/core/**\nvendor/**\n' + pattern + '\n')
        : valid.replace('allowed-roots\nscripts/**\n', 'allowed-roots\nscripts/**\n' + pattern + '\n');
      expect(checkWorkerSafetyFloor(issue).errors).toContain(canonical.error);
      expect(checkTierGateGuard(issue)).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([canonical.error]),
      });
    }
  });

  it('validates every repeated scope fence using parser-aligned entry indices', () => {
    const mark = String.fromCharCode(96).repeat(3);
    for (const { fence, field, pattern, index } of [
      { fence: 'denylist', field: 'denylist', pattern: 'secrets/*.pem', index: 2 },
      { fence: 'denylist', field: 'denylist', pattern: '**/credentials/**', index: 2 },
      { fence: 'allowed-roots', field: 'allowed_roots', pattern: 'scripts/*.ts', index: 1 },
    ] as const) {
      const issue = valid + ['', mark + fence, '# ignored comment', '', pattern, mark, ''].join('\n');
      const canonical = canonicalizeEntry(pattern, field, index);
      expect(canonical.ok).toBe(false);
      if (canonical.ok) throw new Error('expected invalid canonicalization');
      expect(checkWorkerSafetyFloor(issue)).toMatchObject({
        ok: false, errors: expect.arrayContaining([canonical.error]),
      });
      expect(checkTierGateGuard(issue)).toMatchObject({
        ok: false, errors: expect.arrayContaining([canonical.error]),
      });
    }

    // The required denies may also be split across multiple valid fences.
    const splitDenylist = valid.replace(
      'packages/core/**\nvendor/**\n', 'packages/core/**\n',
    ) + ['', mark + 'denylist', '# ignored comment', 'vendor/**', mark, ''].join('\n');
    expect(checkWorkerSafetyFloor(splitDenylist)).toEqual({ ok: true, errors: [] });
  });

  it('rejects an invalid tier without adding review topology', () => {
    const result = checkTierGateGuard(valid.replace('tier: T2', 'tier: T4'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('T1, T2, or T3');
  });
});
