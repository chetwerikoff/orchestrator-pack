// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSmokeAgentPrompt, resolveSmokeRequirement } from '../lib/worker-smoke-core.ts';

describe('Issue #2250 independent smoke plan without retired preflight', () => {
  const issueBody = [
    '```behavior-kind', 'action-producing', '```',
    '```smoke-test-plan', 'scenarios:',
    '  - action: exercise a disposable fixture | expected: one observed passing outcome',
    '```',
  ].join('\n');

  it('passes the complete Issue plan to the existing smoke worker without a durable lifecycle binding', () => {
    const plan = resolveSmokeRequirement(issueBody);
    expect(plan.requirement).toBe('required');
    expect(plan.scenarios).toHaveLength(1);
    const prompt = buildSmokeAgentPrompt({
      issueNumber: 2250, issueBody, prNumber: 2280,
      headSha: 'a'.repeat(40), plan,
    });
    expect(prompt).toContain('action: exercise a disposable fixture');
    expect(prompt).toContain('expected: one observed passing outcome');
    expect(prompt).toContain('```worker-smoke-report');
    expect(prompt).not.toContain('Durable smoke-run binding');
    expect(prompt).not.toContain('artifact-dir:');
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
