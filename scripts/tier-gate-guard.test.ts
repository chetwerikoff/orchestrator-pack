// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { describe, expect, it } from 'vitest';
import { checkTierGateGuard, formatTierGatePassMessage, parseComplexityTierFence } from './lib/tier-gate-core.ts';

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

  it('rejects an invalid tier without adding review topology', () => {
    const result = checkTierGateGuard(valid.replace('tier: T2', 'tier: T4'));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('T1, T2, or T3');
  });
});
