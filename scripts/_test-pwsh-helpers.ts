import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import { runProcessSync } from '#opk-kernel/subprocess';
import { applyOpkVitestHarnessEscalationEnv } from './test-harness-escalation-env.js';
import { repoRoot } from './_test-vitest-harness-env.js';
export { repoRoot } from './_test-vitest-harness-env.js';

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
  const harnessStateBaseDir = process.env.OPK_VITEST_HARNESS_OPK_BASE_DIR;
  const harnessRoot = process.env.OPK_VITEST_HARNESS_ROOT;
  const isHarnessOwnedStateBase = process.env.OPK_BASE_DIR === harnessStateBaseDir
    || (
      process.env.OPK_VITEST_HARNESS === '1'
      && Boolean(harnessRoot)
      && Boolean(process.env.OPK_BASE_DIR)
      && path.resolve(process.env.OPK_BASE_DIR ?? '').startsWith(`${path.resolve(harnessRoot ?? '')}${path.sep}`)
    );
  const inheritedStateBaseDir = isHarnessOwnedStateBase
    ? undefined
    : process.env.OPK_BASE_DIR;
  const harnessMechanicalTransport = process.env.OPK_MECHANICAL_TRANSPORT_TEMP
    || (harnessRoot ? path.join(harnessRoot, 'transport') : '');
  const explicitStateBaseDir = extraEnv.OPK_BASE_DIR;
  if (!bypassHarness && (process.env.OPK_VITEST_HARNESS !== '1' || !process.env.OPK_ORCHESTRATOR_ESCALATION_STATE)) {
    applyOpkVitestHarnessEscalationEnv();
  }
  const managedStateBaseDir = inheritedStateBaseDir || explicitStateBaseDir
    ? null
    : mkdtempSync(path.join(tmpdir(), 'opk-vitest-ao-base-'));
  const scopedClaimDirEnv = {
    OPK_REVIEW_CLAIM_DIR: Object.prototype.hasOwnProperty.call(extraEnv, 'OPK_REVIEW_CLAIM_DIR')
      ? extraEnv.OPK_REVIEW_CLAIM_DIR
      : '',
    OPK_WORKER_NUDGE_CLAIM_DIR: Object.prototype.hasOwnProperty.call(extraEnv, 'OPK_WORKER_NUDGE_CLAIM_DIR')
      ? extraEnv.OPK_WORKER_NUDGE_CLAIM_DIR
      : '',
  };
  const scopedGhHarnessEnv = {
    OPK_REVIEW_START_SCOPED_GH_COMMAND: '',
    OPK_REVIEW_START_SCOPED_GH_SCENARIO: '',
    OPK_REVIEW_START_SCOPED_GH_STATE_FILE: '',
    OPK_REVIEW_START_SCOPED_GH_HEAD_SHA: '',
    OPK_REVIEW_START_SCOPED_GH_HEAD_SHA_A: '',
    OPK_REVIEW_START_SCOPED_GH_HEAD_SHA_B: '',
  };
  try {
    const result = runProcessSync({
      command: 'pwsh',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPK_BASE_DIR: managedStateBaseDir ?? inheritedStateBaseDir ?? '',
        OPK_VITEST_HARNESS: '1',
        OPK_ORCHESTRATOR_ESCALATION_STATE: process.env.OPK_ORCHESTRATOR_ESCALATION_STATE ?? '',
        OPK_OPERATOR_ESCALATION_INBOX: process.env.OPK_OPERATOR_ESCALATION_INBOX ?? '',
        OPK_ESCALATION_HEALTH_SPOOL: process.env.OPK_ESCALATION_HEALTH_SPOOL ?? '',
        OPK_MECHANICAL_TRANSPORT_TEMP: harnessMechanicalTransport,
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
    if (managedStateBaseDir) {
      rmSync(managedStateBaseDir, { recursive: true, force: true });
    }
  }
}

export function psString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
