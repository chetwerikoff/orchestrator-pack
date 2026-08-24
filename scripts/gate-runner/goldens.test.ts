import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAoCaptureRedaction, CAPTURE_DIRECTORY, type CaptureReader } from './custom/capture-redaction.ts';
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
  'AGENTS.md': [
    '## Coworker CLI delegation',
    '## RTK read-exploration',
    '[Worker lifecycle](docs/orchestration-runbook.md#worker-lifecycle)',
    '[Plan-first execution](docs/repository_policy.md#plan-first-execution)',
    '[Task and scope authority](docs/repository_policy.md#task-and-scope-authority)',
    '[Scope discipline](docs/repository_policy.md#scope-discipline)',
    '[Build the minimum](docs/repository_policy.md#build-the-minimum)',
    '[Local verification](docs/repository_policy.md#local-verification)',
    '[Coworker examples](docs/coworker-delegation.md)',
    '[investigate-root-cause](.claude/skills/investigate-root-cause/SKILL.md)',
    '[merge-with-local-adoption](.claude/skills/merge-with-local-adoption/SKILL.md)',
    '[adversarial-draft-review](.claude/skills/adversarial-draft-review/SKILL.md)',
    '[discuss-with-gpt](.claude/skills/discuss-with-gpt/SKILL.md)',
    '[create-issue-draft](.claude/skills/create-issue-draft/SKILL.md)',
    '[study-external-source](.claude/skills/study-external-source/SKILL.md)',
    '[publish-issue-draft](.claude/skills/publish-issue-draft/SKILL.md)',
    '[switch-pack-reviewer](.claude/skills/switch-pack-reviewer/SKILL.md)',
  ].join('\n'),
  'CLAUDE.md': [
    '[Architect role contract](.claude/skills/direct-fix-checklist/SKILL.md#architect-role-contract)',
    '[Draft-author relocation](.claude/skills/discuss-with-gpt/SKILL.md#draft-author-relocation)',
    '[RCA](.claude/skills/investigate-root-cause/SKILL.md)',
  ].join('\n'),
  'docs/browser-gpt-turn-runbook.md': [
    '## Start-of-shift preflight',
    '## Prepare one turn',
    '## Launch',
    '## Observe and settle',
    '## Publication and tab lifecycle',
    '## Incident handling',
    '## One-shot diagnosis',
    '## Shift handoff/close',
  ].join('\n'),
  'docs/coworker-delegation.md': 'PR diff recipe\ngit diff <base-ref>...HEAD > /tmp/review.diff\nRoot-cause work must read ~900 lines',
  'docs/tiering.md': '## Task complexity tier rubric\n### Failure-type lens (apply first)\n## Per-tier draft-review flow\n### Per-tier pipeline (ceilings, not quotas)',
  'docs/script-owned-review-pipeline.md': '## Event-driven review trigger\n## Orchestrator review-run coverage\n## Head ready for review\nevent-driven review trigger',
  'docs/orchestration-runbook.md': '## Worker lifecycle',
  'docs/repository_policy.md': [
    '## Plan-first execution',
    '## Task and scope authority',
    '## Scope discipline',
    '## Build the minimum',
    '## Local verification',
  ].join('\n'),
  '.claude/skills/investigate-root-cause/SKILL.md': '# investigate-root-cause',
  '.claude/skills/merge-with-local-adoption/SKILL.md': '# merge-with-local-adoption',
  '.claude/skills/adversarial-draft-review/SKILL.md': '# adversarial-draft-review',
  '.claude/skills/discuss-with-gpt/SKILL.md': '## Draft-author relocation',
  '.claude/skills/create-issue-draft/SKILL.md': '# create-issue-draft',
  '.claude/skills/study-external-source/SKILL.md': '# study-external-source',
  '.claude/skills/publish-issue-draft/SKILL.md': '# publish-issue-draft',
  '.claude/skills/switch-pack-reviewer/SKILL.md': '# switch-pack-reviewer',
  '.claude/skills/direct-fix-checklist/SKILL.md': '## Architect role contract',
  '.cursor/rules/draft-author-relocation.mdc': '[Draft-author relocation](../../.claude/skills/discuss-with-gpt/SKILL.md#draft-author-relocation)',
  '.cursor/rules/flow-manager-browser-turn-monitoring.mdc': [
    '[Preflight](../../docs/browser-gpt-turn-runbook.md#start-of-shift-preflight)',
    '[Prepare](../../docs/browser-gpt-turn-runbook.md#prepare-one-turn)',
    '[Launch](../../docs/browser-gpt-turn-runbook.md#launch)',
    '[Observe](../../docs/browser-gpt-turn-runbook.md#observe-and-settle)',
    '[Publication](../../docs/browser-gpt-turn-runbook.md#publication-and-tab-lifecycle)',
    '[Incident](../../docs/browser-gpt-turn-runbook.md#incident-handling)',
    '[Diagnosis](../../docs/browser-gpt-turn-runbook.md#one-shot-diagnosis)',
    '[Handoff](../../docs/browser-gpt-turn-runbook.md#shift-handoffclose)',
    '## Launch and observation',
    '## Legacy state and diagnostic probe',
  ].join('\n'),
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
      'scripts/check-capture-redaction-selftest.ps1',
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
      if (item.gateId === 'agent-rules-size-budget' && item.case === 'real-clean-tree') {
        // Frozen pre-delete capture stays bound to baseCommitSha; live AGENTS.md may shrink without rewriting history.
        expect(result?.legacyStdout, item.gateId).toMatch(/^\[PASS\] AGENTS\.md size budget \(\d+ lines, \d+ bytes\)\n$/u);
        continue;
      }
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
    expect(result.legacyStdout).toBe(capture('capture-redaction', 'credential-url-fixture').stdout);
  });
});