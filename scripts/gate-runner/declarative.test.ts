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
  'AGENTS.md': '## Coworker CLI delegation\n## RTK read-exploration\n## RCA spec discipline',
  'docs/coworker-delegation.md': 'PR diff recipe\ngit diff <base-ref>...HEAD > /tmp/review.diff\nRoot-cause work must read ~900 lines',
  'docs/tiering.md': '## Task complexity tier rubric\n### Red-flag markers (any one → T3)\n## Per-tier draft-review flow\n### Per-tier pipeline (ceilings, not quotas)',
  'docs/script-owned-review-pipeline.md': '## Event-driven review trigger\n## Orchestrator review-run coverage\n## Head ready for review\nevent-driven review trigger',
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
});
