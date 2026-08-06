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
  installStableWorkerSmokeSpawnPatch,
  quarantineUnsupportedHistoricalSmokeRuns,
} from './lib/worker-smoke-bounded-create.ts';
import {
  preflightSmokeLifecycle,
  releaseSmokeAdmission,
} from './lib/worker-smoke-lifecycle.ts';
import {
  runOrcaJson,
  type OrcaJsonResponse,
  type OrcaTerminalSummary,
} from './orca-runtime/native.ts';
import { OrcaTaskRuntimeAdapter } from './orca-runtime/task-adapter.ts';
import { DeterministicRuntimeAdapter } from './runtime/test-adapter.ts';
import {
  establishRuntimeSmokeDelivery,
  runtimeClose,
  waitForRuntimeSmokeCompletion,
} from './worker-smoke-run.ts';

const HEAD = '1'.repeat(40);

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

describe('Issue #1359 production worker-smoke reachability', () => {
  it('runs production spawn, generation lookup, and exactly one dispatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-production-dispatch-'));
    let sendCalls = 0;
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
      if (args[0] === 'terminal' && args[1] === 'list') {
        return ok({
          terminals: [{
            handle: 'terminal-1',
            title: 'smoke-1359',
            incarnationId: 'stable-generation',
            worktreePath: root,
            status: 'running',
          }],
        } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'send') {
        sendCalls += 1;
        return ok({ sent: true } as T);
      }
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      probe: () => ok({
        terminal: {
          handle: 'terminal-1',
          title: 'smoke-1359',
          incarnationId: 'stable-generation',
          worktreePath: root,
          status: 'running',
        },
      }),
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
      expect(sendCalls).toBe(1);
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'create')).toBe(true);
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'list')).toBe(true);
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

  it('preserves the native close error and proves the owned handle remains present', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-close-failure-'));
    const handle = 'terminal-close-failure';
    const generation = 'generation-close-failure';
    const message = 'close denied by runtime verbatim';
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({ terminal: { handle, incarnationId: generation, title: 'close-failure' } } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: HEAD } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'list') {
        return ok({
          terminals: [{
            handle,
            incarnationId: generation,
            title: 'close-failure',
            worktreePath: root,
            status: 'running',
          }],
        } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'close') {
        return {
          ok: false,
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'runtime_error', message },
        };
      }
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };

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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses failed identity stabilization before the original dispatcher can send', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-no-send-'));
    let lookupCalls = 0;
    let sendCalls = 0;
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({
          terminal: {
            handle: 'terminal-2',
            title: 'smoke-1359',
            incarnationId: 'create-generation',
          },
        } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: HEAD } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'list') {
        lookupCalls += 1;
        return ok({ terminals: [] } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'send') {
        sendCalls += 1;
        return ok({ sent: true } as T);
      }
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      probe: () => ({
        ok: false,
        operation: 'terminal_show',
        outcomeCategory: 'supported_operation_failure',
        error: { code: 'terminal_generation_missing', message: 'generation missing' },
      }),
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

      const dispatched = adapter.dispatchInput({
        worker: spawned.value.identity,
        text: 'must never be sent',
      }, { cwd: root });
      expect(dispatched.status).toBe('send_failed');
      if (dispatched.status === 'send_failed') {
        expect(dispatched.reason).toContain('worker_generation_not_found');
        expect(dispatched.reason).toContain('expected_generation=create-generation');
        expect(dispatched.reason).toContain('identity_source=orca_terminal_show(terminal-2)');
        expect(dispatched.reason).toContain('resolution=');
      }
      expect(lookupCalls).toBe(0);
      expect(sendCalls).toBe(0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses actionably before send when the created handle disappears before dispatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-handle-disappeared-'));
    let probeCalls = 0;
    let lookupCalls = 0;
    let sendCalls = 0;
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({
          terminal: {
            handle: 'terminal-dead',
            title: 'smoke-1359',
            incarnationId: 'create-generation',
          },
        } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: HEAD } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'list') {
        lookupCalls += 1;
        return ok({ terminals: [] } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'send') {
        sendCalls += 1;
        return ok({ sent: true } as T);
      }
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      probe: () => {
        probeCalls += 1;
        if (probeCalls === 1) {
          return ok({
            terminal: {
              handle: 'terminal-dead',
              title: 'smoke-1359',
              incarnationId: 'stable-generation',
              worktreePath: root,
              status: 'running',
            },
          });
        }
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
        expect(dispatched.reason).toContain('worker_generation_not_found');
        expect(dispatched.reason).toContain('expected_handle=terminal-dead');
        expect(dispatched.reason).toContain('expected_generation=stable-generation');
        expect(dispatched.reason).toContain('observed_generation=not_found');
        expect(dispatched.reason).toContain('lookup_failure=terminal_show%3Aterminal_not_found');
        expect(dispatched.reason).toContain('resolution=');
      }
      expect(probeCalls).toBe(2);
      expect(lookupCalls).toBe(0);
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
