import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import { applyOpkVitestHarnessEscalationEnv } from './test-harness-escalation-env.js';
// @ts-ignore runtime .mjs module is covered by the harness integration checks.
import { preflightPowerShellInvocation } from './lib/vitest-live-store-parent-guard.mjs';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

export function runPwsh(script: string, extraEnv: Record<string, string> = {}) {
  if (process.env.OPK_VITEST_HARNESS !== '1' || !process.env.OPK_VITEST_HARNESS_ROOT) {
    applyOpkVitestHarnessEscalationEnv();
  }
  const hasExplicitAoBaseDir = Object.prototype.hasOwnProperty.call(extraEnv, 'AO_BASE_DIR');
  const explicitAoBaseDir = extraEnv.AO_BASE_DIR;
  const managedAoBaseDir = hasExplicitAoBaseDir
    ? null
    : mkdtempSync(path.join(
      process.env.OPK_VITEST_HARNESS_ROOT || tmpdir(),
      'ao-base-run-',
    ));
  const scopedGhHarnessEnv = {
    AO_REVIEW_START_SCOPED_GH_COMMAND: '',
    AO_REVIEW_START_SCOPED_GH_SCENARIO: '',
    AO_REVIEW_START_SCOPED_GH_STATE_FILE: '',
    AO_REVIEW_START_SCOPED_GH_HEAD_SHA: '',
    AO_REVIEW_START_SCOPED_GH_HEAD_SHA_A: '',
    AO_REVIEW_START_SCOPED_GH_HEAD_SHA_B: '',
  };
  const commandArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const pwsh = process.env.OPK_REAL_PWSH || 'pwsh';
  const childEnv = {
    ...process.env,
    AO_BASE_DIR: hasExplicitAoBaseDir ? explicitAoBaseDir ?? '' : managedAoBaseDir ?? '',
    OPK_VITEST_HARNESS: '1',
    OPK_VITEST_HARNESS_ROOT: process.env.OPK_VITEST_HARNESS_ROOT ?? '',
    OPK_VITEST_PRODUCTION_HOME: process.env.OPK_VITEST_PRODUCTION_HOME ?? '',
    OPK_VITEST_PRODUCTION_TMP: process.env.OPK_VITEST_PRODUCTION_TMP ?? '',
    OPK_VITEST_PRODUCTION_AO_BASE: process.env.OPK_VITEST_PRODUCTION_AO_BASE ?? '',
    OPK_VITEST_PRODUCTION_WAKE_ROOT: process.env.OPK_VITEST_PRODUCTION_WAKE_ROOT ?? '',
    AO_WAKE_SUPERVISOR_STATE_DIR: process.env.AO_WAKE_SUPERVISOR_STATE_DIR ?? '',
    ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: process.env.ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR ?? '',
    AO_SIDE_PROCESS_STATE_DIR: process.env.AO_SIDE_PROCESS_STATE_DIR ?? '',
    AO_ORCHESTRATOR_ESCALATION_STATE: process.env.AO_ORCHESTRATOR_ESCALATION_STATE ?? '',
    AO_OPERATOR_ESCALATION_INBOX: process.env.AO_OPERATOR_ESCALATION_INBOX ?? '',
    AO_ESCALATION_HEALTH_SPOOL: process.env.AO_ESCALATION_HEALTH_SPOOL ?? '',
    AO_MECHANICAL_TRANSPORT_TEMP: process.env.AO_MECHANICAL_TRANSPORT_TEMP ?? '',
    AO_WORKER_MESSAGE_DISPATCH_JOURNAL: process.env.AO_WORKER_MESSAGE_DISPATCH_JOURNAL ?? '',
    AO_WORKER_MESSAGE_SUBMIT_STATE: process.env.AO_WORKER_MESSAGE_SUBMIT_STATE ?? '',
    AO_WORKER_STATUS_STORE: process.env.AO_WORKER_STATUS_STORE ?? '',
    AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE: process.env.AO_REVIEW_HANDOFF_WAKE_ADMISSION_STATE ?? '',
    AO_REPORT_STATE_SEED_STATE: process.env.AO_REPORT_STATE_SEED_STATE ?? '',
    AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE: process.env.AO_REVIEW_TRIGGER_REEVAL_WATCH_STATE ?? '',
    AO_WORKER_REPORT_STORE: process.env.AO_WORKER_REPORT_STORE ?? '',
    AO_PR_SESSION_BINDING_CACHE: process.env.AO_PR_SESSION_BINDING_CACHE ?? '',
    AO_CI_GREEN_WAKE_RECONCILE_STATE: process.env.AO_CI_GREEN_WAKE_RECONCILE_STATE ?? '',
    AO_DEAD_WORKER_RECONCILE_STATE: process.env.AO_DEAD_WORKER_RECONCILE_STATE ?? '',
    AO_REVIEW_TRIGGER_RECONCILE_STATE: process.env.AO_REVIEW_TRIGGER_RECONCILE_STATE ?? '',
    AO_WAKE_DEDUP_STATE: process.env.AO_WAKE_DEDUP_STATE ?? '',
    AO_WAKE_LISTENER_SIDE_EFFECT_LOCK: process.env.AO_WAKE_LISTENER_SIDE_EFFECT_LOCK ?? '',
    AO_WORKER_MESSAGE_ADOPTION_STATE: process.env.AO_WORKER_MESSAGE_ADOPTION_STATE ?? '',
    AO_REVIEW_CLAIM_DIR: '',
    AO_WORKER_NUDGE_CLAIM_DIR: '',
    ...scopedGhHarnessEnv,
    ...extraEnv,
  } as NodeJS.ProcessEnv;
  preflightPowerShellInvocation(commandArgs, childEnv);
  try {
    const result = spawnSync(pwsh, commandArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: childEnv,
    });
    if (result.status !== 0) {
      throw new Error(`pwsh failed ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    }
    return result.stdout.trim();
  } finally {
    if (managedAoBaseDir) {
      rmSync(managedAoBaseDir, { recursive: true, force: true });
    }
  }
}

export function psString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
