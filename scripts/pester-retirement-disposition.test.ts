// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

type Disposition = {
  readonly legacy: string;
  readonly disposition: 'ported' | 'retired';
  readonly evidence: string;
};

// Exact effective population printed by the last pre-cutover Pester job on
// d9e41b4d760ba3f13f4bbc756fa57bc4443b8aad (11 discovered files / 83 tests).
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
  { legacy: 'tests/powershell/Test-AllRunner.Tests.ps1', disposition: 'retired', evidence: 'scripts/test-all.ps1' },
] as const;

function text(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('Issue #1418 effective Pester population disposition', () => {
  it('closes every file from the exact 11-file pre-cutover population', () => {
    expect(PRE_CUTOVER_PESTER).toHaveLength(11);
    expect(new Set(PRE_CUTOVER_PESTER.map((entry) => entry.legacy)).size).toBe(11);
    expect(PRE_CUTOVER_PESTER.every((entry) => entry.disposition === 'ported' || entry.disposition === 'retired')).toBe(true);
    for (const entry of PRE_CUTOVER_PESTER) {
      expect(existsSync(path.join(ROOT, entry.evidence)), `${entry.legacy} -> ${entry.evidence}`).toBe(true);
    }
  });

  it('keeps Pester and SkipPester out of the live test-all authority', () => {
    const runner = text('scripts/test-all.ps1');
    expect(runner).not.toMatch(/Invoke-Pester|New-PesterConfiguration|Get-Module\s+-ListAvailable\s+-Name\s+Pester/u);
    expect(runner).not.toMatch(/\[switch\]\$SkipPester/u);
    expect(runner).not.toMatch(/retiredPesterSuitePaths|legacyPesterBlockLines/u);
  });

  it('keeps Pester out of the required scope-guard workflow authority', () => {
    const workflow = text('.github/workflows/scope-guard.yml');
    expect(workflow).not.toMatch(/Pester regression|test-pester:|install-pester-ci\.ps1|PESTER_RESULT/u);
    expect(workflow).toMatch(/test-vitest-contracts:/u);
    expect(workflow).toMatch(/vitest-ci-runner\.ts contract/u);
  });

  it('treats any legacy Pester files that remain for trusted-scope compatibility as inert artifacts', () => {
    const remaining = PRE_CUTOVER_PESTER.filter((entry) => existsSync(path.join(ROOT, entry.legacy)));
    expect(remaining.map((entry) => entry.legacy).sort()).toEqual([
      'tests/powershell/Ci-Failure-Notification-Common.Tests.ps1',
      'tests/powershell/Gh-PrChecks.Tests.ps1',
      'tests/powershell/Resolve-TrustedPackRoot.Tests.ps1',
      'tests/powershell/Test-AllRunner.Tests.ps1',
    ]);
    // Their presence cannot restore authority: the only active full-suite wrapper has
    // no Pester discovery/invocation path, and required CI calls the Vitest contract lane.
    expect(text('scripts/test-all.ps1')).not.toMatch(/\.Tests\.ps1|Invoke-Pester/u);
  });
});
