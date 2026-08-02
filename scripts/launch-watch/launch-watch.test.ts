import { describe, expect, it } from 'vitest';
import {
  cleanupOverride,
  encodeLaunchCommand,
  invalidLaunchResult,
  invalidWatchResult,
  parseLaunchRequest,
  parseWatchRequest,
  selectCleanupError,
  validateResult,
} from '../lib/launch-watch/contract.ts';
import { runAggregateProof } from './aggregate.ts';
import { emitResult, serializeResult } from '../lib/launch-watch/emission.ts';

const launch = (overrides: Record<string, unknown> = {}): Uint8Array => Buffer.from(JSON.stringify({
  requestVersion: 'launch-request/v1',
  cwd: '/tmp/worktree',
  targetRef: 'main',
  remoteRef: 'origin/main',
  model: 'cursor-agent',
  effort: 'high',
  initialInstruction: 'do the task',
  ...overrides,
}));

describe('launch/watch contract', () => {
  it('accepts defaults and preserves command data', () => {
    const parsed = parseLaunchRequest(launch({ model: 'm x', effort: 'e"y', initialInstruction: 'line 1\nline 2' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.deadlineMs).toBe(120_000);
    expect(encodeLaunchCommand(parsed.request)).toContain("'m x'");
    expect(encodeLaunchCommand(parsed.request)).toContain("'line 1\nline 2'");
  });

  it('uses stable closed launch validation codes', () => {
    expect(parseLaunchRequest(launch({ model: '' })).code).toBe('launch_model_empty');
    expect(parseLaunchRequest(launch({ targetRef: 'feature' })).code).toBe('launch_unsupported_target_ref');
    expect(parseLaunchRequest(launch({ deadlineMs: 9_999 })).code).toBe('launch_deadline_out_of_range');
    expect(parseLaunchRequest(Buffer.from('{"requestVersion":"launch-request/v1","deadlineMs":"bad"}')).code).toBe('launch_wrong_field_type');
    expect(parseLaunchRequest(launch({ initialInstruction: '\u0000' })).code).toBe('launch_nul_byte');
  });

  it('rejects unsupported watch rows and keeps invalid results source-free', () => {
    const parsed = parseWatchRequest(Buffer.from(JSON.stringify({
      requestVersion: 'watch-request/v1',
      sourceId: 'github.pull-request',
      predicateId: 'terminal.read',
      repo: 'owner/repo',
      prNumber: 1,
    })));
    expect(parsed).toMatchObject({ ok: false, code: 'watch_unsupported_predicate' });
    const result = invalidWatchResult('watch_unsupported_predicate', 30_000);
    expect(result.sourceId).toBeNull();
    expect(result.predicateId).toBeNull();
    expect(result.evidence).toEqual({});
    expect(invalidLaunchResult('launch_unknown_field', 120_000).outcome).toBe('invalid-request');
  });

  it('applies cleanup precedence and preserves primary fields', () => {
    expect(selectCleanupError(['cleanup_sink_close_failed', 'cleanup_reap_failed'])).toBe('cleanup_reap_failed');
    const primary = invalidLaunchResult('launch_unknown_field', 120_000);
    const overridden = cleanupOverride(primary, 'failed', {
      terminalHandle: null, helperProcessGroupId: 'pgid', redirectedSinkId: 'sink',
    }, 'cleanup_sink_close_failed');
    expect(overridden.outcome).toBe('cleanup-failed');
    expect(overridden.reasonCode).toBe('launch_unknown_field');
    expect(overridden.primaryReasonCode).toBe('launch_unknown_field');
    expect(validateResult(overridden).ok).toBe(true);
    expect(validateResult({ ...primary, extra: true }).ok).toBe(false);
  });

  it('passes the executable aggregate proof and fails its zero-coverage negative', () => {
    expect(runAggregateProof().ok).toBe(true);
    expect(runAggregateProof({ zeroCoverage: true }).ok).toBe(false);
  });

  it('serializes a typed fallback and reports transport failure separately', async () => {
    const fallback = serializeResult({ schema: 'launch-result/v1', value: BigInt(1) });
    expect(fallback.serializationFallback).toBe(true);
    expect(JSON.parse(fallback.serialized)).toMatchObject({
      schema: 'launch-result/v1',
      outcome: 'emission-failed',
      reasonCode: 'emission_serialize_failed',
    });
    const output = {
      write: () => { throw new Error('EPIPE'); },
      once: () => output,
      removeListener: () => output,
    } as unknown as NodeJS.WritableStream;
    await expect(emitResult(invalidLaunchResult('launch_unknown_field', 120_000), output)).resolves.toMatchObject({ transportOk: false });
  });
});
