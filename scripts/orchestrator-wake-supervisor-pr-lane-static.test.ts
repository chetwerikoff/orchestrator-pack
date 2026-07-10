import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');

describe('orchestrator-wake-supervisor PR-lane static proofs (#709)', () => {
  it('AC#12a: adopt/reap and restart paths enforce lease epoch fencing', () => {
    const sideSrc = fs.readFileSync(
      path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'),
      'utf8',
    );
    expect(sideSrc).toMatch(/Assert-OrchestratorWakeSupervisorLeaseMutationAllowed/);
    expect(sideSrc).toMatch(/Test-OrchestratorWakeSupervisorLeaseEpochCurrent/);
    expect(sideSrc).toMatch(/lease lost; exiting supervisor loop/);
  });

  it('AC#15: supervisor loop exits on lease loss rather than parent-death cascade', () => {
    const loopSrc = fs.readFileSync(
      path.join(repoRoot, 'scripts/lib/Orchestrator-SideProcessSupervisor.ps1'),
      'utf8',
    );
    const leaseSrc = fs.readFileSync(
      path.join(repoRoot, 'scripts/lib/Orchestrator-WakeSupervisorLease.ps1'),
      'utf8',
    );
    expect(loopSrc).toMatch(/lease lost; exiting supervisor loop/);
    expect(leaseSrc).toMatch(/Test-OrchestratorWakeSupervisorLoopLeaseHeld/);
    expect(loopSrc).not.toMatch(/Wait-Process\s+-Id\s+\$PID\s+-Parent/);
  });

  it('AC#18: lease platform support is explicit on Linux/WSL', () => {
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `. '${path.join(repoRoot, 'scripts/lib/Orchestrator-WakeSupervisorLease.ps1').replace(/'/g, "''")}'; [bool](Test-OrchestratorWakeSupervisorLeasePlatformSupported)`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect((result.stdout ?? '').trim()).toBe('True');
  });
});
