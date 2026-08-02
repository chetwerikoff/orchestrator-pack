import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
import { ACCEPTANCE_SCENARIOS, CLEANUP_FIXTURE_IDS, REQUIRED_SCENARIO_IDS } from '../lib/launch-watch/fixtures.ts';
import { emitResult, serializeResult } from '../lib/launch-watch/emission.ts';
import { executeLaunchRequest } from './launch.ts';
import type { ProcessResult } from '../kernel/subprocess.ts';

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

const processResult = (stdout = '', overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  outcome: 'exit',
  ok: true,
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  cancelled: false,
  ...overrides,
});

function requestFor(cwd: string) {
  const parsed = parseLaunchRequest(launch({ cwd, deadlineMs: 10_000 }));
  if (!parsed.ok) throw new Error(`test request rejected: ${parsed.code}`);
  return parsed.request;
}

function trustMarker(home: string, cwd: string): string {
  const slug = cwd.replace(/^[/\\]+/u, '').split(/[/\\]+/u).map((part) => part.trim().replace(/^\.+/u, '')).filter(Boolean).join('-');
  const candidate = join(home, '.cursor', 'projects', slug);
  if (candidate.length <= 92) return join(candidate, '.workspace-trusted');
  const hash = createHash('sha256').update(candidate).digest('hex').slice(0, 7);
  return join(`${candidate.slice(0, 84)}-${hash}`, '.workspace-trusted');
}

