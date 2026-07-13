import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyOpkVitestHarnessEnv,
  createHarnessRoot,
} from './lib/vitest-live-store-harness.mjs';

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
  const root = rootDir
    ?? process.env.OPK_VITEST_HARNESS_ROOT
    ?? createHarnessRoot();
  const paths = applyOpkVitestHarnessEnv(root, process.env);
  return {
    root: paths.root,
    statePath: process.env.AO_ORCHESTRATOR_ESCALATION_STATE as string,
    inboxDir: paths.operatorInbox,
    healthDir: paths.healthSpool,
  };
}
