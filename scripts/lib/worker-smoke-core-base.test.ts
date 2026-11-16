import { describe, expect, it } from 'vitest';
import { parseSealedSmokeAgentReport, parseSmokeTestPlan } from './worker-smoke-core-base.ts';

const ACTION = 'verify the raise decision';
const PIPE_EXPECTED = 'raise_nonallin|jam -> raise';

function sealedReport(scenarioLines: string): string {
  return [
    '```worker-smoke-report',
    'result: PASS',
    'tracked-files-unmodified: true',
    scenarioLines,
    '```',
  ].join('\n');
}

describe('Issue #2837 smoke scenario field delimiters', () => {
  it('preserves the plan expected byte-for-byte and leaves ordinary rows unchanged', () => {
    for (const expected of [PIPE_EXPECTED, 'raise']) {
      const plan = [
        '```smoke-test-plan',
        'scenarios:',
        `- action: ${ACTION} | expected: ${expected}`,
        '```',
      ].join('\n');
      const parsedPlan = parseSmokeTestPlan(plan);
      const parsedReport = parseSealedSmokeAgentReport(sealedReport(
        `scenarios:\n- action: ${ACTION} | expected: ${expected} | observed: raise | outcome: pass`,
      ));

      expect(parsedPlan?.scenarios).toHaveLength(1);
      expect(parsedReport?.scenarios).toHaveLength(1);
      expect(parsedReport?.scenarios?.[0]?.action).toBe(ACTION);
      expect(parsedReport?.scenarios?.[0]?.expected).toBe(expected);
      expect(parsedReport?.scenarios?.[0]?.expected).toBe(parsedPlan?.scenarios[0]?.expected);
      expect(parsedReport?.scenarios?.[0]?.observed).toBe('raise');
      expect(parsedReport?.scenarios?.[0]?.outcome).toBe('pass');
    }
  });

  it('uses the same delimiter rule for continuation rows and the no-heading fallback', () => {
    for (const scenarioLines of [
      `scenarios:\n- action: ${ACTION}\n  expected: ${PIPE_EXPECTED} | observed: raise | outcome: pass`,
      `- action: ${ACTION} | expected: ${PIPE_EXPECTED} | observed: raise | outcome: pass`,
    ]) {
      const parsedReport = parseSealedSmokeAgentReport(sealedReport(scenarioLines));
      expect(parsedReport?.scenarios).toHaveLength(1);
      expect(parsedReport?.scenarios?.[0]).toMatchObject({
        action: ACTION,
        expected: PIPE_EXPECTED,
        observed: 'raise',
        outcome: 'pass',
      });
    }
  });
});
