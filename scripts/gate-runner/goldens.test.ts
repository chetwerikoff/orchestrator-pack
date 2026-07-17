import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAoCaptureRedaction, CAPTURE_DIRECTORY, type CaptureReader } from './custom/ao-capture-redaction.ts';
import { evaluateDeclarativeGate } from './declarative.ts';
import { agentRulesBudgetGate, agentRulesGrepGate, agentRulesMovedContentGate } from './representative-gates.ts';
import { runGateRunner } from './runner.ts';
import { memorySnapshot } from './source-snapshot.ts';

const retiredAgentRulesFile = `${['agent', 'rules'].join('_')}.md`;

interface Capture {
  gateId: string;
  legacyScript: string;
  sourceBlobSha: string;
  case: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  artifacts: string[];
}

const repoRoot = resolve(import.meta.dirname, '../..');
const golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'goldens/pre-delete-captures.json'), 'utf8'),
) as { version: number; baseCommitSha: string; captures: Capture[] };

const movedClean = {
  'AGENTS.md': '## Coworker CLI delegation\n## RTK read-exploration\n## RCA spec discipline',
  'docs/coworker-delegation.md': 'PR diff recipe\ngit diff <base-ref>...HEAD > /tmp/review.diff\nRoot-cause work must read ~900 lines',
  'docs/tiering.md': '## Task complexity tier rubric\n### Red-flag markers (any one → T3)\n## Per-tier draft-review flow\n### Per-tier pipeline (ceilings, not quotas)',
  'docs/script-owned-review-pipeline.md': '## Event-driven review trigger\n## Orchestrator review-run coverage\n## Head ready for review\nevent-driven review trigger',
};

function stableReader(files: Readonly<Record<string, string>>): CaptureReader {
  return {
    list: () => Object.keys(files).sort(),
    read: (path) => files[path],
  };
}

function capture(gateId: string, caseName: string): Capture {
  const found = golden.captures.find((item) => item.gateId === gateId && item.case === caseName);
  if (!found) throw new Error(`missing golden ${gateId}/${caseName}`);
  return found;
}

describe('pre-delete legacy captures', () => {
  it('binds every representative deleted gate to argv, exit, stdout, artifacts, and source identity', () => {
    expect(golden.version).toBe(1);
    expect(golden.baseCommitSha).toBe('f0f07cc4cbc517930a6057558273e019f912013f');
    expect(new Set(golden.captures.map((item) => item.legacyScript))).toEqual(new Set([
      'scripts/check-agent-rules-grep-inventory.ps1',
      'scripts/check-agent-rules-line-budget.ps1',
      'scripts/check-agent-rules-moved-content.ps1',
      'scripts/check-ao-0-10-cli-capture-redaction.ps1',
      'scripts/check-ao-capture-redaction-selftest.ps1',
    ]));
    for (const item of golden.captures) {
      expect(item.argv.length).toBeGreaterThan(3);
      expect(item.sourceBlobSha).toMatch(/^[0-9a-f]{40}$/u);
      expect([0, 1]).toContain(item.exitCode);
      expect(item.stdout.endsWith('\n')).toBe(true);
      expect(Array.isArray(item.artifacts)).toBe(true);
    }
  });

  it('keeps real-tree PASS stdout byte-compatible with positive captures', () => {
    const positives = golden.captures.filter((item) => item.case === 'real-clean-tree');
    const report = runGateRunner(repoRoot, positives.map((item) => item.gateId));
    for (const item of positives) {
      const result = report.results.find((candidate) => candidate.gateId === item.gateId);
      expect(result?.status, item.gateId).toBe('PASS');
      expect(result?.legacyStdout, item.gateId).toBe(item.stdout);
    }
  });

  it('keeps the real declarative FAIL stdout contracts', () => {
    const grep = evaluateDeclarativeGate(agentRulesGrepGate, memorySnapshot({ 'README.md': retiredAgentRulesFile }));
    expect(grep.status).toBe('FAIL');
    expect(grep.legacyStdout).toBe(capture('agent-rules-live-reference', 'forbidden-reference').stdout);

    const budget = evaluateDeclarativeGate(agentRulesBudgetGate, memorySnapshot({ 'AGENTS.md': `${'x\n'.repeat(450)}x` }));
    expect(budget.status).toBe('FAIL');
    expect(budget.legacyStdout).toBe(capture('agent-rules-size-budget', 'over-budget-fixture').stdout);

    const moved = evaluateDeclarativeGate(agentRulesMovedContentGate, memorySnapshot({
      ...movedClean,
      'AGENTS.md': `${movedClean['AGENTS.md']}\n## Task complexity tier rubric`,
    }));
    expect(moved.status).toBe('FAIL');
    expect(moved.legacyStdout).toBe(capture('agent-rules-moved-content', 'forbidden-moved-content').stdout);
  });

  it('keeps the custom redaction FAIL stdout contract', () => {
    const path = `${CAPTURE_DIRECTORY}/leak.raw.json`;
    const result = evaluateAoCaptureRedaction(stableReader({
      [path]: JSON.stringify({ repo: 'https://user:secret@example.test/path' }),
    }));
    expect(result.status).toBe('FAIL');
    expect(result.legacyStdout).toBe(capture('ao-capture-redaction', 'credential-url-fixture').stdout);
  });
});
