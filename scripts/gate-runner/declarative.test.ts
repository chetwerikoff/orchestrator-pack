// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { describe, expect, it } from 'vitest';
import { evaluateDeclarativeGate, type DeclarativeGateDefinition } from './declarative.ts';
import {
  agentRulesBudgetGate,
  agentRulesGrepGate,
  agentRulesMovedContentGate,
} from './representative-gates.ts';
import { memorySnapshot } from './source-snapshot.ts';

const retiredAgentRulesFile = `${['agent', 'rules'].join('_')}.md`;

function gate(rule: DeclarativeGateDefinition['rules'][number]): DeclarativeGateDefinition {
  return {
    gateId: `fixture-${rule.kind}`,
    legacyScript: 'fixture.ps1',
    summary: rule.kind,
    rules: [rule],
    passStdout: 'PASS\n',
    failHeading: 'FAIL:',
  };
}

const movedClean = {
  'AGENTS.md': [
    '## Coworker CLI delegation',
    '## RTK read-exploration',
    'See [worker](docs/orchestration-runbook.md#worker-lifecycle).',
    'See [scope](docs/repository_policy.md#task-and-scope-authority).',
    'See [verification](docs/repository_policy.md#local-verification).',
    'See [RCA](.claude/skills/investigate-root-cause/SKILL.md#failure-response).',
  ].join('\n'),
  'CLAUDE.md': [
    'See [architect](.claude/skills/direct-fix-checklist/SKILL.md#architect-role-contract).',
    'See [author](.claude/skills/discuss-with-gpt/SKILL.md#draft-author-relocation).',
    'See [RCA](.claude/skills/investigate-root-cause/SKILL.md#failure-response).',
  ].join('\n'),
  'docs/coworker-delegation.md': 'PR diff recipe\ngit diff <base-ref>...HEAD > /tmp/review.diff\nRoot-cause work must read ~900 lines',
  'docs/tiering.md': '## Task complexity tier rubric\n### Failure-type lens (apply first)\n## Per-tier draft-review flow\n### Per-tier pipeline (ceilings, not quotas)',
  'docs/script-owned-review-pipeline.md': '## Event-driven review trigger\n## Orchestrator review-run coverage\n## Head ready for review\nevent-driven review trigger',
  'docs/orchestration-runbook.md': '## Worker lifecycle\n',
  'docs/repository_policy.md': '## Task and scope authority\n## Local verification\n',
  '.claude/skills/investigate-root-cause/SKILL.md': '## Failure response\n',
  '.claude/skills/direct-fix-checklist/SKILL.md': '## Architect role contract\n',
  '.claude/skills/discuss-with-gpt/SKILL.md': '## Draft-author relocation\n',
  '.cursor/rules/draft-author-relocation.mdc': 'See [author](../../.claude/skills/discuss-with-gpt/SKILL.md#draft-author-relocation).\n',
  '.cursor/rules/flow-manager-browser-turn-monitoring.mdc': '## Launch and observation\n## Legacy state and diagnostic probe\n',
};

