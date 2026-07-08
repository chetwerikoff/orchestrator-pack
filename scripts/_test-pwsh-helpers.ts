import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import { applyOpkVitestHarnessEscalationEnv } from './test-harness-escalation-env.js';

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
  const inheritedAoBaseDir = process.env.AO_BASE_DIR;
  const explicitAoBaseDir = extraEnv.AO_BASE_DIR;
  const managedAoBaseDir = inheritedAoBaseDir || explicitAoBaseDir
    ? null
    : mkdtempSync(path.join(tmpdir(), 'opk-vitest-ao-base-'));
  if (process.env.OPK_VITEST_HARNESS !== '1' || !process.env.AO_ORCHESTRATOR_ESCALATION_STATE) {
    applyOpkVitestHarnessEscalationEnv();
  }
  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AO_BASE_DIR: managedAoBaseDir ?? inheritedAoBaseDir ?? '',
        OPK_VITEST_HARNESS: '1',
        AO_ORCHESTRATOR_ESCALATION_STATE: process.env.AO_ORCHESTRATOR_ESCALATION_STATE ?? '',
        AO_OPERATOR_ESCALATION_INBOX: process.env.AO_OPERATOR_ESCALATION_INBOX ?? '',
        AO_ESCALATION_HEALTH_SPOOL: process.env.AO_ESCALATION_HEALTH_SPOOL ?? '',
        ...extraEnv,
      },
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
