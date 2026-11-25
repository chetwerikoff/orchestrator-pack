import { describe, expect, it } from 'vitest';
import {
  normalizeSmokeReport, parseSealedSmokeAgentReport, parseSmokeTestPlan, smokeRowSatisfiesPass, SMOKE_REPORT_PRODUCER,
  type SmokeScenario,
} from './worker-smoke-core-base.ts';

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

describe('Issue #2897 post-merge and measurement smoke rows', () => {
  const HEAD = 'a'.repeat(40);
  const binding = { issueNumber: 2897, prNumber: 2898, headSha: HEAD };
  const row = (action: string, outcome: SmokeScenario['outcome'], extra: Partial<SmokeScenario> = {}): SmokeScenario => ({
    action, expected: 'ok', observed: 'seen', outcome, ...extra,
  });
  const pass = (scenarios: SmokeScenario[]) => normalizeSmokeReport({
    result: 'PASS', trackedFilesUnmodified: true, scenarios,
    producer: SMOKE_REPORT_PRODUCER, terminalCleanup: 'not_started_no_execution',
  } as never, binding, { executionMode: 'carry-only' });

  it('lets only an explicit [post-merge] row skipped as post-merge-pending sit in PASS', () => {
    const pending = row('[post-merge] check live deploy', 'skipped', { skipReason: 'post-merge-pending' });
    expect(smokeRowSatisfiesPass(pending)).toBe(true);
    expect(smokeRowSatisfiesPass({ ...pending, skipReason: 'other' })).toBe(false);
    expect(smokeRowSatisfiesPass({ ...pending, action: 'check live deploy' })).toBe(false);
    expect(smokeRowSatisfiesPass(row('plain', 'skipped', { skipReason: 'post-merge-pending' }))).toBe(false);
    expect(smokeRowSatisfiesPass(row('plain', 'fail'))).toBe(false);
  });

  it('keeps row identity and order and ordinary skipped rows non-passing in normalization', () => {
    const rows = [
      row('first', 'pass'),
      row('[post-merge] live', 'skipped', { skipReason: 'post-merge-pending' }),
      row('last', 'pass'),
    ];
    const ok = pass(rows);
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.report.scenarios.map((scenario) => scenario.action)).toEqual(['first', '[post-merge] live', 'last']);
    expect(pass([row('first', 'pass'), row('ordinary', 'skipped', { skipReason: 'post-merge-pending' })]))
      .toMatchObject({ ok: false, reason: 'pass_scenario_2_not_pass' });
  });

  it('accepts a measurement row only when executed with a value and target, and a miss still passes', () => {
    expect(smokeRowSatisfiesPass(row('[measurement] latency', 'pass', { observed: '120 ms (target <= 100 ms)' }))).toBe(true);
    expect(smokeRowSatisfiesPass(row('[measurement] latency', 'pass', { observed: '120 ms' }))).toBe(false);
    expect(smokeRowSatisfiesPass(row('[measurement] latency', 'fail', { observed: '120 ms (target <= 100 ms)' }))).toBe(false);
    expect(smokeRowSatisfiesPass(row('[measurement] latency', 'skipped', { observed: 'n/a (target 1)', skipReason: 'post-merge-pending' }))).toBe(false);
    expect(smokeRowSatisfiesPass(row('ordinary', 'pass', { observed: 'anything' }))).toBe(true);
  });
});
