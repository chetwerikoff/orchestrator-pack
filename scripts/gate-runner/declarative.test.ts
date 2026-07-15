import { describe, expect, it } from 'vitest';
import { evaluateDeclarativeGate, type DeclarativeGateDefinition } from './declarative.ts';
import { memorySnapshot } from './source-snapshot.ts';

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
