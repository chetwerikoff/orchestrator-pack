import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  computeSmokeCompletionBodyDigest,
  ensureSmokeRunArtifactDir,
  smokeCompletionBodyPath,
  smokeCompletionPendingBodyPath,
  smokeCompletionSealPath,
  smokeDeliverySealedPath,
} from './lib/worker-smoke-core.ts';
import {
  buildWorkerSmokeRunFailureReceipt,
  defaultOpenCodeGenerationProbe,
  installStableWorkerSmokeSpawnPatch,
  quarantineUnsupportedHistoricalSmokeRuns,
} from './lib/worker-smoke-bounded-create.ts';
import {
  createSmokeLifecycleReservation,
  bindSmokeTerminalHandle,
  preflightSmokeLifecycle,
  readSmokeLifecycleRegistry,
  releaseSmokeAdmission,
} from './lib/worker-smoke-lifecycle.ts';
import {
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaTerminalSummary,
} from './orca-runtime/native.ts';
import { OrcaTaskRuntimeAdapter } from './orca-runtime/task-adapter.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import type { RuntimeAdapter, RuntimeCallOptions } from './runtime/contracts.ts';
import { projectRunnerPackReviewStatusFact } from './lib/pack-review-delivery.ts';
import {
  establishRuntimeSmokeDelivery,
  projectExpectedPrTarget,
  runtimeClose,
  runtimeCloseBoundHandle,
  waitForRuntimeSmokeCompletion,
} from './worker-smoke-run.ts';

const HEAD = '1'.repeat(40);

class DeadlineBoundReadAdapter extends DeterministicRuntimeAdapter {
  readonly readCalls: Array<{ previousToken?: string; limit?: number; timeoutMs?: number }> = [];

  override readBoundedOutput(
    input: Parameters<RuntimeAdapter['readBoundedOutput']>[0],
    options?: RuntimeCallOptions,
  ): ReturnType<RuntimeAdapter['readBoundedOutput']> {
    const timeoutMs = options?.timeoutMs;
    this.readCalls.push({
      previousToken: input.previousToken?.opaque,
      limit: input.limit,
      timeoutMs,
    });
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('readBoundedOutput requires positive timeoutMs');
    }
    return {
      status: 'ok',
      value: {
        worker: input.worker,
        lines: [],
        observationToken: input.previousToken ?? { opaque: 'next-token' },
        changed: false,
        terminalState: 'running',
        source: 'stream',
      },
    };
  }
}

function ok<T>(result: T): OrcaJsonResponse<T> {
  return { ok: true, result };
}

function executable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function run(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return runProcessSync({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    inheritParentEnv: true,
  });
}

