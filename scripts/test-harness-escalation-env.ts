import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OPK_VITEST_HARNESS_ENV = 'OPK_VITEST_HARNESS';

export function sharedDefaultEscalationStatePath(): string {
  return join(tmpdir(), 'orchestrator-escalation-state.json');
}

export function sharedDefaultOperatorInboxDir(): string {
  return join(tmpdir(), 'orchestrator-operator-inbox');
}

export function sharedDefaultHealthSpoolDir(): string {
  return join(tmpdir(), 'orchestrator-escalation-health');
}

export function applyOpkVitestHarnessEscalationEnv(rootDir?: string): {
  root: string;
  statePath: string;
  inboxDir: string;
  healthDir: string;
} {
  const root = rootDir ?? mkdtempSync(join(tmpdir(), 'opk-vitest-escalation-'));
  const statePath = join(root, 'escalation-state.json');
  const inboxDir = join(root, 'operator-inbox');
  const healthDir = join(root, 'health-spool');

  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(healthDir, { recursive: true });

  process.env[OPK_VITEST_HARNESS_ENV] = '1';
  process.env.AO_ORCHESTRATOR_ESCALATION_STATE = statePath;
  process.env.AO_OPERATOR_ESCALATION_INBOX = inboxDir;
  process.env.AO_ESCALATION_HEALTH_SPOOL = healthDir;

  return { root, statePath, inboxDir, healthDir };
}
