// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSmokeRequirement } from '../lib/worker-smoke-core.ts';

describe('Issue #2319 PR-owner smoke plan without retired worker preflight', () => {
  const issueBody = [
    '```behavior-kind', 'action-producing', '```',
    '```smoke-test-plan', 'scenarios:',
    '  - action: exercise a disposable fixture | expected: one observed passing outcome',
    '```',
  ].join('\n');

  it('keeps the complete Issue plan as the owner-executed publication contract', () => {
    const plan = resolveSmokeRequirement(issueBody);
    expect(plan.requirement).toBe('required');
    expect(plan.scenarios).toEqual([{
      action: 'exercise a disposable fixture',
      expected: 'one observed passing outcome',
    }]);
  });

  it('keeps publish free of retired preflight/selective-carry execution machinery', () => {
    const source = readFileSync(path.resolve('scripts/worker-smoke-run.ts'), 'utf8');
    const active = source.slice(source.indexOf('export async function runPublishSmoke('));
    expect(active).not.toContain('evaluateSmokePlanPreflight');
    expect(active).not.toContain('selectSmokeAttempt(');
    expect(active).not.toContain('planWorkerSmokeSelectiveRetry(');
    expect(source).not.toContain('runSmokeAttempt');
    expect(source).not.toContain('DetachedSmokeAttemptObservation');
  });
});
