import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import { runProcessSync } from '#opk-kernel/subprocess';
import { applyOpkVitestHarnessEscalationEnv } from './test-harness-escalation-env.js';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function vitestHarnessBypassEnv(extraEnv: Record<string, string | undefined> = {}) {
  return {
    ...extraEnv,
    OPK_VITEST_HARNESS: '',
    OPK_VITEST_SKIP_CHILD_ENV_MERGE: '1',
    OPK_VITEST_HARNESS_ROOT: '',
    OPK_VITEST_HARNESS_INVENTORY: '',
    AO_ORCHESTRATOR_ESCALATION_STATE: '',
    AO_OPERATOR_ESCALATION_INBOX: '',
    AO_ESCALATION_HEALTH_SPOOL: '',
    AO_WAKE_SUPERVISOR_STATE_DIR: '',
    ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: '',
    AO_SIDE_PROCESS_STATE_DIR: '',
    AO_BASE_DIR: '',
    AO_MECHANICAL_TRANSPORT_TEMP: '',
  };
}

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
  const bypassHarness = extraEnv.OPK_VITEST_HARNESS === '';
  const harnessAoBaseDir = process.env.OPK_VITEST_HARNESS_AO_BASE_DIR;
  const harnessRoot = process.env.OPK_VITEST_HARNESS_ROOT;
  const isHarnessOwnedAoBase = process.env.AO_BASE_DIR === harnessAoBaseDir
    || (
      process.env.OPK_VITEST_HARNESS === '1'
      && Boolean(harnessRoot)
      && Boolean(process.env.AO_BASE_DIR)
      && path.resolve(process.env.AO_BASE_DIR ?? '').startsWith(`${path.resolve(harnessRoot ?? '')}${path.sep}`)
    );
  const inheritedAoBaseDir = isHarnessOwnedAoBase
    ? undefined
    : process.env.AO_BASE_DIR;
  const harnessMechanicalTransport = process.env.AO_MECHANICAL_TRANSPORT_TEMP
    || (harnessRoot ? path.join(harnessRoot, 'transport') : '');
  const explicitAoBaseDir = extraEnv.AO_BASE_DIR;
  if (!bypassHarness && (process.env.OPK_VITEST_HARNESS !== '1' || !process.env.AO_ORCHESTRATOR_ESCALATION_STATE)) {
    applyOpkVitestHarnessEscalationEnv();
  }
  const managedAoBaseDir = inheritedAoBaseDir || explicitAoBaseDir
    ? null
    : mkdtempSync(path.join(tmpdir(), 'opk-vitest-ao-base-'));
  const scopedClaimDirEnv = {
    AO_REVIEW_CLAIM_DIR: Object.prototype.hasOwnProperty.call(extraEnv, 'AO_REVIEW_CLAIM_DIR')
      ? extraEnv.AO_REVIEW_CLAIM_DIR
      : '',
    AO_WORKER_NUDGE_CLAIM_DIR: Object.prototype.hasOwnProperty.call(extraEnv, 'AO_WORKER_NUDGE_CLAIM_DIR')
      ? extraEnv.AO_WORKER_NUDGE_CLAIM_DIR
      : '',
  };
  const scopedGhHarnessEnv = {
    AO_REVIEW_START_SCOPED_GH_COMMAND: '',
    AO_REVIEW_START_SCOPED_GH_SCENARIO: '',
    AO_REVIEW_START_SCOPED_GH_STATE_FILE: '',
    AO_REVIEW_START_SCOPED_GH_HEAD_SHA: '',
    AO_REVIEW_START_SCOPED_GH_HEAD_SHA_A: '',
    AO_REVIEW_START_SCOPED_GH_HEAD_SHA_B: '',
  };
  try {
    const result = runProcessSync({
      command: 'pwsh',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AO_BASE_DIR: managedAoBaseDir ?? inheritedAoBaseDir ?? '',
        OPK_VITEST_HARNESS: '1',
        AO_ORCHESTRATOR_ESCALATION_STATE: process.env.AO_ORCHESTRATOR_ESCALATION_STATE ?? '',
        AO_OPERATOR_ESCALATION_INBOX: process.env.AO_OPERATOR_ESCALATION_INBOX ?? '',
        AO_ESCALATION_HEALTH_SPOOL: process.env.AO_ESCALATION_HEALTH_SPOOL ?? '',
        AO_MECHANICAL_TRANSPORT_TEMP: harnessMechanicalTransport,
        ...scopedClaimDirEnv,
        ...scopedGhHarnessEnv,
        ...extraEnv,
      },
      inheritParentEnv: false,
    });
    if (!result.ok) {
      throw new Error(`pwsh failed ${result.exitCode ?? result.outcome}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
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
