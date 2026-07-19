import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.OPK_VITEST_HARNESS === '1') {
  const harnessRoot = process.env.OPK_VITEST_HARNESS_ROOT?.trim();
  if (!harnessRoot) {
    throw new Error('OPK_VITEST_HARNESS_ROOT is required for surviving store isolation');
  }

  // The live-store preload snapshots the parent harness paths before setup files
  // execute, then strips those inherited values from child-process environments.
  // Give each Vitest worker its own post-snapshot escalation paths so PowerShell
  // children retain isolated stores without reviving the retired fleet harness.
  const workerRoot = join(harnessRoot, 'surviving-stores', String(process.pid));
  const stateDir = join(workerRoot, 'state');
  const inboxDir = join(workerRoot, 'operator-inbox');
  const healthDir = join(workerRoot, 'health-spool');
  for (const directory of [workerRoot, stateDir, inboxDir, healthDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  process.env.AO_ORCHESTRATOR_ESCALATION_STATE = join(
    stateDir,
    'orchestrator-escalation-state.json',
  );
  process.env.AO_OPERATOR_ESCALATION_INBOX = inboxDir;
  process.env.AO_ESCALATION_HEALTH_SPOOL = healthDir;
}