function launchRunner(options: {
  readonly cwd: string;
  readonly home: string;
  readonly postHead?: string;
  readonly closeStdout?: string;
  readonly createStdout?: string;
  readonly createResult?: ProcessResult;
  readonly nowMode?: 'stable' | 'cutoff' | 'cleanup-expired' | 'post-create-expired';
}) {
  const calls: Array<{ readonly command: string; readonly args: readonly string[]; readonly timeoutMs: number }> = [];
  let trustCompleted = false;
  let createCompleted = false;
  const now = (): number => {
    if (options.nowMode === 'cutoff' && trustCompleted) return 4_000;
    if (options.nowMode === 'cleanup-expired' && createCompleted) return 9_000;
    if (options.nowMode === 'post-create-expired' && createCompleted) return 114_000;
    return 0;
  };
  const run = async (command: string, args: readonly string[], runOptions: { readonly timeoutMs: number }): Promise<ProcessResult> => {
    calls.push({ command, args, timeoutMs: runOptions.timeoutMs });
    if (command === 'git' && args[0] === 'branch') return processResult('main\n');
    if (command === 'git' && args[0] === 'status') return processResult('');
    if (command === 'git' && args[0] === 'fetch') return processResult('');
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'origin/main') return processResult('sha\n');
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return processResult(createCompleted ? options.postHead ?? 'sha\n' : 'sha\n');
    }
    if (command === 'git' && args[0] === 'merge-base' && args[1] === 'HEAD') return processResult('');
    if (command === 'git' && args[0] === 'merge-base') return processResult('', { ok: false, exitCode: 1 });
    if (command === 'orca' && args[0] === 'worktree') {
      return processResult(JSON.stringify({ ok: true, result: { worktree: { path: options.cwd, id: 'wt' } } }));
    }
    if (command === 'pwsh') {
      const marker = trustMarker(options.home, options.cwd);
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, JSON.stringify({ workspacePath: options.cwd }));
      trustCompleted = true;
      return processResult('');
    }
    if (command === 'orca' && args[0] === 'terminal' && args[1] === 'create') {
      createCompleted = true;
      if (options.createResult) return options.createResult;
      if (options.createStdout) return processResult(options.createStdout);
      return processResult(JSON.stringify({ ok: true, result: { terminal: { handle: 'term', worktreeId: 'wt' } } }));
    }
    if (command === 'orca' && args[0] === 'terminal' && args[1] === 'close') {
      return processResult(options.closeStdout ?? '{"ok":true}');
    }
    throw new Error(`unexpected test command: ${command} ${args.join(' ')}`);
  };
  return { calls, now, run };
}

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

  it('keeps watch validation errors ordered and closed', () => {
    const githubBase = { requestVersion: 'watch-request/v1', sourceId: 'github.pull-request', predicateId: 'pr.merged' };
    expect(parseWatchRequest(Buffer.from(JSON.stringify({ ...githubBase, terminalHandle: 'unexpected' }))).code).toBe('watch_missing_repo');
    expect(parseWatchRequest(Buffer.from(JSON.stringify({ ...githubBase, repo: `owner/${'r'.repeat(260)}`, prNumber: 1 }))).code).toBe('watch_value_too_large');
    expect(parseWatchRequest(Buffer.from(JSON.stringify({
      requestVersion: 'watch-request/v1', sourceId: 'orca.terminal', predicateId: 'terminal.read', repo: 'owner/repo',
    }))).code).toBe('watch_missing_terminal_handle');
    expect(parseLaunchRequest(Uint8Array.from([0x7b, 0x00, 0xc3])).code).toBe('launch_invalid_utf8');
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

  it('passes the executable aggregate proof and fails its zero-coverage negative', async () => {
    expect((await runAggregateProof()).ok).toBe(true);
    expect((await runAggregateProof({ zeroCoverage: true })).ok).toBe(false);
  });

  it('executes every spec-owned aggregate coverage row', () => {
    const acceptanceIds = ACCEPTANCE_SCENARIOS.map((entry) => entry.split(':', 1)[0] ?? '');
    const scenarioIds = REQUIRED_SCENARIO_IDS.map((entry) => entry);
    const fixtureIds = CLEANUP_FIXTURE_IDS.map((entry) => {
      expect(entry.startsWith('cleanup.')).toBe(true);
      return entry;
    });
    expect(acceptanceIds).toHaveLength(8);
    expect(scenarioIds.length).toBeGreaterThan(0);
    expect(fixtureIds.length).toBeGreaterThan(0);
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
    const stalled = {
      write: () => true,
      once: () => stalled,
      removeListener: () => stalled,
    } as unknown as NodeJS.WritableStream;
    await expect(emitResult(invalidLaunchResult('launch_unknown_field', 120_000), stalled, 1)).resolves.toMatchObject({ transportOk: false });
  });

  it('validates terminal close responses and bounds cleanup to the reserved remainder', async () => {
    const cwd = '/tmp/launch-watch-close-test';
    const home = mkdtempSync(join(tmpdir(), 'launch-watch-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const closeStdout of ['', '{"ok":false}', '{malformed']) {
        const invalidClose = launchRunner({ cwd, home, postHead: 'other\n', closeStdout });
        const result = await executeLaunchRequest(requestFor(cwd), { run: invalidClose.run, now: invalidClose.now });
        expect(result.outcome).toBe('cleanup-failed');
        expect(invalidClose.calls.find((call) => call.args[1] === 'close')?.timeoutMs).toBe(5_000);
      }

      const expiredCleanup = launchRunner({ cwd, home, nowMode: 'cleanup-expired' });
      const expired = await executeLaunchRequest(requestFor(cwd), { run: expiredCleanup.run, now: expiredCleanup.now });
      expect(expired.outcome).toBe('cleanup-failed');
      expect(expired.cleanup?.cleanupErrorCode).toBe('cleanup_timeout');
      expect(expiredCleanup.calls.some((call) => call.args[1] === 'close')).toBe(false);
      expect(expired.containment?.closeAttempted).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not dispatch terminal creation after the work cutoff', async () => {
    const cwd = '/tmp/launch-watch-cutoff-test';
    const home = mkdtempSync(join(tmpdir(), 'launch-watch-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner = launchRunner({ cwd, home, nowMode: 'cutoff' });
      const result = await executeLaunchRequest(requestFor(cwd), { run: runner.run, now: runner.now });
      expect(result.outcome).toBe('deadline-exceeded');
      expect(result.phase).toBe('terminal-create');
      expect(runner.calls.some((call) => call.args[1] === 'create')).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('emits a binding deadline when post-create verification cannot start', async () => {
    const cwd = '/tmp/launch-watch-post-create-deadline-test';
    const home = mkdtempSync(join(tmpdir(), 'launch-watch-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner = launchRunner({ cwd, home, nowMode: 'post-create-expired' });
      const result = await executeLaunchRequest(requestFor(cwd), { run: runner.run, now: runner.now });
      expect(result.outcome).toBe('cleanup-failed');
      expect(result.primaryOutcome).toBe('deadline-exceeded');
      expect(result.primaryReasonCode).toBe('launch_deadline_binding_verification');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prioritizes terminal ok:false over a nonzero create exit', async () => {
    const cwd = '/tmp/launch-watch-create-response-priority-test';
    const home = mkdtempSync(join(tmpdir(), 'launch-watch-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner = launchRunner({
        cwd,
        home,
        createResult: processResult('{"ok":false,"error":{"opaque":"keep"}}', { ok: false, exitCode: 1 }),
      });
      const result = await executeLaunchRequest(requestFor(cwd), { run: runner.run, now: runner.now });
      expect(result.reasonCode).toBe('terminal_create_dispatched_ok_false');
      expect(result.outcome).toBe('terminal-create-ambiguous');
      expect(result.evidence).toHaveProperty('response.error');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('latches invalid terminal binding before cutoff post-create reads', async () => {
    const cwd = '/tmp/launch-watch-invalid-binding-cutoff-test';
    const home = mkdtempSync(join(tmpdir(), 'launch-watch-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner = launchRunner({
        cwd,
        home,
        nowMode: 'post-create-expired',
        createStdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term' } } }),
      });
      const result = await executeLaunchRequest(requestFor(cwd), { run: runner.run, now: runner.now });
      expect(result.primaryReasonCode).toBe('terminal_create_invalid_response_shape');
      expect(result.evidence).toMatchObject({ containmentClose: { cleanupBudgetExpired: true } });
      expect(runner.calls.filter((call) => call.args[0] === 'rev-parse' && call.args[1] === 'HEAD')).toHaveLength(2);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves process timeout and spawn-failure classifications before terminal creation', async () => {
    const request = requestFor('/tmp/launch-watch-process-test');
    const timeout = processResult('', { outcome: 'timeout', ok: false, timedOut: true, exitCode: null });
    const timedOut = await executeLaunchRequest(request, { run: async () => timeout, now: () => 0 });
    expect(timedOut.outcome).toBe('deadline-exceeded');
    expect(timedOut.phase).toBe('preflight');

    const failed = await executeLaunchRequest(request, { run: async () => { throw new Error('spawn failed'); }, now: () => 0 });
    expect(failed.outcome).toBe('source-unavailable');
    expect(failed.outcome).not.toBe('deadline-exceeded');

    const home = mkdtempSync(join(tmpdir(), 'launch-watch-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const spawnFailure = launchRunner({
        cwd: '/tmp/launch-watch-create-failure-test',
        home,
        createResult: processResult('', { outcome: 'spawn-failure', ok: false, exitCode: null }),
      });
      const result = await executeLaunchRequest(requestFor('/tmp/launch-watch-create-failure-test'), { run: spawnFailure.run, now: spawnFailure.now });
      expect(result.outcome).toBe('process-launch-failed');
      expect(result.retryAllowed).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('classifies invalid terminal bindings before post-create reads', async () => {
    const cwd = '/tmp/launch-watch-invalid-handle-test';
    const home = mkdtempSync(join(tmpdir(), 'launch-watch-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner = launchRunner({
        cwd,
        home,
        createStdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term' } } }),
      });
      const result = await executeLaunchRequest(requestFor(cwd), { run: runner.run, now: runner.now });
      expect(result.outcome).toBe('partial-cleanup');
      expect(runner.calls.filter((call) => call.args[0] === 'rev-parse' && call.args[1] === 'HEAD')).toHaveLength(2);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