describe('declarative rule kinds', () => {
  it('grep/inventory has positive and negative fixtures', () => {
    const definition = gate({ kind: 'grep-inventory', patterns: [/forbidden/u], failureSuffix: 'is forbidden' });
    expect(evaluateDeclarativeGate(definition, memorySnapshot({ 'a.txt': 'clean' })).status).toBe('PASS');
    const failed = evaluateDeclarativeGate(definition, memorySnapshot({ 'a.txt': 'forbidden' }));
    expect(failed.status).toBe('FAIL');
    expect(failed.details).toEqual(['a.txt is forbidden']);
  });

  it('line/byte budget has positive and negative fixtures', () => {
    const definition = gate({ kind: 'line-byte-budget', path: 'AGENTS.md', maxLines: 2, maxBytes: 8 });
    expect(evaluateDeclarativeGate(definition, memorySnapshot({ 'AGENTS.md': 'a\nb' })).status).toBe('PASS');
    expect(evaluateDeclarativeGate(definition, memorySnapshot({ 'AGENTS.md': 'abcdefghi\nq\nr' })).status).toBe('FAIL');
  });

  it('file presence has positive and negative fixtures', () => {
    const definition = gate({ kind: 'file-presence', paths: ['a.txt', 'b.txt'] });
    expect(evaluateDeclarativeGate(definition, memorySnapshot({ 'a.txt': '', 'b.txt': '' })).status).toBe('PASS');
    expect(evaluateDeclarativeGate(definition, memorySnapshot({ 'a.txt': '' })).status).toBe('FAIL');
  });

  it('static source assertion has positive and negative fixtures', () => {
    const definition = gate({
      kind: 'static-source',
      assertions: [{ path: 'a.txt', contains: ['required'], absent: ['forbidden'] }],
    });
    expect(evaluateDeclarativeGate(definition, memorySnapshot({ 'a.txt': 'required' })).status).toBe('PASS');
    expect(evaluateDeclarativeGate(definition, memorySnapshot({ 'a.txt': 'forbidden' })).status).toBe('FAIL');
  });

  it('static source exact-occurrence assertion rejects zero and duplicate pointers', () => {
    const marker = '(docs/policy.md#target)';
    const definition = gate({
      kind: 'static-source',
      assertions: [{ path: 'AGENTS.md', exactOccurrences: [{ marker, count: 1 }] }],
    });

    expect(evaluateDeclarativeGate(definition, memorySnapshot({ 'AGENTS.md': `See [policy]${marker}` })).status).toBe('PASS');

    const missing = evaluateDeclarativeGate(definition, memorySnapshot({ 'AGENTS.md': 'no pointer' }));
    expect(missing.status).toBe('FAIL');
    expect(missing.details).toContain(`AGENTS.md must contain exactly 1 occurrence(s) of ${marker}; found 0`);

    const duplicate = evaluateDeclarativeGate(
      definition,
      memorySnapshot({ 'AGENTS.md': `See [one]${marker}\nSee [two]${marker}` }),
    );
    expect(duplicate.status).toBe('FAIL');
    expect(duplicate.details).toContain(`AGENTS.md must contain exactly 1 occurrence(s) of ${marker}; found 2`);
  });

  it('section-anchor assertion rejects a missing target heading', () => {
    const definition = gate({ kind: 'section-anchor', roots: ['AGENTS.md'] });
    const passing = memorySnapshot({
      'AGENTS.md': 'See [policy](docs/repository_policy.md#plan-first-execution)\n',
      'docs/repository_policy.md': '## Plan-first execution\n',
    });
    expect(evaluateDeclarativeGate(definition, passing).status).toBe('PASS');
    const failing = evaluateDeclarativeGate(definition, memorySnapshot({
      'AGENTS.md': 'See [policy](docs/repository_policy.md#missing-heading)\n',
      'docs/repository_policy.md': '## Plan-first execution\n',
    }));
    expect(failing.status).toBe('FAIL');
    expect(failing.details).toContain('AGENTS.md unresolved section link: docs/repository_policy.md#missing-heading');
  });
});

describe('real representative declarative ports', () => {
  it('real grep/inventory gate has proving positive and negative fixtures', () => {
    expect(evaluateDeclarativeGate(agentRulesGrepGate, memorySnapshot({ 'README.md': 'clean' })).status).toBe('PASS');
    const failed = evaluateDeclarativeGate(agentRulesGrepGate, memorySnapshot({ 'README.md': retiredAgentRulesFile }));
    expect(failed.status).toBe('FAIL');
    expect(failed.legacyStdout).toBe(`[FAIL] live references to retired ${retiredAgentRulesFile}:\n - README.md references retired ${retiredAgentRulesFile}\n`);
  });

  it('real line/byte-budget gate has proving positive and negative fixtures', () => {
    expect(evaluateDeclarativeGate(agentRulesBudgetGate, memorySnapshot({ 'AGENTS.md': 'clean' })).status).toBe('PASS');
    const failed = evaluateDeclarativeGate(agentRulesBudgetGate, memorySnapshot({ 'AGENTS.md': `${'x\n'.repeat(450)}x` }));
    expect(failed.status).toBe('FAIL');
    expect(failed.legacyStdout).toContain('AGENTS.md has 451 lines (ceiling 450)');
  });

  it('real moved-content gate proves file-presence positive and negative paths', () => {
    expect(evaluateDeclarativeGate(agentRulesMovedContentGate, memorySnapshot(movedClean)).status).toBe('PASS');
    const { ['docs/tiering.md']: _removed, ...missingTiering } = movedClean;
    const failed = evaluateDeclarativeGate(agentRulesMovedContentGate, memorySnapshot(missingTiering));
    expect(failed.status).toBe('FAIL');
    expect(failed.details).toContain('missing required file: docs/tiering.md');
  });

  it('real moved-content gate proves static-source positive and negative paths with legacy wording', () => {
    const failed = evaluateDeclarativeGate(agentRulesMovedContentGate, memorySnapshot({
      ...movedClean,
      'AGENTS.md': `${movedClean['AGENTS.md']}\n## Task complexity tier rubric`,
    }));
    expect(failed.status).toBe('FAIL');
    expect(failed.legacyStdout).toBe('[FAIL] AGENTS.md moved-content guard:\n - AGENTS.md still contains moved deep-dive anchor: ## Task complexity tier rubric\n');
  });

  it('real moved-content gate rejects a duplicate universal pointer', () => {
    const duplicate = evaluateDeclarativeGate(agentRulesMovedContentGate, memorySnapshot({
      ...movedClean,
      'AGENTS.md': `${movedClean['AGENTS.md']}\nAgain (docs/orchestration-runbook.md#worker-lifecycle)`,
    }));
    expect(duplicate.status).toBe('FAIL');
    expect(duplicate.details).toContain(
      'AGENTS.md must contain exactly 1 occurrence(s) of (docs/orchestration-runbook.md#worker-lifecycle); found 2',
    );
  });
});
