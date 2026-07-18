import { describe, expect, it } from 'vitest';
import { captureSourceSnapshot, memorySnapshot } from '../source-snapshot.ts';
import {
  bulkStaticGateRegistrations,
  evaluateAgentsReportContract,
  evaluateCoworkerDelegationThreshold,
  evaluateReview010Vocabulary,
  evaluateReviewCommandNotAo,
  evaluateVerifyStructureContract,
} from './bulk-static-gates.ts';

const repoRoot = process.cwd();

function verifyFixture(overrides: Readonly<Record<string, string>> = {}) {
  const files: Record<string, string> = {};
  files['prompts/self_architect_check.md'] = 'prompt';
  files['plugins/ao-task-declaration/README.md'] = 'DD-026 DD-027 declared_files denylist one amendment baseline';
  files['plugins/ao-scope-guard/README.md'] = 'DD-024 runtime guard git add commit PR-level CI second line';
  files['plugins/ao-token-chain-ledger/README.md'] = 'chain_id planner reviewer worker per-session cost estimated_cost_usd';
  files['plugins/ao-codex-pr-reviewer/README.md'] = 'Codex gpt-5.5 PR review GitHub Issues no core patch';
  return memorySnapshot({ ...files, ...overrides });
}

function reviewRuntimeFixture(overrides: Readonly<Record<string, string>> = {}) {
  return memorySnapshot({
    'scripts/pack-review-runner.ts': 'export function startPackReview() {}',
    'scripts/invoke-pack-review.ps1': 'param()\n',
    'scripts/lib/pack-review-delivery.ts': "export const context = 'orchestrator-pack/pack-review';",
    ...overrides,
  });
}

describe('Wave 3.b bulk static gate ports', () => {
  it('passes every registered port against the live/no-override repository path', () => {
    const snapshot = captureSourceSnapshot(repoRoot);
    for (const registration of bulkStaticGateRegistrations) {
      const result = registration.evaluate({ repoRoot, snapshot });
      expect(result.status, `${registration.gateId}: ${result.details?.join('\n')}`).toBe('PASS');
    }
  });

  it('requires worker instructions and the pack-owned report entrypoint without parsing prose', () => {
    const clean = memorySnapshot({
      'AGENTS.md': 'worker policy',
      'scripts/pack-worker-report.ps1': 'param()',
    });
    expect(evaluateAgentsReportContract(clean).status).toBe('PASS');
    expect(evaluateAgentsReportContract(memorySnapshot({ 'AGENTS.md': 'worker policy' })).status).toBe('FAIL');
  });

  it('enforces the coworker 400-line floor and stale 600-literal exclusion', () => {
    expect(evaluateCoworkerDelegationThreshold(memorySnapshot({ 'AGENTS.md': 'more than 400 lines', 'CLAUDE.md': '' })).status).toBe('PASS');
    const failed = evaluateCoworkerDelegationThreshold(memorySnapshot({ 'AGENTS.md': 'more than 400 lines', 'CLAUDE.md': 'more than 600 lines' }));
    expect(failed.status).toBe('FAIL');
    expect(failed.legacyStdout).toBe('[FAIL] coworker delegation threshold drift:\n - CLAUDE.md still contains stale volume-floor literal: more than 600 lines\n');
  });

  it('rejects AO Reviews invocation only in live pack-review runtime paths', () => {
    expect(evaluateReview010Vocabulary(reviewRuntimeFixture()).status).toBe('PASS');
    const failed = evaluateReview010Vocabulary(reviewRuntimeFixture({
      'scripts/pack-review-runner.ts': "const command = 'ao review run';",
    }));
    expect(failed.status).toBe('FAIL');
    expect(failed.details?.join('\n')).toContain('invokes AO review CLI');
  });

  it('requires exact status authority and rejects AO review invocation', () => {
    expect(evaluateReviewCommandNotAo(reviewRuntimeFixture()).status).toBe('PASS');
    const missingStatus = reviewRuntimeFixture({ 'scripts/lib/pack-review-delivery.ts': 'export const ok = true;' });
    expect(evaluateReviewCommandNotAo(missingStatus).status).toBe('FAIL');
    const aoInvocation = reviewRuntimeFixture({ 'scripts/invoke-pack-review.ps1': 'ao review run' });
    expect(evaluateReviewCommandNotAo(aoInvocation).status).toBe('FAIL');
  });

  it('ports prompt inventory and contract-marker checks with positive and negative fixtures', () => {
    expect(evaluateVerifyStructureContract(verifyFixture()).status).toBe('PASS');
    const missing = evaluateVerifyStructureContract(verifyFixture({ 'plugins/ao-scope-guard/README.md': 'DD-024' }));
    expect(missing.status).toBe('FAIL');
    expect(missing.details?.join('\n')).toContain('runtime guard');
  });
});