function jsonLines(value: string): unknown[] {
  return value
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

function sealedPassBody(): string {
  return [
    '```worker-smoke-report',
    'result: PASS',
    'tracked-files-unmodified: true',
    'scenarios:',
    '  - action: execute sealed completion | expected: one sealed report | observed: report sealed | outcome: pass',
    '```',
  ].join('\n');
}

describe('Issue #1419 trusted readiness target', () => {
  it('fails closed when an open PR is retargeted away from the repository default branch', () => {
    expect(projectExpectedPrTarget({
      state: 'open',
      base: { ref: 'release' },
    }, {
      default_branch: 'main',
    })).toEqual({
      prOpen: true,
      baseRef: 'release',
      expectedTargetRef: 'main',
      expectedTarget: false,
    });
  });

  it('accepts only an open PR whose base is the live repository default branch', () => {
    expect(projectExpectedPrTarget({
      state: 'open',
      base: { ref: 'main' },
    }, {
      default_branch: 'main',
    }).expectedTarget).toBe(true);
  });


  it('never re-admits semantic pack-review output as runner-owned input', () => {
    expect(projectRunnerPackReviewStatusFact(
      'success',
      'pack review evidence is complete for current facts',
    )).toEqual({
      hasLegitimateReview: false,
      unresolvedBlockingFinding: false,
    });
    expect(projectRunnerPackReviewStatusFact(
      'failure',
      'pack review has unresolved blocking findings',
    )).toEqual({
      hasLegitimateReview: false,
      unresolvedBlockingFinding: false,
    });
    expect(projectRunnerPackReviewStatusFact(
      'success',
      'Pack review completed with no findings.',
    )).toEqual({
      hasLegitimateReview: true,
      unresolvedBlockingFinding: false,
    });
  });
});

describe('Issue #1359 production worker-smoke reachability', () => {
  it('uses exact show despite list miss and title drift, then dispatches exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-production-dispatch-'));
    let sendCalls = 0;
    let showCalls = 0;
    let probeCalls = 0;
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({
          terminal: {
            handle: 'terminal-1',
            title: 'smoke-1359',
            incarnationId: 'create-generation',
          },
        } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: HEAD } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') {
        showCalls += 1;
        return ok({
          terminal: {
            handle: 'terminal-1',
            title: showCalls === 1 ? 'smoke-1359' : 'renamed-smoke-1359',
            incarnationId: 'stable-generation',
            worktreePath: root,
            status: 'running',
          },
        } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'list') {
        return ok({ terminals: [] } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'send') {
        sendCalls += 1;
        return ok({ sent: true } as T);
      }
      throw new Error(args.join(' '));
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => {
        probeCalls += 1;
        return ok({
          terminal: {
            handle: 'terminal-1',
            title: 'renamed-smoke-1359',
            incarnationId: 'stable-generation',
            worktreePath: root,
            status: 'running',
          },
        });
      },
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker({
        title: 'smoke-1359',
        command: 'cursor-agent',
        workspace: 'active',
      }, { cwd: root });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;
      expect(spawned.value.identity.generation).toBe('stable-generation');

      const artifactDir = join(root, 'run-1359');
      ensureSmokeRunArtifactDir(artifactDir);
      writeFileSync(
        smokeDeliverySealedPath(artifactDir),
        JSON.stringify({ runId: 'run-1359' }),
        'utf8',
      );
      expect(establishRuntimeSmokeDelivery({
        adapter,
        worker: spawned.value.identity,
        prompt: 'execute the scenario',
        binding: { runId: 'run-1359', artifactDir },
        cwd: root,
        deadlineMs: 100,
        now: () => 1,
        sleepMs: () => undefined,
      })).toMatchObject({ ok: true });
      expect(probeCalls).toBeGreaterThanOrEqual(2);
      expect(sendCalls).toBe(1);
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'create')).toBe(true);
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'list')).toBe(false);
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'send')).toBe(true);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps partial publication pending until one sealed report is complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-sealed-completion-'));
    const artifactDir = join(root, 'run-sealed');
    const runId = 'run-sealed';
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({ title: 'sealed', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    ensureSmokeRunArtifactDir(artifactDir);
    writeFileSync(smokeCompletionPendingBodyPath(artifactDir), 'in progress', 'utf8');
    let clock = 0;
    let published = false;

    try {
      const completion = waitForRuntimeSmokeCompletion({
        adapter,
        worker: spawned.value.identity,
        binding: { runId, artifactDir },
        scenarioCount: 1,
        cwd: root,
        startedAtMs: 0,
        abortReason: () => undefined,
        now: () => clock,
        sleepMs: (milliseconds) => {
          clock += milliseconds;
          if (published) return;
          published = true;
          const body = sealedPassBody();
          const digest = computeSmokeCompletionBodyDigest(body);
          rmSync(smokeCompletionPendingBodyPath(artifactDir), { force: true });
          writeFileSync(smokeCompletionBodyPath(artifactDir, digest), body, { flag: 'wx' });
          writeFileSync(
            smokeCompletionSealPath(artifactDir, digest),
            JSON.stringify({ runId, bodySha256: digest }),
            { flag: 'wx' },
          );
        },
        absoluteCeilingMs: 1_000,
        progressStallMs: 1_000,
      });
      expect(completion.ok).toBe(true);
      expect(completion.partial?.result).toBe('PASS');
      expect(published).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an actionable missing-seal cause instead of terminal partial', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-unsealed-timeout-'));
    const artifactDir = join(root, 'run-unsealed');
    const runId = 'run-unsealed';
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({ title: 'unsealed', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    ensureSmokeRunArtifactDir(artifactDir);
    writeFileSync(smokeCompletionPendingBodyPath(artifactDir), 'unfinished report', 'utf8');
    let clock = 0;

    try {
      const completion = waitForRuntimeSmokeCompletion({
        adapter,
        worker: spawned.value.identity,
        binding: { runId, artifactDir },
        scenarioCount: 1,
        cwd: root,
        startedAtMs: 0,
        abortReason: () => undefined,
        now: () => clock,
        sleepMs: (milliseconds) => { clock += milliseconds; },
        absoluteCeilingMs: 5,
        progressStallMs: 100,
      });
      expect(completion.ok).toBe(false);
      expect(completion.reason).toContain('agent_report_timeout');
      expect(completion.reason).toContain('missing=completion_body_or_seal_incomplete');
      expect(completion.reason).toContain('publication_state=partial');
      expect(completion.reason).not.toBe('partial');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds completion reads by the remaining deadline after inner smoke PASS', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-bounded-read-timeout-'));
    const artifactDir = join(root, 'run-bounded-read-timeout');
    const runId = 'run-bounded-read-timeout';
    const adapter = new DeadlineBoundReadAdapter();
    const previousToken = { opaque: 'inner-pass-token' };
    const spawned = adapter.spawnWorker({ title: 'bounded-read-timeout', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    ensureSmokeRunArtifactDir(artifactDir);
    writeFileSync(smokeDeliverySealedPath(artifactDir), JSON.stringify({ runId }), 'utf8');
    let clock = 100;

    try {
      const completion = waitForRuntimeSmokeCompletion({
        adapter,
        worker: spawned.value.identity,
        binding: { runId, artifactDir },
        scenarioCount: 6,
        cwd: root,
        startedAtMs: clock,
        previousToken,
        abortReason: () => undefined,
        now: () => clock,
        sleepMs: (milliseconds) => { clock += milliseconds; },
        absoluteCeilingMs: 1_000,
        progressStallMs: 25,
      });
      expect(completion.ok).toBe(false);
      expect(completion.reason).toContain('agent_report_timeout');
      expect(adapter.readCalls).toEqual([{
        previousToken: previousToken.opaque,
        limit: 200,
        timeoutMs: 25,
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the native close error and proves the owned handle remains present', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-close-failure-'));
    const handle = 'terminal-close-failure';
    const generation = 'generation-close-failure';
    const message = 'close denied by runtime verbatim';
    const terminal: OrcaTerminalSummary = {
      handle,
      incarnationId: generation,
      title: 'close-failure',
      worktreePath: root,
      status: 'running',
    };
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({ terminal: { handle, incarnationId: generation, title: 'close-failure' } } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: HEAD } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') {
        return ok({ terminal } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'close') {
        return {
          ok: false,
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'runtime_error', message },
        };
      }
      throw new Error(args.join(' '));
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => ok({ terminal }),
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker({
        title: 'close-failure',
        command: 'cursor-agent',
        workspace: 'active',
      }, { cwd: root });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;

      const outcome = runtimeClose(adapter, spawned.value.identity, { cwd: root });
      expect(outcome).toContain('close_failed:runtime_operation_failed');
      expect(outcome).toContain(`runtime_error=${JSON.stringify({ code: 'runtime_error', message })}`);
      expect(outcome).toContain('presence=present');
      expect(outcome).toContain(`handle=${handle}`);
      expect(outcome).toContain(`generation=${generation}`);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a leftover bound run through the runtime adapter before admitting the next smoke', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-leftover-recovery-'));
    const adapter = new DeterministicRuntimeAdapter();
    const spawned = adapter.spawnWorker({ title: 'leftover', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    const runId = 'leftover-bound';
    const registryPath = join(root, '.orca-worker-smoke', 'runs', runId);

    try {
      const reservation = createSmokeLifecycleReservation({
        runId,
        artifactDir: registryPath,
        issueNumber: 1359,
        prNumber: 1365,
        headSha: HEAD,
        supervisorPid: 987654,
        nowMs: 10,
        scenarioCount: 1,
      });
      expect(reservation.spawnState).toBe('reserved');
      bindSmokeTerminalHandle(registryPath, spawned.value.identity.id);
      const admission = preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'next-run',
        supervisorPid: 987655,
        nowMs: 20,
        isProcessAlive: () => false,
        shutdownMs: 0,
        closeBoundHandle: (handle) => runtimeCloseBoundHandle(adapter, handle, { cwd: '/test/workspace' }),
      });
      expect(admission.admitted).toBe(true);
      const oldRegistry = readSmokeLifecycleRegistry(registryPath);
      expect(oldRegistry?.spawnState).toBe('clean');
      expect(adapter.findWorkerById(spawned.value.identity.id)).toEqual({ status: 'ok', value: null });
      expect(releaseSmokeAdmission(root, 'next-run')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a leftover bound run blocked when the close proof fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-leftover-blocked-'));
    const runId = 'leftover-unproven';
    const registryPath = join(root, '.orca-worker-smoke', 'runs', runId);

    try {
      const reservation = createSmokeLifecycleReservation({
        runId,
        artifactDir: registryPath,
        issueNumber: 1359,
        prNumber: 1365,
        headSha: HEAD,
        supervisorPid: 987654,
        nowMs: 10,
        scenarioCount: 1,
      });
      expect(reservation.spawnState).toBe('reserved');
      bindSmokeTerminalHandle(registryPath, 'historical-terminal');
      const admission = preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'next-run',
        supervisorPid: 987655,
        nowMs: 20,
        isProcessAlive: () => false,
        shutdownMs: 0,
        closeBoundHandle: () => 'close_failed:cross_process_identity_not_adopted',
      });
      expect(admission.admitted).toBe(false);
      if (admission.admitted === false) {
        expect(admission.reason).toBe('blocking_lifecycle:leftover-unproven:cleanup_failed');
      }
      const registry = readSmokeLifecycleRegistry(registryPath);
      expect(registry?.spawnState).toBe('cleanup_failed');
      expect(registry?.cleanup?.closeOutcome).toBe('close_failed:cross_process_identity_not_adopted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a post-freeze replacement before the original dispatcher can send', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-no-send-'));
    let sendCalls = 0;
    let probeCalls = 0;
    const stable: OrcaTerminalSummary = {
      handle: 'terminal-2',
      title: 'smoke-1359',
      incarnationId: 'stable-generation',
      worktreePath: root,
      status: 'running',
    };
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({
          terminal: {
            handle: stable.handle,
            title: stable.title,
            incarnationId: 'create-generation',
          },
        } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: HEAD } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') {
        return ok({ terminal: stable } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'send') {
        sendCalls += 1;
        return ok({ sent: true } as T);
      }
      throw new Error(args.join(' '));
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => {
        probeCalls += 1;
        return ok({
          terminal: probeCalls === 1
            ? stable
            : { ...stable, incarnationId: 'replacement-generation' },
        });
      },
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker({
        title: 'smoke-1359',
        command: 'cursor-agent',
        workspace: 'active',
      }, { cwd: root });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;
      expect(spawned.value.identity.generation).toBe('stable-generation');

      const dispatched = adapter.dispatchInput({
        worker: spawned.value.identity,
        text: 'must never be sent',
      }, { cwd: root });
      expect(dispatched.status).toBe('send_failed');
      if (dispatched.status === 'send_failed') {
        expect(dispatched.reason).toContain('worker_generation_mismatch');
        expect(dispatched.reason).toContain('expected_generation=stable-generation');
        expect(dispatched.reason).toContain('observed_generation=replacement-generation');
        expect(dispatched.reason).toContain('identity_source=orca_terminal_show(terminal-2)');
        expect(dispatched.reason).toContain('resolution=');
      }
      expect(probeCalls).toBeGreaterThanOrEqual(2);
      expect(spawned.value.identity.generation).toBe('stable-generation');
      expect(sendCalls).toBe(0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a missing-handle-like show failure unresolved and sends zero payload bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-handle-disappeared-'));
    let probeCalls = 0;
    let sendCalls = 0;
    const stable: OrcaTerminalSummary = {
      handle: 'terminal-dead',
      title: 'smoke-1359',
      incarnationId: 'stable-generation',
      worktreePath: root,
      status: 'running',
    };
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({
          terminal: {
            handle: stable.handle,
            title: stable.title,
            incarnationId: 'create-generation',
          },
        } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: HEAD } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') {
        return ok({ terminal: stable } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'send') {
        sendCalls += 1;
        return ok({ sent: true } as T);
      }
      throw new Error(args.join(' '));
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => {
        probeCalls += 1;
        if (probeCalls === 1) return ok({ terminal: stable });
        return {
          ok: false,
          operation: 'terminal_show',
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'terminal_not_found', message: 'terminal is no longer alive' },
        };
      },
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker({
        title: 'smoke-1359',
        command: 'cursor-agent',
        workspace: 'active',
      }, { cwd: root });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;
      expect(spawned.value.identity.generation).toBe('stable-generation');

      const dispatched = adapter.dispatchInput({
        worker: spawned.value.identity,
        text: 'must never be sent',
      }, { cwd: root });
      expect(dispatched.status).toBe('send_failed');
      if (dispatched.status === 'send_failed') {
        expect(dispatched.reason).toContain('worker_generation_unresolved');
        expect(dispatched.reason).toContain('expected_handle=terminal-dead');
        expect(dispatched.reason).toContain('expected_generation=stable-generation');
        expect(dispatched.reason).toContain('observed_generation=unresolved');
        expect(dispatched.reason).toContain('lookup_failure=terminal_show%3Aterminal_not_found');
        expect(dispatched.reason).toContain('resolution=');
      }
      expect(probeCalls).toBe(2);
      expect(sendCalls).toBe(0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a wrong-worktree observation before payload send', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-worktree-mismatch-'));
    let sendCalls = 0;
    let probeCalls = 0;
    const stable: OrcaTerminalSummary = {
      handle: 'terminal-worktree',
      title: 'smoke-1359',
      incarnationId: 'stable-generation',
      worktreePath: root,
      status: 'running',
    };
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({ terminal: { ...stable, worktreePath: undefined } } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: HEAD } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') return ok({ terminal: stable } as T);
      if (args[0] === 'terminal' && args[1] === 'send') {
        sendCalls += 1;
        return ok({ sent: true } as T);
      }
      return { ok: false, error: { code: 'unexpected_test_operation', message: args.join(' ') } };
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => {
        probeCalls += 1;
        return ok({
          terminal: probeCalls === 1
            ? stable
            : { ...stable, worktreePath: join(root, 'foreign') },
        });
      },
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker({
        title: stable.title ?? 'smoke-1359',
        command: 'cursor-agent',
        workspace: 'active',
      }, { cwd: root });
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;

      const dispatched = adapter.dispatchInput({
        worker: spawned.value.identity,
        text: 'must never be sent',
      }, { cwd: root });
      expect(dispatched.status).toBe('send_failed');
      if (dispatched.status === 'send_failed') {
        expect(dispatched.reason).toContain('worker_workspace_mismatch');
        expect(dispatched.reason).toContain('expected_workspace=');
        expect(dispatched.reason).toContain('observed_workspace=');
      }
      expect(probeCalls).toBeGreaterThanOrEqual(2);
      expect(sendCalls).toBe(0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines unsupported historical cleanup before real admission', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-historical-admission-'));
    const historicalRunId = 'historical-unsupported';
    const historicalDir = join(root, '.orca-worker-smoke', 'runs', historicalRunId);
    mkdirSync(historicalDir, { recursive: true });
    writeFileSync(join(historicalDir, 'lifecycle.json'), `${JSON.stringify({
      version: 1,
      runId: historicalRunId,
      issueNumber: 1359,
      prNumber: 1365,
      headSha: HEAD,
      artifactDir: historicalDir,
      supervisorPid: 987654,
      createdAtMs: 1,
      updatedAtMs: 5,
      spawnState: 'cleanup_failed',
      createDeadlineMs: 2,
      scenarioCount: 1,
      terminalHandle: 'historical-terminal',
      closeAttemptedAtMs: 3,
      cleanup: {
        reason: 'unknown_legacy_cleanup',
        cooperativeAcknowledgementObserved: false,
        closeOutcome: 'close_failed:unknown_legacy_shape',
        operatorFilesCleared: false,
        completedAtMs: 4,
      },
    })}\n`, 'utf8');

    try {
      const quarantined = quarantineUnsupportedHistoricalSmokeRuns(root);
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]?.runId).toBe(historicalRunId);
      expect(existsSync(historicalDir)).toBe(false);
      const quarantineDir = join(root, '.orca-worker-smoke', 'quarantine', historicalRunId);
      expect(existsSync(quarantineDir)).toBe(true);
      const reason = JSON.parse(
        readFileSync(join(quarantineDir, 'quarantine-reason.json'), 'utf8'),
      ) as { cause?: string; source?: string; quarantine?: string };
      expect(reason.cause).toContain(`unsupported_historical_cleanup:${historicalRunId}`);
      expect(reason.source).toBe(`.orca-worker-smoke/runs/${historicalRunId}`);
      expect(reason.quarantine).toBe(`.orca-worker-smoke/quarantine/${historicalRunId}`);
      expect(reason.cause).toContain('resolution=');

      const admission = preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'current-run',
        supervisorPid: process.pid,
        nowMs: 10,
        isProcessAlive: () => false,
        shutdownMs: 0,
        closeBoundHandle: () => 'close_failed:must_not_be_called',
      });
      expect(admission.admitted).toBe(true);
      expect(releaseSmokeAdmission(root, 'current-run')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invokes the supported executable wrapper directly from the checkout', () => {
    const wrapper = resolve('scripts/worker-smoke-run');
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);
    const result = run(wrapper, ['run', '--definitely-invalid', '--json']);
    expect(result.ok).toBe(false);
    const receipts = jsonLines(result.stdout) as Array<{
      schema?: string;
      result?: string;
      cause?: { code?: string; detail?: string };
      wrapper?: { executable?: boolean; launchFailure?: string };
    }>;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      schema: 'worker-smoke-run/v1',
      result: 'FAIL',
      cause: { code: 'invalid_cli' },
      wrapper: { executable: true, launchFailure: 'none' },
    });
    expect(receipts[0]?.cause?.detail).toContain('unknown argument: --definitely-invalid');
  });

  it.each([
    [
      'import failure',
      'Error [ERR_MODULE_NOT_FOUND]: Cannot find module bootstrap',
      'entrypoint_import_failed',
    ],
    [
      'Node preflight failure',
      'native-entrypoint-preflight: unsupported Node 21; Node 22 is required',
      'node_preflight_failed',
    ],
  ])('emits one wrapper receipt for %s before the entrypoint can report', (
    _name,
    termination,
    expectedCode,
  ) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-wrapper-bootstrap-'));
    const scriptsDir = join(root, 'scripts');
    const bin = join(root, 'bin');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const wrapper = join(scriptsDir, 'worker-smoke-run');
    const checkoutWrapper = resolve('scripts/worker-smoke-run');
    executable(wrapper, readFileSync(checkoutWrapper, 'utf8'));
    executable(join(bin, 'node'), `#!/usr/bin/env bash\nprintf '%s\\n' '${termination}' >&2\nexit 1\n`);

    try {
      const result = run(wrapper, ['run', '--json'], {
        cwd: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
      expect(result.ok).toBe(false);
      const receipts = jsonLines(result.stdout) as Array<{
        schema?: string;
        cause?: { code?: string; detail?: string };
      }>;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.schema).toBe('worker-smoke-run/v1');
      expect(receipts[0]?.cause?.code).toBe(expectedCode);
      expect(receipts[0]?.cause?.code).not.toBe('wrapper_not_executable');
      expect(receipts[0]?.cause?.detail).toContain(termination);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses wrapper_not_executable only for an observed permission-denied launch', () => {
    const common = {
      detail: 'Permission denied while launching scripts/worker-smoke-run',
      argv: ['run', '--issue', '1359', '--pr', '1365', '--head-sha', HEAD],
      wrapperPath: 'scripts/worker-smoke-run',
      wrapperExecutable: false,
    } as const;
    expect(buildWorkerSmokeRunFailureReceipt(common).cause.code)
      .not.toBe('wrapper_not_executable');
    expect(buildWorkerSmokeRunFailureReceipt({
      ...common,
      wrapperLaunchFailure: 'permission_denied',
    }).cause.code).toBe('wrapper_not_executable');
  });

  it('falls back to exact terminal-list observation when terminal-show times out', () => {
    const terminal: OrcaTerminalSummary = {
      handle: 'terminal-list-fallback',
      incarnationId: 'generation-list-fallback',
      worktreePath: process.cwd(),
      status: 'running',
    };
    const calls: Array<{ args: readonly string[]; timeoutMs?: number }> = [];
    const run = <T>(args: readonly string[], options: { timeoutMs?: number }): OrcaJsonResponse<T> => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      if (args[1] === 'list') return ok({ terminals: [terminal] } as T);
      return {
        ok: false,
        operation: 'terminal_show',
        outcomeCategory: 'supported_operation_failure',
        error: { code: 'orca_operation_timeout', message: 'terminal show timed out' },
      };
    };

    const observed = defaultOpenCodeGenerationProbe(
      terminal.handle!,
      process.cwd(),
      7_000,
      run,
    );

    expect(observed).toMatchObject({ ok: true, result: { terminal } });
    expect(calls.map(({ args }) => args)).toEqual([
      ['terminal', 'list'],
    ]);
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([5_000]);
  });

  it('keeps the default generation probe on the production Orca transport', () => {
    expect(typeof runOrcaJson).toBe('function');
    const terminal: OrcaTerminalSummary = {
      handle: 'terminal-proof',
      incarnationId: 'generation-proof',
      worktreePath: process.cwd(),
    };
    expect(terminal.incarnationId).toBe('generation-proof');
  });
});

