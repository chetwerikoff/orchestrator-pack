// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { describe, expect, it } from 'vitest';
import {
  didAskTriggerFire,
  T1_VOLUME_FLOOR,
} from '../../../docs/read-delegation-audit.mjs';
import { captureSourceSnapshot, memorySnapshot } from '../source-snapshot.ts';
import {
  bulkStaticGateRegistrations,
  evaluateAgentsReportContract,
  evaluateReview010Vocabulary,
  evaluateVerifyStructureContract,
} from './bulk-static-gates.ts';

const repoRoot = process.cwd();

function verifyFixture(overrides: Readonly<Record<string, string>> = {}) {
  const files: Record<string, string> = {};
  files['prompts/self_architect_check.md'] = 'prompt';
  files['plugins/task-declaration/README.md'] = 'DD-026 DD-027 declared_files denylist one amendment baseline';
  files['plugins/scope-guard/README.md'] = 'DD-024 runtime guard git add commit PR-level CI second line';
  files['plugins/token-chain-ledger/README.md'] = 'chain_id planner reviewer worker per-session cost estimated_cost_usd';
  files['plugins/codex-pr-reviewer/README.md'] = 'Codex gpt-5.5 PR review GitHub Issues no core patch';
  return memorySnapshot({ ...files, ...overrides });
}

describe('Wave 3.b bulk static gate ports', () => {
  it('passes every registered port against the live/no-override repository path', () => {
    const snapshot = captureSourceSnapshot(repoRoot);
    for (const registration of bulkStaticGateRegistrations) {
      const result = registration.evaluate({ repoRoot, snapshot });
      expect(result.status, `${registration.gateId}: ${result.details?.join('\n')}`).toBe('PASS');
    }
  });

  it('preserves the AGENTS report predicate and catches the removed command', () => {
    const clean = memorySnapshot({ 'AGENTS.md': 'pack-worker-report\nskip silently\n' });
    expect(evaluateAgentsReportContract(clean).status).toBe('PASS');
    expect(evaluateAgentsReportContract(memorySnapshot({ 'AGENTS.md': 'pack-worker-report\nskip silently\na\u006f report\n' })).status).toBe('FAIL');
  });

  it('detects dead AO review vocabulary outside the explicit compatibility allowlist', () => {
    expect(evaluateReview010Vocabulary(memorySnapshot({ 'scripts/clean.mjs': 'export const ok = true;' })).status).toBe('PASS');
    const failed = evaluateReview010Vocabulary(memorySnapshot({ 'scripts/bad.mjs': 'const argv = ["review", "run"];' }));
    expect(failed.status).toBe('FAIL');
    expect(failed.legacyStdout).toBe('AO 0.10 review vocabulary violations:\n  scripts/bad.mjs: dead a\u006f review CLI argv\n');
  });

  it('ports prompt inventory and contract-marker checks with positive and negative fixtures', () => {
    expect(evaluateVerifyStructureContract(verifyFixture()).status).toBe('PASS');
    const missing = evaluateVerifyStructureContract(verifyFixture({ 'plugins/scope-guard/README.md': 'DD-024' }));
    expect(missing.status).toBe('FAIL');
    expect(missing.details?.join('\n')).toContain('runtime guard');
  });
});

describe('read-delegation audit trigger', () => {
  it('uses one strict combined volume floor', () => {
    expect(T1_VOLUME_FLOOR).toBe(600);

    expect(didAskTriggerFire([{ kind: 'file', path: 'a.md', lines: 600 }]).fired).toBe(false);
    expect(didAskTriggerFire([{ kind: 'file', path: 'a.md', lines: 601 }]).fired).toBe(true);
    expect(didAskTriggerFire([{ kind: 'diff', lines: 600 }]).fired).toBe(false);
    expect(didAskTriggerFire([{ kind: 'diff', lines: 601 }]).fired).toBe(true);
    expect(
      didAskTriggerFire([
        { kind: 'file', path: 'a.md', lines: 400 },
        { kind: 'log', lines: 201 },
      ]).fired,
    ).toBe(true);
  });

  it('does not trigger from file count or a retired diff/log floor', () => {
    const threeFilesAtOldFloor: Parameters<typeof didAskTriggerFire>[0] = [
      { kind: 'file', path: 'a.md', lines: 200 },
      { kind: 'file', path: 'b.md', lines: 200 },
      { kind: 'file', path: 'c.md', lines: 200 },
    ];

    expect(didAskTriggerFire(threeFilesAtOldFloor)).toMatchObject({
      fired: false,
      t2: false,
      diffLog: false,
      fileCount: 3,
      delegableLines: 600,
    });
    expect(didAskTriggerFire([{ kind: 'diff', lines: 201 }]).fired).toBe(false);
  });
});
