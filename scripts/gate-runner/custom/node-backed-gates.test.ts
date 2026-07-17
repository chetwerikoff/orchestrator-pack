import { describe, expect, it } from 'vitest';
import { aggregateLane } from '../contracts.ts';
import { formatGateRunnerReport } from '../runner.ts';
import type { ProcessResult } from '#opk-kernel/subprocess';
import {
  evaluateNodeBackedGate,
  nodeBackedGateCommands,
  type NodeGateProcessRunner,
} from './node-backed-gates.ts';


function outcome(overrides: Partial<ProcessResult>): ProcessResult {
  return {
    outcome: 'exit',
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: '[PASS] fixture\n',
    stderr: '',
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

describe('node-backed Wave 3.b gates', () => {
  it('preserves the launch wrapper success and failure suffixes', () => {
    const command = nodeBackedGateCommands.find((candidate) => candidate.gateId === 'launch-argv-inventory')!;
    const passRunner: NodeGateProcessRunner = () => outcome({ stdout: '[PASS] generated audit\n' });
    const passed = evaluateNodeBackedGate(command, '/fixture', passRunner);
    expect(passed.legacyStdout).toBe('[PASS] generated audit\n[PASS] launch-argv inventory guard (Issue #661)\n');

    const failRunner: NodeGateProcessRunner = () => outcome({ ok: false, exitCode: 1, stdout: '[FAIL] generated audit\n' });
    const failed = evaluateNodeBackedGate(command, '/fixture', failRunner);
    expect(failed.legacyStdout).toBe('[FAIL] generated audit\n[FAIL] launch-argv inventory guard (Issue #661)\n');
  });

  it('preserves the child stdout on a positive fixture', () => {
    const command = nodeBackedGateCommands[0]!;
    const runner: NodeGateProcessRunner = () => outcome({ stdout: 'legacy pass line\n' });
    const result = evaluateNodeBackedGate(command, '/fixture', runner);
    expect(result.status).toBe('PASS');
    expect(result.legacyStdout).toBe('legacy pass line\n');
  });

  it('fails on a negative fixture and retains child diagnostics', () => {
    const command = nodeBackedGateCommands[0]!;
    const runner: NodeGateProcessRunner = () => outcome({ ok: false, exitCode: 1, stdout: '', stderr: 'fixture contract failed\n' });
    const result = evaluateNodeBackedGate(command, '/fixture', runner);
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain('fixture contract failed');
  });

  it.each([
    ['spawn-failure', outcome({ outcome: 'spawn-failure', ok: false, exitCode: null, error: 'ENOENT', stdout: '' })],
    ['signal', outcome({ outcome: 'signal', ok: false, exitCode: null, signal: 'SIGTERM', stdout: 'partial child output\n' })],
    ['timeout', outcome({ outcome: 'timeout', ok: false, exitCode: null, timedOut: true, stdout: '' })],
    ['cancelled', outcome({ outcome: 'cancelled', ok: false, exitCode: null, cancelled: true, stdout: '' })],
  ] as const)('formats %s as SKIP without synthesizing a legacy PASS line', (_caseName, processResult) => {
    const command = nodeBackedGateCommands[0]!;
    const runner: NodeGateProcessRunner = () => processResult;
    const result = evaluateNodeBackedGate(command, '/fixture', runner);
    const formatted = formatGateRunnerReport({ results: [result], aggregate: aggregateLane([result]) });
    expect(result.status).toBe('SKIP');
    expect(result.allowSkip).not.toBe(true);
    expect(result.evidence).toContainEqual(expect.objectContaining({ class: 'live-adoption', state: 'unreachable' }));
    expect(result.legacyStdout).toBe(processResult.stdout || undefined);
    expect(formatted).not.toContain('[PASS] external-output shape guard');
    expect(formatted).toContain('[SKIP] external-output-shape-guard:');
    if (processResult.stdout) expect(formatted).toContain(processResult.stdout.trimEnd());
  });

});