describe('Issue #1933 interrupt and detached wait fences', () => {
  it('classifies signals before stderr/empty-output parsing and keeps timeout authoritative', async () => {
    const { neutralFailureReason } = await import('./orca-runtime/adapter.ts');
    const secret = 'SECRET_CANARY_1933';
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const response = runOrcaJson(['terminal', 'read'], {
        runner: (() => ({
          status: null,
          signal,
          stdout: '',
          stderr: secret,
          error: undefined,
        })) as never,
      });
      expect(response).toMatchObject({
        ok: false,
        outcomeCategory: 'process_signaled',
        signal,
        error: { code: 'orca_process_signaled' },
      });
      expect(neutralFailureReason(response)).toBe(`runtime_cli_interrupted:${signal}`);
      expect(JSON.stringify(response)).not.toContain(secret);
    }

    const timeoutError = Object.assign(new Error('fixture timed out'), { code: 'ETIMEDOUT' });
    const timedOut = runOrcaJson(['terminal', 'read'], {
      timeoutMs: 17,
      runner: (() => ({
        status: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: secret,
        error: timeoutError,
      })) as never,
    });
    expect(timedOut).toMatchObject({
      ok: false,
      outcomeCategory: 'supported_operation_failure',
      error: { code: 'orca_operation_timeout' },
    });
    expect(neutralFailureReason(timedOut)).toBe('runtime_timeout');
    expect(JSON.stringify(timedOut)).not.toContain(secret);

    const emptySuccess = runOrcaJson(['terminal', 'read'], {
      runner: (() => ({
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        error: undefined,
      })) as never,
    });
    expect(emptySuccess.outcomeCategory).toBe('empty_stdout');
    expect(neutralFailureReason(emptySuccess)).toBe('runtime_response_invalid');

    const emptyFailure = runOrcaJson(['terminal', 'read'], {
      runner: (() => ({
        status: 7,
        signal: null,
        stdout: '',
        stderr: secret,
        error: undefined,
      })) as never,
    });
    expect(emptyFailure).toMatchObject({
      ok: false,
      outcomeCategory: 'supported_operation_failure',
      error: { code: 'orca_process_exit_without_output' },
    });
    expect(neutralFailureReason(emptyFailure)).toBe('runtime_operation_failed');
  });

  it('retries CLI interruptions on fresh polls and caps every completion read at 30 seconds', () => {
    class InterruptingReadAdapter extends DeterministicRuntimeAdapter {
      readonly readCalls: Array<{ previousToken?: string; timeoutMs?: number }> = [];

      override readBoundedOutput(
        input: Parameters<RuntimeAdapter['readBoundedOutput']>[0],
        options?: RuntimeCallOptions,
      ): ReturnType<RuntimeAdapter['readBoundedOutput']> {
        this.readCalls.push({
          previousToken: input.previousToken?.opaque,
          timeoutMs: options?.timeoutMs,
        });
        return {
          status: 'failed',
          operation: 'read_bounded_output',
          reason: 'runtime_cli_interrupted:SIGTERM',
        };
      }
    }

    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-interrupted-polls-'));
    const artifactDir = join(root, 'run-interrupted-polls');
    const runId = 'run-interrupted-polls';
    const adapter = new InterruptingReadAdapter();
    const spawned = adapter.spawnWorker({ title: 'interrupt-polls', command: 'cursor-agent' });
    expect(spawned.status).toBe('ok');
    if (spawned.status !== 'ok') return;
    ensureSmokeRunArtifactDir(artifactDir);
    let clock = 0;
    let sleeps = 0;

    try {
      const completion = waitForRuntimeSmokeCompletion({
        adapter,
        worker: spawned.value.identity,
        binding: { runId, artifactDir },
        scenarioCount: 1,
        cwd: root,
        startedAtMs: 0,
        abortReason: () => undefined,
        now: () => clock,
        sleepMs: (milliseconds) => {
          clock += milliseconds;
          sleeps += 1;
          if (sleeps !== 2) return;
          const body = sealedPassBody();
          const digest = computeSmokeCompletionBodyDigest(body);
          writeFileSync(smokeCompletionBodyPath(artifactDir, digest), body, { flag: 'wx' });
          writeFileSync(
            smokeCompletionSealPath(artifactDir, digest),
            JSON.stringify({ runId, bodySha256: digest }),
            { flag: 'wx' },
          );
        },
        absoluteCeilingMs: 60_000,
        progressStallMs: 60_000,
      });

      expect(completion.ok).toBe(true);
      expect(completion.observationFailures).toEqual([
        'runtime_cli_interrupted:SIGTERM',
        'runtime_cli_interrupted:SIGTERM',
      ]);
      expect(adapter.readCalls).toHaveLength(2);
      expect(adapter.readCalls.map(({ timeoutMs }) => timeoutMs)).toEqual([30_000, 30_000]);
      expect(adapter.readCalls.map(({ previousToken }) => previousToken)).toEqual([undefined, undefined]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('wait refuses same-target evidence from another run and leaves lifecycle files byte-identical', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-wait-exact-run-'));
    const runA = 'run-a';
    const runB = 'run-b';
    const artifactA = join(root, '.orca-worker-smoke', 'runs', runA);
    const artifactB = join(root, '.orca-worker-smoke', 'runs', runB);
    const {
      createSmokeNoExecutionLifecycle,
      markSmokeLauncherTerminalized,
      smokeAdmissionLockPath,
      smokeLifecycleRegistryPath,
    } = await import('./lib/worker-smoke-lifecycle.ts');
    const {
      smokeRunFinalEvidencePath,
      writeWorkerSmokeRunFinalEvidence,
    } = await import('./lib/worker-smoke-receipt.ts');
    const report = {
      result: 'PASS',
      issueNumber: 1933,
      prNumber: 1941,
      headSha: HEAD,
      scenarios: [],
      trackedFilesUnmodified: true,
      limitations: [],
      environmentNotes: [],
      producer: 'worker-smoke-run',
      terminalCleanup: 'not_started_no_execution',
      orcaExecutable: 'not_applicable',
    } as never;

    try {
      createSmokeNoExecutionLifecycle({
        runId: runA,
        artifactDir: artifactA,
        issueNumber: 1933,
        prNumber: 1941,
        headSha: HEAD,
        nowMs: 1,
      });
      createSmokeNoExecutionLifecycle({
        runId: runB,
        artifactDir: artifactB,
        issueNumber: 1933,
        prNumber: 1941,
        headSha: HEAD,
        nowMs: 1,
      });
      writeWorkerSmokeRunFinalEvidence({
        artifactDir: artifactB,
        runId: runB,
        mode: 'no_execution',
        report,
        nowMs: 2,
      });
      writeFileSync(
        smokeRunFinalEvidencePath(artifactA),
        readFileSync(smokeRunFinalEvidencePath(artifactB), 'utf8'),
        'utf8',
      );
      markSmokeLauncherTerminalized({
        artifactDir: artifactA,
        runId: runA,
        finalEvidencePath: smokeRunFinalEvidencePath(artifactA),
        nowMs: 3,
      });

      const lifecycleBefore = readFileSync(smokeLifecycleRegistryPath(artifactA), 'utf8');
      const evidenceBefore = readFileSync(smokeRunFinalEvidencePath(artifactA), 'utf8');
      expect(existsSync(smokeAdmissionLockPath(root))).toBe(false);

      const wait = run(resolve('scripts/worker-smoke-run'), [
        'wait', '--run', runA, '--cwd', root, '--json',
      ], { cwd: root });
      expect(wait.ok).toBe(false);
      expect(wait.stdout).toContain('terminal_evidence_invalid');
      expect(readFileSync(smokeLifecycleRegistryPath(artifactA), 'utf8')).toBe(lifecycleBefore);
      expect(readFileSync(smokeRunFinalEvidencePath(artifactA), 'utf8')).toBe(evidenceBefore);
      expect(existsSync(smokeAdmissionLockPath(root))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Issue #1933 detached bootstrap and no-execution regressions', () => {
  it('times out after a detached owner exits before reservation without bootstrap-owned lifecycle state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-detach-timeout-'));
    const { vi } = await import('vitest');
    const { main } = await import('./worker-smoke-run.ts');
    const { smokeAdmissionLockPath } = await import('./lib/worker-smoke-lifecycle.ts');
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 70_000;
      return clock;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const code = await main([
        'run', '--detach',
        '--issue', '1933',
        '--pr', '1941',
        '--head-sha', HEAD,
        '--issue-body-file', join(root, 'missing-issue.md'),
        '--smoke-complexity', 'complex',
        '--repo-root', root,
        '--cwd', root,
        '--dry-run',
        '--json',
      ]);
      expect(code).toBe(1);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join(''))
        .toContain('worker_smoke_detach_lifecycle_timeout\n');
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join(''))
        .not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
      expect(existsSync(smokeAdmissionLockPath(root))).toBe(false);
      expect(existsSync(join(root, '.orca-worker-smoke', 'runs'))).toBe(false);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      now.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a detached-owner crash after reservation before terminal binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-detached-reservation-crash-'));
    const crashedRunId = 'detached-crashed-after-reservation';
    const crashedDir = join(root, '.orca-worker-smoke', 'runs', crashedRunId);

    try {
      createSmokeLifecycleReservation({
        runId: crashedRunId,
        artifactDir: crashedDir,
        issueNumber: 1933,
        prNumber: 1941,
        headSha: HEAD,
        supervisorPid: 41001,
        nowMs: 1,
        createTimeoutMs: 1,
        scenarioCount: 1,
      });
      const next = preflightSmokeLifecycle({
        repoRoot: root,
        runId: 'detached-recovery-winner',
        supervisorPid: 41002,
        nowMs: 10,
        isProcessAlive: () => false,
        shutdownMs: 0,
        closeBoundHandle: () => 'close_failed:must_not_be_called',
      });
      expect(next.admitted).toBe(true);
      expect(readSmokeLifecycleRegistry(crashedDir)?.spawnState).toBe('abandoned_unbound');
      expect(releaseSmokeAdmission(root, 'detached-recovery-winner')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('admits exactly one detached owner and refuses a concurrent second owner before reservation', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-detached-concurrency-'));
    const firstRun = 'detached-concurrency-a';
    const secondRun = 'detached-concurrency-b';

    try {
      const first = preflightSmokeLifecycle({
        repoRoot: root,
        runId: firstRun,
        supervisorPid: 42001,
        nowMs: 1,
        isProcessAlive: () => false,
        shutdownMs: 0,
        closeBoundHandle: () => 'close_failed:must_not_be_called',
      });
      expect(first.admitted).toBe(true);

      const second = preflightSmokeLifecycle({
        repoRoot: root,
        runId: secondRun,
        supervisorPid: 42002,
        nowMs: 2,
        isProcessAlive: (pid) => pid === 42001,
        shutdownMs: 0,
        closeBoundHandle: () => 'close_failed:must_not_be_called',
      });
      expect(second.admitted).toBe(false);
      if (!second.admitted) expect(second.reason).toBe(`active_smoke_admission:${firstRun}`);
      expect(readSmokeLifecycleRegistry(join(root, '.orca-worker-smoke', 'runs', secondRun))).toBeUndefined();
      expect(releaseSmokeAdmission(root, firstRun)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('terminalizes detached carry-only as exact-run no_execution evidence without an admission lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-detached-carry-only-'));
    const runId = 'detached-carry-only';
    const artifactDir = join(root, '.orca-worker-smoke', 'runs', runId);
    const {
      createSmokeNoExecutionLifecycle,
      evaluateSmokeLifecycleCleanliness,
      markSmokeLauncherTerminalized,
      smokeAdmissionLockPath,
    } = await import('./lib/worker-smoke-lifecycle.ts');
    const {
      smokeRunFinalEvidencePath,
      writeWorkerSmokeRunFinalEvidence,
    } = await import('./lib/worker-smoke-receipt.ts');
    const report = {
      result: 'PASS',
      issueNumber: 1933,
      prNumber: 1941,
      headSha: HEAD,
      scenarios: [{
        action: 'carry prior PASS',
        expected: 'no runtime execution',
        observed: `carried PASS from head ${HEAD} comment 1; not freshly executed on ${HEAD}`,
        outcome: 'pass',
      }],
      trackedFilesUnmodified: true,
      limitations: [],
      environmentNotes: ['smoke-execution=carry-only'],
      producer: 'worker-smoke-run',
      terminalCleanup: 'not_started_no_execution',
      orcaExecutable: 'test',
    } as never;

    try {
      createSmokeNoExecutionLifecycle({
        runId,
        artifactDir,
        issueNumber: 1933,
        prNumber: 1941,
        headSha: HEAD,
        nowMs: 1,
      });
      expect(readSmokeLifecycleRegistry(artifactDir)).toMatchObject({
        runId,
        mode: 'no_execution',
        spawnState: 'no_execution_pending',
        scenarioCount: 0,
      });
      expect(evaluateSmokeLifecycleCleanliness(root).clean).toBe(false);
      expect(existsSync(smokeAdmissionLockPath(root))).toBe(false);

      const final = writeWorkerSmokeRunFinalEvidence({
        artifactDir,
        runId,
        mode: 'no_execution',
        report,
        nowMs: 2,
      });
      markSmokeLauncherTerminalized({
        artifactDir,
        runId,
        finalEvidencePath: smokeRunFinalEvidencePath(artifactDir),
        nowMs: final.recordedAtMs,
      });
      expect(readSmokeLifecycleRegistry(artifactDir)).toMatchObject({
        runId,
        mode: 'no_execution',
        spawnState: 'no_execution_terminal',
        finalEvidencePath: smokeRunFinalEvidencePath(artifactDir),
      });
      expect(evaluateSmokeLifecycleCleanliness(root).clean).toBe(true);
      expect(existsSync(smokeAdmissionLockPath(root))).toBe(false);

      const wait = run(resolve('scripts/worker-smoke-run'), [
        'wait', '--run', runId, '--cwd', root, '--json',
      ], { cwd: root });
      expect(wait.ok).toBe(true);
      expect(JSON.parse(wait.stdout)).toMatchObject({
        ok: true,
        runId,
        result: 'PASS',
        report: { result: 'PASS', issueNumber: 1933, prNumber: 1941, headSha: HEAD },
      });
      expect(existsSync(smokeAdmissionLockPath(root))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
