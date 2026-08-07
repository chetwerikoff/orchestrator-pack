import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcessSync, type ProcessResult } from './kernel/subprocess.ts';
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

describe('Issue #1359 real worker-smoke entrypoint', () => {
  it('submits a pasted prompt, confirms first-ordinal evidence, and closes the frozen owned handle', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-entrypoint-1359-'));
    const bin = join(root, 'bin');
    const callsPath = join(root, 'orca-calls.jsonl');
    const promptPath = join(root, 'pasted-prompt.txt');
    const issueBodyPath = join(root, 'issue.md');
    mkdirSync(bin, { recursive: true });

    try {
      requireSuccess('git', ['init', '--quiet', '--initial-branch=main'], root);
      requireSuccess('git', ['config', 'user.email', 'worker-smoke@example.invalid'], root);
      requireSuccess('git', ['config', 'user.name', 'Worker Smoke Fixture'], root);
      writeFileSync(join(root, '.gitignore'), '*\n!.gitignore\n', 'utf8');
      requireSuccess('git', ['add', '.gitignore'], root);
      requireSuccess('git', ['commit', '--quiet', '-m', 'fixture'], root);
      const head = String(requireSuccess('git', ['rev-parse', 'HEAD'], root).stdout).trim();

      writeFileSync(issueBodyPath, [
        '```behavior-kind',
        'action-producing',
        '```',
        '',
        '```smoke-test-plan',
        'scenarios:',
        '  - action: execute real entrypoint | expected: sealed scenario report',
        '```',
        '',
      ].join('\n'), 'utf8');

      const fakeOrca = join(bin, 'orca');
      writeFileSync(fakeOrca, `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2).filter((value) => value !== '--json');
appendFileSync(process.env.FAKE_ORCA_CALLS, JSON.stringify(args) + '\\n', 'utf8');
const root = process.env.FAKE_ORCA_ROOT;
const head = process.env.FAKE_ORCA_HEAD;
const terminal = {
  handle: 'terminal-1359',
  title: 'smoke-1359-renamed',
  incarnationId: 'stable-generation-1359',
  worktreePath: root,
  status: 'running',
};
const ok = (result) => process.stdout.write(JSON.stringify({ ok: true, result }));
const fail = (code, message) => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }));
  process.exitCode = 1;
};

if (args[0] === 'worktree' && args[1] === 'current') {
  ok({ worktree: { path: root, head, linkedIssue: 1359 } });
} else if (args[0] === 'terminal' && args[1] === 'create') {
  ok({ terminal: { ...terminal, title: 'smoke-1359', incarnationId: 'create-generation-1359' } });
} else if (args[0] === 'terminal' && args[1] === 'show') {
  ok({ terminal });
} else if (args[0] === 'terminal' && args[1] === 'list') {
  ok({ terminals: [] });
} else if (args[0] === 'terminal' && args[1] === 'send' && args.includes('--text')) {
  const text = args[args.indexOf('--text') + 1] || '';
  writeFileSync(process.env.FAKE_ORCA_PROMPT, text, 'utf8');
  ok({ sent: true });
} else if (args[0] === 'terminal' && args[1] === 'send' && args.includes('--enter')) {
  const text = readFileSync(process.env.FAKE_ORCA_PROMPT, 'utf8');
  const runId = /run-id:\\s*([^\\r\\n]+)/u.exec(text)?.[1]?.trim();
  const artifactDir = /artifact-dir:\\s*([^\\r\\n]+)/u.exec(text)?.[1]?.trim();
  const progressPath = /Progress file:\\s*([^\\r\\n]+)/u.exec(text)?.[1]?.trim();
  if (!runId || !artifactDir || !progressPath) {
    fail('fixture_binding_missing', 'prompt binding not found');
  } else {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, 'delivery.sealed.json'), JSON.stringify({ runId }), 'utf8');
    writeFileSync(progressPath, [
      JSON.stringify({ runId, scenarioOrdinal: 1, phase: 'started' }),
      JSON.stringify({ runId, scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' }),
      '',
    ].join('\\n'), 'utf8');
    const fence = String.fromCharCode(96).repeat(3);
    const body = [
      fence + 'worker-smoke-report',
      'result: PASS',
      'tracked-files-unmodified: true',
      'scenarios:',
      '  - action: execute real entrypoint | expected: sealed scenario report | observed: pasted prompt submitted and child evidence sealed | outcome: pass',
      fence,
    ].join('\\n');
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    writeFileSync(path.join(artifactDir, 'completion-' + digest + '.body'), body, { flag: 'wx' });
    writeFileSync(
      path.join(artifactDir, 'completion-' + digest + '.sealed.json'),
      JSON.stringify({ runId, bodySha256: digest }),
      { flag: 'wx' },
    );
    ok({ sent: true });
  }
} else if (args[0] === 'terminal' && args[1] === 'close') {
  ok({ closed: true });
} else if (args[0] === 'terminal' && args[1] === 'read') {
  ok({ terminal: { handle: terminal.handle, status: 'running', tail: [], nextCursor: '1' } });
} else if (args[0] === 'terminal' && args[1] === 'wait') {
  ok({ wait: { handle: terminal.handle, condition: 'tui-idle', satisfied: true, status: 'running' } });
} else {
  fail('unexpected_fixture_operation', args.join(' '));
}
`, 'utf8');
      chmodSync(fakeOrca, 0o755);

      const wrapper = resolve('scripts/worker-smoke-run');
      const result = run(wrapper, [
        'run',
        '--issue', '1359',
        '--pr', '1365',
        '--head-sha', head,
        '--issue-body-file', issueBodyPath,
        '--repo-root', root,
        '--cwd', root,
        '--dry-run',
        '--json',
      ], {
        cwd: root,
        env: {
          ORCA_CLI_COMMAND: fakeOrca,
          FAKE_ORCA_CALLS: callsPath,
          FAKE_ORCA_ROOT: root,
          FAKE_ORCA_HEAD: head,
          FAKE_ORCA_PROMPT: promptPath,
          WORKER_SMOKE_SUBMIT_CONFIRMATION_TIMEOUT_MS: '20',
        },
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.signal).toBeNull();
      const lines = String(result.stdout).split(/\r?\n/u).filter((line) => line.trim());
      expect(lines).toHaveLength(1);
      const emitted = JSON.parse(lines[0]!) as {
        ok?: boolean;
        report?: {
          result?: string;
          terminalCleanup?: string;
          scenarios?: Array<{ action?: string; outcome?: string }>;
        };
        lifecycleCleanup?: { clean?: boolean; closeOutcome?: string };
      };
      expect(emitted).toMatchObject({
        ok: true,
        report: {
          result: 'PASS',
          terminalCleanup: 'closed_owned_handle',
          scenarios: [{ action: 'execute real entrypoint', outcome: 'pass' }],
        },
        lifecycleCleanup: {
          clean: true,
          closeOutcome: 'closed_owned_handle',
        },
      });

      const prompt = readFileSync(promptPath, 'utf8');
      const runId = prompt.match(/^run-id:\s*(\S+)\s*$/mu)?.[1]?.trim();
      const progressPath = prompt.match(/^- Progress file:\s*(.+?)\s*$/mu)?.[1]?.trim();
      expect(runId).toBeTruthy();
      expect(progressPath).toBeTruthy();
      expect(prompt).toContain('Canonical progress serialization (mandatory):');
      expect(prompt).toContain('JSON.stringify(event)');
      const progressLines = readFileSync(progressPath!, 'utf8')
        .split(/\r?\n/u)
        .filter((line) => line.trim());
      expect(progressLines).toHaveLength(2);
      const firstProgress = JSON.parse(progressLines[0]!) as Record<string, unknown>;
      expect(firstProgress).toEqual({ runId, scenarioOrdinal: 1, phase: 'started' });
      expect(Object.keys(firstProgress)).toEqual(['runId', 'scenarioOrdinal', 'phase']);
      expect(prompt).toContain(
        `The first non-empty progress line must parse exactly as: ${JSON.stringify(firstProgress)}`,
      );

      const calls = readFileSync(callsPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as string[]);
      const operation = (args: readonly string[]): string => `${args[0] ?? ''} ${args[1] ?? ''}`;
      const operations = calls.map(operation);
      const createIndex = operations.indexOf('terminal create');
      const showIndexes = operations
        .map((value, index) => value === 'terminal show' ? index : -1)
        .filter((index) => index >= 0);
      const sendIndexes = operations
        .map((value, index) => value === 'terminal send' ? index : -1)
        .filter((index) => index >= 0);
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(showIndexes.length).toBeGreaterThanOrEqual(3);
      expect(sendIndexes).toHaveLength(2);
      expect(calls[sendIndexes[0]!] ?? []).toContain('--text');
      expect(calls[sendIndexes[1]!] ?? []).not.toContain('--text');
      expect(calls[sendIndexes[1]!] ?? []).toContain('--enter');
      expect(operations.filter((value) => value === 'terminal close')).toHaveLength(1);
      expect(operations.filter((value) => value === 'terminal list')).toHaveLength(0);
      expect(createHash('sha256').update(readFileSync(wrapper), 'utf8').digest('hex')).toMatch(/^[0-9a-f]{64}$/u);
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
    let showCalls = 0;
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[0] === 'terminal' && args[1] === 'create') return ok({ terminal: owned } as T);
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: '1'.repeat(40) } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') {
        showCalls += 1;
        if (showCalls === 1) return ok({ terminal: owned } as T);
        return {
          ok: false,
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'terminal_not_found', message: 'terminal is no longer alive' },
        };
      }
      if (args[0] === 'terminal' && args[1] === 'list') return ok({ terminals: [foreign] } as T);
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };

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
      expect(outcome).toContain('inventory_error=find_worker_by_id:failed:runtime_operation_failed');
      expect(outcome).toContain('presence=unproven');
      expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'list')).toHaveLength(0);
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'close')).toBe(false);
      expect(calls.some((args) => args.includes(foreign.handle!))).toBe(false);
    } finally {
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
    let showCalls = 0;
    const calls: string[][] = [];
    const runJson = <T>(args: readonly string[]): OrcaJsonResponse<T> => {
      calls.push([...args]);
      if (args[0] === 'terminal' && args[1] === 'create') return ok({ terminal: owned } as T);
      if (args[0] === 'worktree' && args[1] === 'current') {
        return ok({ worktree: { path: root, head: '1'.repeat(40) } } as T);
      }
      if (args[0] === 'terminal' && args[1] === 'show') {
        showCalls += 1;
        if (showCalls === 1) return ok({ terminal: owned } as T);
        return {
          ok: false,
          outcomeCategory: 'supported_operation_failure',
          error: { code: 'inventory_unavailable', message: 'runtime inventory unavailable' },
        };
      }
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };

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
      expect(outcome).toContain('inventory_error=find_worker_by_id:failed:runtime_operation_failed');
      expect(outcome).toContain('presence=unproven');
      expect(calls.filter((args) => args[0] === 'terminal' && args[1] === 'show')).toHaveLength(2);
      expect(calls.some((args) => args[0] === 'terminal' && args[1] === 'close')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses actionably after one submit-only retry when delivery remains unconfirmable', () => {
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
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };
    let clock = 0;
    const restore = installStableWorkerSmokeSpawnPatch({
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

      expect(dispatched.status).toBe('send_failed');
      if (dispatched.status === 'send_failed') {
        expect(dispatched.reason).toContain('prompt_submission_unconfirmed');
        expect(dispatched.reason).toContain('submit_attempts=2');
        expect(dispatched.reason).toContain('initial_submit=dispatched');
        expect(dispatched.reason).toContain('retry_submit=dispatched');
        expect(dispatched.reason).toContain('delivery_evidence=');
        expect(dispatched.reason).toContain('resolution=');
      }
      const sends = calls.filter((args) => args[0] === 'terminal' && args[1] === 'send');
      expect(sends).toHaveLength(2);
      expect(sends[0]).toContain('--text');
      expect(sends[1]).not.toContain('--text');
      expect(sends[1]).toContain('--enter');
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
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };
    const restore = installStableWorkerSmokeSpawnPatch({
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
      expect(dispatched.status).toBe('dispatched');
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
      return {
        ok: false,
        error: { code: 'unexpected_test_operation', message: args.join(' ') },
      };
    };
    const restore = installStableWorkerSmokeSpawnPatch({
      probe: () => {
        probeCalls += 1;
        return ok({});
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
      expect(probeCalls).toBe(1);
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
});
