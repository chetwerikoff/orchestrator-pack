// @vitest-ci-lane light
// @vitest-pre-topology-seconds 10

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
type Disposition = {
  readonly legacy: string;
  readonly disposition: 'ported' | 'retired';
  readonly evidence: string;
};
const PRE_CUTOVER_PESTER: readonly Disposition[] = [
  { legacy: 'scripts/ci-red-watchdog-lookup-retention.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'scripts/lib/Ci-Red-Watchdog.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'scripts/lint-self-architect.diff-mode.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'scripts/mechanical-json-state.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'scripts/orchestrator-launch-health.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'scripts/review-failure-evidence.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'tests/powershell/Ci-Failure-Notification-Common.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'tests/powershell/Gh-PrChecks.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'tests/powershell/Lint-SelfArchitect.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'tests/powershell/Resolve-TrustedPackRoot.Tests.ps1', disposition: 'ported', evidence: 'scripts/pester-retirement.test.ts' },
  { legacy: 'tests/powershell/Test-AllRunner.Tests.ps1', disposition: 'retired', evidence: 'scripts/vitest-ci-runner.ts' },
] as const;
function text(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('Issue #1418 historical Pester disposition after terminal cut', () => {
  it('keeps every pre-cutover row tied to surviving Node evidence', () => {
    expect(PRE_CUTOVER_PESTER).toHaveLength(11);
    expect(new Set(PRE_CUTOVER_PESTER.map((entry) => entry.legacy)).size).toBe(11);
    for (const entry of PRE_CUTOVER_PESTER) {
      expect(existsSync(path.join(ROOT, entry.evidence)), `${entry.legacy} -> ${entry.evidence}`).toBe(true);
    }
  });

  it('keeps required CI on the Vitest/Node authority with no Pester lane', () => {
    const workflow = text('.github/workflows/scope-guard.yml');
    expect(workflow).not.toMatch(/^\s*test-pester:\s*$/mu);
    expect(workflow).not.toContain('install-pester-ci');
    expect(workflow).toMatch(/test-vitest-contracts:/u);
    expect(workflow).toMatch(/vitest-ci-runner\.ts contract/u);
    expect(text('scripts/vitest-ci-runner.ts')).not.toMatch(/Invoke-Pester|New-PesterConfiguration/u);
  });

  it('has no surviving file from the historical Pester population', () => {
    const remaining = PRE_CUTOVER_PESTER
      .filter((entry) => existsSync(path.join(ROOT, entry.legacy)))
      .map((entry) => entry.legacy);
    expect(remaining).toEqual([]);
  });
});
