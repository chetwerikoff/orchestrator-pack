import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess, runProcessSync, type ProcessResult } from './kernel/subprocess.ts';
import { installStableWorkerSmokeSpawnPatch } from './lib/worker-smoke-bounded-create.ts';
import {
  computeSmokeCompletionBodyDigest,
  ensureSmokeRunArtifactDir,
  smokeCompletionBodyPath,
  smokeCompletionSealPath,
} from './lib/worker-smoke-core.ts';
import { smokeProgressPath } from './lib/worker-smoke-lifecycle.ts';
import {
  type OrcaJsonResponse,
  type OrcaTerminalSummary,
} from './orca-runtime/native.ts';
import { OrcaTaskRuntimeAdapter } from './orca-runtime/task-adapter.ts';
import { runtimeClose, waitForRuntimeSmokeCompletion } from './worker-smoke-run.ts';

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runProcessSync({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    inheritParentEnv: true,
    encoding: 'utf8',
    timeoutMs: 30_000,
  });
}

function requireSuccess(
  command: string,
  args: readonly string[],
  cwd: string,
): ProcessResult {
  const result = run(command, args, { cwd });
  expect(result.exitCode, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

function ok<T>(result: T): OrcaJsonResponse<T> {
  return { ok: true, result };
}


function installTrustedTargetFixture(
  root: string,
  bin: string,
  issueBodyPath: string,
  headSha: string,
): void {
  requireSuccess(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/chetwerikoff/orchestrator-pack.git'],
    root,
  );
  writeFileSync(
    join(root, '.fake-gh-user.json'),
    JSON.stringify({ login: 'worker-smoke-fixture' }),
    'utf8',
  );
  writeFileSync(
    join(root, '.fake-gh-issue.json'),
    JSON.stringify({
      number: 1359,
      state: 'open',
      html_url: 'https://github.com/chetwerikoff/orchestrator-pack/issues/1359',
      body: readFileSync(issueBodyPath, 'utf8'),
    }),
    'utf8',
  );
  writeFileSync(
    join(root, '.fake-gh-pr.json'),
    JSON.stringify({
      number: 1365,
      state: 'open',
      html_url: 'https://github.com/chetwerikoff/orchestrator-pack/pull/1365',
      body: 'Closes #1359',
      head: { sha: headSha },
      base: { ref: 'main' },
    }),
    'utf8',
  );
  writeFileSync(
    join(root, '.fake-gh-repository.json'),
    JSON.stringify({ default_branch: 'main' }),
    'utf8',
  );
  writeFileSync(
    join(root, 'api'),
    [
      '#!/bin/sh',
      'set -eu',
      'case "$*" in',
      '  "user") cat .fake-gh-user.json ;;',
      '  "repos/chetwerikoff/orchestrator-pack/issues/1359") cat .fake-gh-issue.json ;;',
      '  "repos/chetwerikoff/orchestrator-pack/pulls/1365") cat .fake-gh-pr.json ;;',
      '  "repos/chetwerikoff/orchestrator-pack") cat .fake-gh-repository.json ;;',
      '  "repos/chetwerikoff/orchestrator-pack/issues/1365/comments?per_page=100&page=1") printf "%s\\n" "[]" ;;',
      '  *) printf "unexpected fake gh api call: %s\\n" "$*" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8',
  );
  symlinkSync('/bin/sh', join(bin, 'gh'));
  const cards = join(root, 'project-config', 'orchestrator-pack', 'projects');
  mkdirSync(cards, { recursive: true });
  writeFileSync(join(cards, 'smoke-fixture.json'), JSON.stringify({
    projectId: 'smoke-fixture',
    repository: 'chetwerikoff/orchestrator-pack',
    primaryRoot: root,
    defaultBranch: 'main',
    orcaWorkspacePattern: '.*',
    orchestratorTitlePattern: '.*',
    browserGpt: { projectUrl: 'https://chatgpt.com/' },
  }), 'utf8');
}

describe('Issue #1359 real worker-smoke entrypoint', () => {

  it('keeps the native smoke-test-plan CLI without detached lifecycle or progress artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-2250-cli-'));
    try {
      const issueBodyPath = join(root, 'issue.md');
      writeFileSync(issueBodyPath, [
        '```behavior-kind', 'action-producing', '```',
        '```smoke-test-plan', 'scenarios:',
        '  - action: verify smoke scenario | expected: PASS',
        '```',
      ].join('\n'), 'utf8');
      const result = run(resolve('scripts/worker-smoke-run'), [
        'validate-plan', '--issue-body-file', issueBodyPath, '--json',
      ], { cwd: root });
      expect(result.exitCode, String(result.stderr)).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as { ok?: boolean; plan?: { scenarios?: unknown[] } };
      expect(parsed.ok).toBe(true);
      expect(parsed.plan?.scenarios).toHaveLength(1);
      expect(existsSync(join(root, '.orca-worker-smoke', 'runs'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });





  it('gates OpenCode smoke without an effort channel before any runtime spawn', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-opencode-gate-'));
    const bin = join(root, 'bin');
    const issueBodyPath = join(root, 'issue.md');
    const runtimeCallsPath = join(root, 'runtime-called');
    mkdirSync(bin, { recursive: true });

    try {
      requireSuccess('git', ['init', '--quiet'], root);
      writeFileSync(issueBodyPath, [
        '```behavior-kind',
        'action-producing',
        '```',
        '',
        '```smoke-test-plan',
        'scenarios:',
        '  - action: run selected executor | expected: profile is applied before spawn',
        '```',
        '',
      ].join('\n'), 'utf8');
      installTrustedTargetFixture(root, bin, issueBodyPath, '1'.repeat(40));

      const fakeOpenCode = join(bin, 'opencode');
      writeFileSync(fakeOpenCode, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'models' && args.includes('--verbose')) process.stdout.write('fixture-opencode-model\\n{"variants":{"fixture-opencode-effort":{}}}\\n');
else if (args[0] === 'models') process.stdout.write('fixture-opencode-model\\n');
else if (args[0] === 'debug' && args[1] === 'agent') process.stdout.write(JSON.stringify({ model: { providerID: 'opencode', modelID: 'fixture-opencode-model' } }));
else if (args.includes('--help')) process.stderr.write('Usage: opencode --agent AGENT\\n');
else process.exitCode = 2;
`, 'utf8');
      chmodSync(fakeOpenCode, 0o755);

      const fakeOrca = join(bin, 'orca');
      writeFileSync(fakeOrca, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(runtimeCallsPath)}, process.argv.slice(2).join(' '), 'utf8');
process.exitCode = 2;
`, 'utf8');
      chmodSync(fakeOrca, 0o755);

      const wrapper = resolve('scripts/worker-smoke-run');
      const result = run(wrapper, [
        'run',
        '--issue', '1359',
        '--pr', '1365',
        '--head-sha', '1'.repeat(40),
        '--issue-body-file', issueBodyPath,
        '--smoke-complexity', 'routine',
        '--repo-root', root,
        '--cwd', root,
        '--dry-run',
        '--json',
      ], {
        cwd: root,
        env: {
          OPK_PROJECT_ID: 'smoke-fixture',
          XDG_CONFIG_HOME: join(root, 'project-config'),
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          OPK_RUNTIME_CLI_COMMAND: fakeOrca,
          PACK_EXECUTOR_SMOKE_ROUTINE_AGENT: 'opencode',
          PACK_EXECUTOR_SMOKE_ROUTINE_MODEL: 'fixture-opencode-model',
          PACK_EXECUTOR_SMOKE_ROUTINE_EFFORT: 'fixture-opencode-effort',
        },
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
      const lines = String(result.stdout).split(/\r?\n/u).filter((line) => line.trim());
      expect(lines).toHaveLength(1);
      const emitted = JSON.parse(lines[0]!) as { ok?: boolean; report?: { result?: string; scenarios?: Array<{ observed?: string }> } };
      expect(emitted).toMatchObject({ ok: false, report: { result: 'BLOCKED' } });
      expect(emitted.report?.scenarios?.[0]?.observed).toContain('executor_effort_channel_unavailable');
      expect(existsSync(runtimeCallsPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a missing-handle-like close observation unproven without consulting a foreign sibling', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-owned-absent-'));
    const owned: OrcaTerminalSummary = {
      handle: 'terminal-owned',
      title: 'owned',
      incarnationId: 'generation-owned',
      worktreePath: root,
      status: 'running',
    };
    const foreign: OrcaTerminalSummary = {
      handle: 'terminal-foreign',
      title: 'foreign',
      incarnationId: 'generation-foreign',
      worktreePath: root,
      status: 'running',
    };
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[0] === 'terminal' && args[1] === 'create') return ok({ terminal: owned } as T);
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: '1'.repeat(40) } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') return ok({ terminal: owned } as T);
      if (args[0] === 'terminal' && args[1] === 'list') return ok({ terminals: [foreign] } as T);
      throw new Error(`unexpected owned-absence fixture operation: ${args.join(' ')}`);
    };
    let probeCalls = 0;
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => {
        const attempt = ++probeCalls;
        if (attempt === 1) return ok({ terminal: owned });
        const unresolved: OrcaJsonResponse<{ terminal?: OrcaTerminalSummary }> = {
          ok: false,
          operation: 'terminal_show',
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'terminal_not_found', message: 'terminal is no longer alive' },
        };
        return unresolved;
      },
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker(
        { title: 'owned', command: 'cursor-agent', workspace: 'active' },
        { cwd: root },
      );
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;

      const outcome = runtimeClose(adapter, spawned.value.identity, { cwd: root });
      expect(outcome).toContain('close_failed:unproven_already_absent');
      expect(outcome).toContain('worker_generation_unresolved');
      expect(outcome).toContain('presence=unproven');
      expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'list')).toHaveLength(0);
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'close')).toBe(false);
      expect(calls.some((args) => args.includes(foreign.handle!))).toBe(false);
      expect(probeCalls).toBeGreaterThanOrEqual(2);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed as unproven_already_absent when exact inventory cannot be queried', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-inventory-unproven-'));
    const owned: OrcaTerminalSummary = {
      handle: 'terminal-inventory-unproven',
      title: 'inventory-unproven',
      incarnationId: 'generation-inventory-unproven',
      worktreePath: root,
      status: 'running',
    };
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[0] === 'terminal' && args[1] === 'create') return ok({ terminal: owned } as T);
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: '1'.repeat(40) } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') return ok({ terminal: owned } as T);
      throw new Error(args.join(' '));
    };
    let probeCalls = 0;
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => {
        probeCalls += 1;
        if (probeCalls === 1) return ok({ terminal: owned });
        return {
          ok: false,
          operation: 'terminal_show',
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'inventory_unavailable', message: 'runtime inventory unavailable' },
        };
      },
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker(
        { title: 'inventory-unproven', command: 'cursor-agent', workspace: 'active' },
        { cwd: root },
      );
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;

      const outcome = runtimeClose(adapter, spawned.value.identity, { cwd: root });
      expect(outcome).toContain('close_failed:unproven_already_absent');
      expect(outcome).toContain('worker_generation_unresolved');
      expect(outcome).toContain('presence=unproven');
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'close')).toBe(false);
      expect(probeCalls).toBeGreaterThanOrEqual(2);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves dispatch_unknown after one prompt actuation when delivery remains unconfirmable', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-submit-unconfirmed-'));
    const terminal: OrcaTerminalSummary = {
      handle: 'terminal-unconfirmed',
      title: 'smoke-submit-unconfirmed-1359',
      incarnationId: 'generation-unconfirmed',
      worktreePath: root,
      status: 'running',
    };
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[0] === 'terminal' && args[1] === 'create') return ok({ terminal } as T);
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: '1'.repeat(40) } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') return ok({ terminal } as T);
      if (args[0] === 'terminal' && args[1] === 'send') return ok({ sent: true } as T);
      if (args[0] === 'terminal' && args[1] === 'read') {
        return ok({
          terminal: {
            handle: terminal.handle,
            status: 'running',
            tail: ['prompt remains in composer'],
            nextCursor: '1',
          },
        } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'close') return ok({ closed: true } as T);
      throw new Error(args.join(' '));
    };
    let clock = 0;
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => ok({ terminal }),
      deliveryProbe: () => false,
      deliveryConfirmationTimeoutMs: 4,
      now: () => clock,
      sleepMs: (milliseconds) => { clock += milliseconds; },
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker(
        { title: 'smoke-submit-unconfirmed-1359', command: 'cursor-agent', workspace: 'active' },
        { cwd: root },
      );
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;

      const dispatched = adapter.dispatchInput({
        worker: spawned.value.identity,
        text: `Durable smoke-run binding (authoritative for delivery and completion):\nrun-id: run-unconfirmed\nartifact-dir: ${join(root, 'run-unconfirmed')}`,
      }, { cwd: root });

      expect(dispatched).toEqual({
        status: 'dispatch_unknown',
        reason: 'submit_witness_unavailable',
      });
      const sends = calls.filter((args) => args[0] === 'terminal' && args[1] === 'send');
      const reads = calls.filter((args) => args[0] === 'terminal' && args[1] === 'read');
      expect(sends).toHaveLength(1);
      expect(sends[0]).toContain('--text');
      expect(sends[0]).toContain('--enter');
      expect(reads).toHaveLength(0);

      const closeOutcome = runtimeClose(adapter, spawned.value.identity, { cwd: root });
      expect(closeOutcome).toContain('close_failed:delivery_failure_evidence_preserved');
      expect(closeOutcome).toContain('presence=present');
      expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'close')).toHaveLength(0);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the established generation frozen while read reaches plan_complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-read-generation-'));
    const artifactDir = join(root, 'run-read-generation');
    const runId = 'run-read-generation';
    const handle = 'terminal-read-generation';
    const title = 'smoke-read-generation-1359';
    const frozenGeneration = 'frozen-generation';
    let probeCalls = 0;
    let readCalls = 0;
    let waitCalls = 0;
    const terminal = (): OrcaTerminalSummary => ({
      handle,
      title,
      incarnationId: frozenGeneration,
      worktreePath: root,
      status: 'running',
    });
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({ terminal: { ...terminal(), incarnationId: 'create-generation' } } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: '1'.repeat(40) } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') return ok({ terminal: terminal() } as T);
      if (args[0] === 'terminal' && args[1] === 'send') return ok({ sent: true } as T);
      if (args[0] === 'terminal' && args[1] === 'read') {
        readCalls += 1;
        return ok({
          terminal: {
            handle,
            status: 'running',
            tail: ['sealed report ready'],
            nextCursor: String(readCalls),
          },
        } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'wait') {
        waitCalls += 1;
        return ok({
          wait: {
            handle,
            condition: 'tui-idle',
            satisfied: false,
            status: 'running',
          },
        } as T);
      }
      throw new Error(args.join(' '));
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => {
        probeCalls += 1;
        return ok({ terminal: terminal() });
      },
    });
    let clock = 0;
    let published = false;
    const publishCompletion = (): void => {
      const progressEvents = [
        { runId, scenarioOrdinal: 1, phase: 'started' },
        { runId, scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' },
      ];
      writeFileSync(
        smokeProgressPath(artifactDir),
        `${progressEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf8',
      );
      const body = [
        '```worker-smoke-report',
        'result: PASS',
        'tracked-files-unmodified: true',
        'scenarios:',
        '  - action: read sealed report | expected: plan completes | observed: report read | outcome: pass',
        '```',
      ].join('\n');
      const bodySha256 = computeSmokeCompletionBodyDigest(body);
      const bodyPath = smokeCompletionBodyPath(artifactDir, bodySha256);
      const sealPath = smokeCompletionSealPath(artifactDir, bodySha256);
      writeFileSync(bodyPath, body, { flag: 'wx' });
      writeFileSync(sealPath, JSON.stringify({ runId, bodySha256 }), { flag: 'wx' });
    };

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker(
        { title, command: 'cursor-agent', workspace: 'active' },
        { cwd: root },
      );
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;
      expect(spawned.value.identity.generation).toBe(frozenGeneration);

      const dispatched = adapter.dispatchInput({
        worker: spawned.value.identity,
        text: 'execute the sealed-report scenario',
      }, { cwd: root });
      expect(dispatched).toEqual({
        status: 'dispatch_unknown',
        reason: 'submit_witness_unavailable',
      });
      expect(spawned.value.identity.generation).toBe(frozenGeneration);

      ensureSmokeRunArtifactDir(artifactDir);
      const completion = waitForRuntimeSmokeCompletion({
        binding: { artifactDir, runId },
        startedAtMs: clock,
        cwd: root,
        scenarioCount: 1,
        worker: spawned.value.identity,
        adapter,
        now: () => clock,
        abortReason: () => undefined,
        progressStallMs: 1_000,
        absoluteCeilingMs: 1_000,
        sleepMs: (milliseconds) => {
          clock += milliseconds;
          if (!published) {
            published = true;
            publishCompletion();
          }
        },
      });

      expect(readCalls).toBeGreaterThan(0);
      expect(waitCalls).toBeGreaterThan(0);
      expect(probeCalls).toBeGreaterThan(0);
      expect(spawned.value.identity.generation).toBe(frozenGeneration);
      expect(completion).toMatchObject({
        ok: true,
        partial: { result: 'PASS' },
        progress: { planComplete: true },
      });
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses bounded output when exact-handle observation is unresolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-read-handle-absent-'));
    const handle = 'terminal-read-absent';
    const title = 'smoke-read-absent-1359';
    let probeCalls = 0;
    let readCalls = 0;
    const terminal: OrcaTerminalSummary = {
      handle,
      title,
      incarnationId: 'spawn-generation',
      worktreePath: root,
      status: 'running',
    };
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      if (args[0] === 'terminal' && args[1] === 'create') {
        return ok({ terminal: { ...terminal, incarnationId: 'create-generation' } } as T);
      }
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: '1'.repeat(40) } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') return ok({ terminal } as T);
      if (args[0] === 'terminal' && args[1] === 'read') {
        readCalls += 1;
        return ok({ terminal: { handle, status: 'running', tail: [], nextCursor: '1' } } as T);
      }
      throw new Error(args.join(' '));
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      agentStartupProbe: () => true,
      probe: () => {
        probeCalls += 1;
        return probeCalls === 1 ? ok({ terminal }) : ok({});
      },
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker(
        { title, command: 'cursor-agent', workspace: 'active' },
        { cwd: root },
      );
      expect(spawned.status).toBe('ok');
      if (spawned.status !== 'ok') return;

      const read = adapter.readBoundedOutput({
        worker: spawned.value.identity,
        limit: 200,
      }, { cwd: root });
      expect(read.status).toBe('failed');
      if (read.status === 'failed') {
        expect(read.operation).toBe('read_bounded_output');
        expect(read.reason).toContain('worker_generation_unresolved');
        expect(read.reason).toContain(`expected_handle=${handle}`);
        expect(read.reason).toContain('lookup_failure=terminal_show%3Amissing_terminal');
        expect(read.reason).toContain('resolution=');
      }
      expect(readCalls).toBe(0);
      expect(probeCalls).toBe(2);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes a thrown non-Error object as a readable machine cause', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-object-cause-'));
    const scriptsDir = join(root, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const wrapper = join(scriptsDir, 'worker-smoke-run');
    writeFileSync(wrapper, readFileSync(resolve('scripts/worker-smoke-run')), 'utf8');
    chmodSync(wrapper, 0o755);
    writeFileSync(join(scriptsDir, 'worker-smoke-run.ts'), [
      'export async function main(): Promise<number> {',
      "  throw { message: 'fixture object failure', code: 'fixture_non_error', detail: { scenarioOrdinal: 1 }, retryable: false };",
      '}',
      '',
    ].join('\n'), 'utf8');

    try {
      const result = run(wrapper, ['run', '--json'], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('[object Object]');
      const lines = String(result.stdout).split(/\r?\n/u).filter((line) => line.trim());
      expect(lines).toHaveLength(1);
      const receipt = JSON.parse(lines[0]!) as {
        schema?: string;
        result?: string;
        cause?: { code?: string; detail?: string };
      };
      expect(receipt).toMatchObject({
        schema: 'worker-smoke-run/v1',
        result: 'FAIL',
        cause: { code: 'entrypoint_exception' },
      });
      expect(receipt.cause?.detail).toContain('fixture object failure');
      expect(receipt.cause?.detail).toContain('fixture_non_error');
      expect(receipt.cause?.detail).toContain('"scenarioOrdinal":1');
      expect(receipt.cause?.detail).toContain('"kind":"non_error_object"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies a missing Cursor Agent banner as a transport startup failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-agent-start-'));
    const terminal: OrcaTerminalSummary = {
      handle: 'terminal-agent-start',
      title: 'agent-start',
      incarnationId: 'generation-agent-start',
      worktreePath: root,
      status: 'running',
      command: 'cursor-agent',
    };
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[0] === 'terminal' && args[1] === 'create') return ok({ terminal } as T);
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: '1'.repeat(40) } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') return ok({ terminal } as T);
      if (args[0] === 'terminal' && args[1] === 'send') return ok({ sent: true } as T);
      if (args[0] === 'terminal' && args[1] === 'read') {
        return ok({ terminal: {
          handle: terminal.handle,
          status: 'running',
          tail: ['$ cursor-agent'],
          nextCursor: '1',
        } } as T);
      }
      return { ok: false, error: { code: 'unexpected_test_operation', message: args.join(' ') } };
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      probe: () => ok({ terminal }),
    });

    try {
      const adapter = new OrcaTaskRuntimeAdapter({ cwd: root, runJson });
      const spawned = adapter.spawnWorker(
        { title: 'agent-start', command: 'cursor-agent', workspace: 'active' },
        { cwd: root, timeoutMs: 20 },
      );

      expect(spawned.status).toBe('failed');
      if (spawned.status === 'failed') {
        expect(spawned.reason).toContain('worker_agent_not_started');
        expect(spawned.reason).toContain('agent_banner=missing');
        expect(spawned.reason).not.toContain('prompt_delivery_unconfirmed');
      }
      const sends = calls.filter((args) => args[0] === 'terminal' && args[1] === 'send');
      expect(sends).toHaveLength(1);
      expect(sends[0]).not.toContain('--text');
      expect(sends[0]).toContain('--enter');
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function waitForFixtureText(
  path: string,
  predicate: (value: string) => boolean,
  timeoutMs = 8_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      if (predicate(value)) return value;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`fixture timeout waiting for ${path}`);
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

type RealSignalMode = 'launcher-sigterm' | 'launcher-sigint' | 'child-repeat' | 'process-group';

async function runRealSignalFixture(mode: RealSignalMode): Promise<{
  output: {
    result?: { ok?: boolean; reason?: string; observationFailures?: string[] };
    readCalls?: number;
    signalReason?: string;
  };
  stdout: string;
  stderr: string;
  timeouts: number[];
  attempts: number;
}> {
  const root = mkdtempSync(join(tmpdir(), `worker-smoke-real-signal-${mode}-`));
  const fakeOrca = join(root, 'fake-orca.cjs');
  const harness = join(root, 'signal-harness.mjs');
  const pidPath = join(root, 'orca.pid');
  const attemptsPath = join(root, 'attempts.txt');
  const timeoutsPath = join(root, 'timeouts.txt');
  const artifactDir = join(root, 'artifact');
  const runId = `real-signal-${mode}`;
  const workerSmokeRunPath = resolve('scripts/worker-smoke-run.ts');
  const adapterPath = resolve('scripts/orca-runtime/adapter.ts');
  const corePath = resolve('scripts/lib/worker-smoke-core.ts');

  executable(fakeOrca, `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.FIXTURE_SIGNAL_MODE;
const attemptsPath = process.env.FIXTURE_ATTEMPTS_PATH;
const pidPath = process.env.FIXTURE_PID_PATH;
let attempt = 0;
try { attempt = Number(fs.readFileSync(attemptsPath, 'utf8').trim()) || 0; } catch {}
attempt += 1;
fs.writeFileSync(attemptsPath, String(attempt), 'utf8');
fs.writeFileSync(pidPath, attempt + ':' + process.pid, 'utf8');
const success = () => process.stdout.write(JSON.stringify({ ok: true, result: { terminals: [] } }));
if (mode === 'launcher-sigterm' || mode === 'launcher-sigint') {
  setTimeout(success, 300);
} else if (mode === 'child-repeat' && attempt >= 3) {
  success();
} else {
  setInterval(() => {}, 1000);
}
`);

  writeFileSync(harness, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    `const { waitForRuntimeSmokeCompletion } = await import(pathToFileURL(${JSON.stringify(workerSmokeRunPath)}).href);`,
    `const { OrcaRuntimeAdapter } = await import(pathToFileURL(${JSON.stringify(adapterPath)}).href);`,
    `const core = await import(pathToFileURL(${JSON.stringify(corePath)}).href);`,
    `const root = ${JSON.stringify(root)};`,
    `const artifactDir = ${JSON.stringify(artifactDir)};`,
    `const runId = ${JSON.stringify(runId)};`,
    `const fakeOrca = ${JSON.stringify(fakeOrca)};`,
    `const timeoutsPath = ${JSON.stringify(timeoutsPath)};`,
    "core.ensureSmokeRunArtifactDir(artifactDir);",
    "let signalReason;",
    "process.once('SIGINT', () => { signalReason = 'SIGINT'; });",
    "process.once('SIGTERM', () => { signalReason = 'SIGTERM'; });",
    "const nativeAdapter = new OrcaRuntimeAdapter({ executable: fakeOrca });",
    "const worker = { runtime: 'orca', id: 'fixture-worker', generation: 'fixture-generation' };",
    "let readCalls = 0;",
    "const publishCompletion = () => {",
    "  const body = ['```worker-smoke-report', 'result: PASS', 'tracked-files-unmodified: true', 'scenarios:', '  - action: real signal observation | expected: fresh poll recovers | observed: completion recovered | outcome: pass', '```'].join('\\n');",
    "  const digest = core.computeSmokeCompletionBodyDigest(body);",
    "  fs.writeFileSync(core.smokeCompletionBodyPath(artifactDir, digest), body, { flag: 'wx' });",
    "  fs.writeFileSync(core.smokeCompletionSealPath(artifactDir, digest), JSON.stringify({ runId, bodySha256: digest }), { flag: 'wx' });",
    "};",
    "const adapter = {",
    "  readBoundedOutputAsync: async (_input, options = {}) => {",
    "    readCalls += 1;",
    "    fs.appendFileSync(timeoutsPath, String(options.timeoutMs ?? 0) + '\\n', 'utf8');",
    "    const listed = await nativeAdapter.listWorkersAsync({}, { cwd: root, timeoutMs: options.timeoutMs });",
    "    if (listed.status !== 'ok') return { status: 'failed', operation: 'read_bounded_output', reason: listed.reason };",
    "    if (process.env.FIXTURE_SIGNAL_MODE === 'child-repeat' && readCalls === 3) publishCompletion();",
    "    return { status: 'ok', value: { worker, lines: [], observationToken: { opaque: String(readCalls) }, changed: false, terminalState: 'running', source: 'stream' } };",
    "  },",
    "  readBoundedOutput: () => { throw new Error('sync observation must not be used'); },",
    "  liveness: () => ({ status: 'alive' }),",
    "};",
    "const result = await waitForRuntimeSmokeCompletion({ adapter, worker, binding: { runId, artifactDir }, scenarioCount: 1, cwd: root, startedAtMs: Date.now(), abortReason: () => signalReason, absoluteCeilingMs: 60_000, progressStallMs: 60_000 });",
    "process.stdout.write(JSON.stringify({ result, readCalls, signalReason }) + '\\n');",
  ].join('\n'), 'utf8');

  const controller = new AbortController();
  let childPid = 0;
  const childRun = runProcess({
    command: process.execPath,
    args: ['--experimental-strip-types', harness],
    cwd: process.cwd(),
    env: {
      ...process.env,
      FIXTURE_SIGNAL_MODE: mode,
      FIXTURE_ATTEMPTS_PATH: attemptsPath,
      FIXTURE_PID_PATH: pidPath,
    },
    inheritParentEnv: true,
    encoding: 'utf8',
    timeoutMs: 15_000,
    killGraceMs: 100,
    signal: controller.signal,
    onSpawn: (pid) => { childPid = pid; },
  });
  let settled: ProcessResult | undefined;

  try {
    if (!childPid) throw new Error('signal harness pid missing');
    if (mode === 'launcher-sigterm' || mode === 'launcher-sigint') {
      await waitForFixtureText(pidPath, (value) => /^1:\d+$/u.test(value));
      process.kill(childPid, mode === 'launcher-sigterm' ? 'SIGTERM' : 'SIGINT');
    } else if (mode === 'child-repeat') {
      for (const attempt of [1, 2]) {
        const observed = await waitForFixtureText(pidPath, (value) => value.startsWith(`${attempt}:`));
        const pid = Number(observed.split(':')[1]);
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        process.kill(pid, 'SIGTERM');
      }
    } else {
      if (process.platform === 'win32') throw new Error('process-group fixture requires POSIX');
      await waitForFixtureText(pidPath, (value) => /^1:\d+$/u.test(value));
      process.kill(-childPid, 'SIGTERM');
    }

    settled = await childRun;
    const stdout = settled.stdout;
    const stderr = settled.stderr;
    expect(settled.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(settled.signal).toBeNull();
    const lines = stdout.split(/\r?\n/u).filter((line) => line.trim());
    expect(lines).toHaveLength(1);
    const output = JSON.parse(lines[0]!) as {
      result?: { ok?: boolean; reason?: string; observationFailures?: string[] };
      readCalls?: number;
      signalReason?: string;
    };
    const timeouts = existsSync(timeoutsPath)
      ? readFileSync(timeoutsPath, 'utf8').split(/\r?\n/u).filter(Boolean).map(Number)
      : [];
    const attempts = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, 'utf8').trim()) : 0;
    return { output, stdout, stderr, timeouts, attempts };
  } finally {
    if (!settled) {
      controller.abort();
      await childRun;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Issue #1933 real OS signal completion observation', () => {
  it.each([
    ['launcher-sigterm', 'SIGTERM'],
    ['launcher-sigint', 'SIGINT'],
  ] as const)('surfaces launcher-only %s as operator cancellation after the bounded observation yield', async (mode, signal) => {
    const observed = await runRealSignalFixture(mode);
    expect(observed.output.result).toMatchObject({
      ok: false,
      reason: `operator_cancelled:${signal}`,
    });
    expect(observed.output.signalReason).toBe(signal);
    expect(observed.output.readCalls).toBe(1);
    expect(observed.timeouts).toEqual([30_000]);
    expect(`${observed.stdout}\n${observed.stderr}`).not.toContain('runtime_response_invalid');
  }, 20_000);

  it('records repeated child-CLI SIGTERM once per poll and continues with fresh observations', async () => {
    const observed = await runRealSignalFixture('child-repeat');
    expect(observed.output.result).toMatchObject({ ok: true });
    expect(observed.output.result?.observationFailures).toEqual([
      'runtime_cli_interrupted:SIGTERM',
      'runtime_cli_interrupted:SIGTERM',
    ]);
    expect(observed.output.signalReason).toBeUndefined();
    expect(observed.output.readCalls).toBe(3);
    expect(observed.attempts).toBe(3);
    expect(observed.timeouts).toEqual([30_000, 30_000, 30_000]);
    expect(`${observed.stdout}\n${observed.stderr}`).not.toContain('runtime_response_invalid');
  }, 20_000);

  it('lets launcher cancellation win when SIGTERM reaches the launcher and in-flight CLI process group', async () => {
    if (process.platform === 'win32') return;
    const observed = await runRealSignalFixture('process-group');
    expect(observed.output.result).toMatchObject({
      ok: false,
      reason: 'operator_cancelled:SIGTERM',
    });
    expect(observed.output.signalReason).toBe('SIGTERM');
    expect(observed.output.readCalls).toBe(1);
    expect(observed.timeouts).toEqual([30_000]);
    expect(`${observed.stdout}\n${observed.stderr}`).not.toContain('runtime_response_invalid');
  }, 20_000);
});
