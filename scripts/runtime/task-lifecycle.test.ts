import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import { executeRuntimeTaskLifecycle } from './task-lifecycle.ts';
import type { OrcaJsonResponse } from '../orca-runtime/native.ts';

function fakeOrcaTransport() {
  const handle = 'term-1248';
  const generation = 'incarnation-1248';
  const lines = ['started:cursor-agent'];
  return vi.fn((args: readonly string[]): OrcaJsonResponse => {
    const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
    switch (operation) {
      case 'worktree current':
        return {
          ok: true,
          result: { worktree: { path: process.cwd(), head: 'a'.repeat(40) } },
        };
      case 'terminal create':
        return {
          ok: true,
          result: { terminal: { handle, incarnationId: generation, title: 'issue-1248' } },
        };
      case 'terminal list':
        return {
          ok: true,
          result: {
            terminals: [{
              handle,
              incarnationId: generation,
              title: 'issue-1248',
              worktreePath: process.cwd(),
              status: 'running',
            }],
          },
        };
      case 'terminal send': {
        const textIndex = args.indexOf('--text');
        if (textIndex >= 0) lines.push(String(args[textIndex + 1] ?? ''));
        return { ok: true, result: { send: { accepted: true } } };
      }
      case 'terminal read':
        return {
          ok: true,
          result: {
            terminal: {
              handle,
              status: 'running',
              tail: [...lines],
              nextCursor: String(lines.length),
              latestCursor: String(lines.length),
            },
          },
        };
      case 'terminal wait':
        return {
          ok: true,
          result: {
            wait: { handle, condition: 'tui-idle', satisfied: true, status: 'running' },
          },
        };
      case 'terminal close':
        return { ok: true, result: { close: { handle, closed: true } } };
      default:
        return { ok: false, error: { code: 'unexpected_operation', message: operation } };
    }
  });
}

function exercise(adapter: DeterministicRuntimeAdapter | OrcaTaskRuntimeAdapter) {
  return executeRuntimeTaskLifecycle({
    adapter,
    title: 'issue-1248',
    command: 'cursor-agent',
    prompt: 'implement the issue',
  });
}

function hermeticOrcaFixture(statePath: string, expectedPath: string): string {
  return `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';

const statePath = ${JSON.stringify(statePath)};
const expectedPath = ${JSON.stringify(expectedPath)};
const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const operation = \`\${args[0] ?? ''} \${args[1] ?? ''}\`;
const emptyState = {
  exists: false,
  handle: 'term-1248-hermetic',
  generation: 'incarnation-1248-hermetic',
  title: 'issue-1248-hermetic',
  lines: ['started:cursor-agent'],
  operations: [],
};
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : emptyState;
state.operations.push(operation);

const forbiddenEnvironment = Object.keys(process.env).filter(
  (key) => key.startsWith('AO_') || key.startsWith('AGENT_ORCHESTRATOR_'),
);
const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
if (forbiddenEnvironment.length > 0 || pathEntries.length !== 1 || pathEntries[0] !== expectedPath) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: 'fixture_environment_not_hermetic',
      message: JSON.stringify({ forbiddenEnvironment, pathEntries, expectedPath }),
    },
  }));
  process.exit(0);
}

const persist = () => writeFileSync(statePath, \`\${JSON.stringify(state)}\\n\`, 'utf8');
const respond = (value) => {
  persist();
  process.stdout.write(\`\${JSON.stringify(value)}\\n\`);
};

switch (operation) {
  case 'worktree current':
    respond({
      ok: true,
      result: { worktree: { path: expectedPath, head: 'a'.repeat(40) } },
    });
    break;
  case 'terminal create': {
    const titleIndex = args.indexOf('--title');
    state.exists = true;
    state.title = titleIndex >= 0 ? String(args[titleIndex + 1] ?? state.title) : state.title;
    respond({
      ok: true,
      result: {
        terminal: {
          handle: state.handle,
          incarnationId: state.generation,
          title: state.title,
        },
      },
    });
    break;
  }
  case 'terminal list':
    respond({
      ok: true,
      result: {
        terminals: state.exists ? [{
          handle: state.handle,
          incarnationId: state.generation,
          title: state.title,
          worktreePath: expectedPath,
          status: 'running',
        }] : [],
      },
    });
    break;
  case 'terminal send': {
    const textIndex = args.indexOf('--text');
    if (textIndex >= 0) state.lines.push(String(args[textIndex + 1] ?? ''));
    respond({ ok: true, result: { send: { accepted: true } } });
    break;
  }
  case 'terminal read':
    respond({
      ok: true,
      result: {
        terminal: {
          handle: state.handle,
          status: 'running',
          tail: [...state.lines],
          nextCursor: String(state.lines.length),
          latestCursor: String(state.lines.length),
        },
      },
    });
    break;
  case 'terminal wait':
    respond({
      ok: true,
      result: {
        wait: {
          handle: state.handle,
          condition: 'tui-idle',
          satisfied: true,
          status: 'running',
        },
      },
    });
    break;
  case 'terminal close':
    state.exists = false;
    respond({ ok: true, result: { close: { handle: state.handle, closed: true } } });
    break;
  default:
    respond({
      ok: false,
      error: { code: 'unexpected_operation', message: operation },
    });
}
`;
}

describe('direct runtime-neutral task caller', () => {
  it('runs unchanged with the deterministic adapter', () => {
    const result = exercise(new DeterministicRuntimeAdapter());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.lines.join('\n')).toContain('implement the issue');
  });

  it('runs unchanged with the Orca adapter', () => {
    const runJson = fakeOrcaTransport();
    const result = exercise(new OrcaTaskRuntimeAdapter({ runJson: runJson as never }));
    expect(result).toMatchObject({ status: 'ok' });
    expect(runJson).toHaveBeenCalled();
  });

  it('acquires the claim before the first runtime side effect', () => {
    const events: string[] = [];
    const adapter = new DeterministicRuntimeAdapter();
    const spawn = adapter.spawnWorker.bind(adapter);
    vi.spyOn(adapter, 'spawnWorker').mockImplementation((...args) => {
      events.push('spawn');
      return spawn(...args);
    });
    const result = executeRuntimeTaskLifecycle({
      adapter,
      title: 'issue-1248',
      command: 'cursor-agent',
      prompt: 'implement the issue',
      acquireClaim: () => {
        events.push('claim');
        return { ok: true };
      },
    });
    expect(result.status).toBe('ok');
    expect(events.slice(0, 2)).toEqual(['claim', 'spawn']);
  });

  it('does not spawn when claim acquisition fails', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawn = vi.spyOn(adapter, 'spawnWorker');
    const result = executeRuntimeTaskLifecycle({
      adapter,
      title: 'issue-1248',
      command: 'cursor-agent',
      prompt: 'implement the issue',
      acquireClaim: () => ({ ok: false, reason: 'claim_busy' }),
    });
    expect(result).toEqual({ stage: 'claim', reason: 'claim_busy' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses stale-generation destructive cleanup before close transport', () => {
    const runJson = fakeOrcaTransport();
    const adapter = new OrcaTaskRuntimeAdapter({ runJson: runJson as never });
    const created = adapter.spawnWorker({ title: 'owned', command: 'cursor-agent' });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;

    const stale = {
      ...created.value.identity,
      generation: `${created.value.identity.generation}-stale`,
    };
    const before = runJson.mock.calls.filter((call) => call[0]?.[1] === 'close').length;
    const stopped = adapter.stopWorker(stale);
    const after = runJson.mock.calls.filter((call) => call[0]?.[1] === 'close').length;

    expect(stopped).toEqual({
      status: 'failed',
      operation: 'stop_worker',
      reason: 'worker_not_owned_by_runtime_instance',
    });
    expect(after).toBe(before);
  });

  it('runs complete Orca lifecycle with AO and pwsh unavailable', () => {
    const root = mkdtempSync(join(process.cwd(), '.issue-1248-orca-hermetic-'));
    const fixturePath = join(root, 'orca-hermetic.mjs');
    const statePath = join(root, 'state.json');
    const removedEnvironment = new Map<string, string>();
    try {
      for (const key of Object.keys(process.env)) {
        if (!key.startsWith('AO_') && !key.startsWith('AGENT_ORCHESTRATOR_')) continue;
        const value = process.env[key];
        if (value !== undefined) removedEnvironment.set(key, value);
        delete process.env[key];
      }

      writeFileSync(fixturePath, hermeticOrcaFixture(statePath, root), 'utf8');
      chmodSync(fixturePath, 0o755);
      const environment: NodeJS.ProcessEnv = { ...process.env, PATH: root };
      const subprocessRunner: typeof spawnSync = ((
        _command: string,
        args?: readonly string[],
        options?: Parameters<typeof spawnSync>[2],
      ) => spawnSync(process.execPath, [fixturePath, ...(args ?? [])], options)) as typeof spawnSync;
      const adapter = new OrcaTaskRuntimeAdapter({
        cwd: root,
        executable: fixturePath,
        env: environment,
        runner: subprocessRunner,
        timeoutMs: 5_000,
      });

      const result = executeRuntimeTaskLifecycle({
        adapter,
        title: 'issue-1248-hermetic',
        command: 'cursor-agent',
        prompt: 'implement the issue',
        observationWindowMs: 1_000,
        options: { cwd: root, timeoutMs: 5_000 },
      });

      expect(result).toMatchObject({ status: 'ok' });
      if (result.status !== 'ok') return;
      expect(result.lines).toContain('implement the issue');
      expect(result.liveness).toBe('idle');

      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        exists: boolean;
        operations: string[];
      };
      expect(state.exists).toBe(false);
      expect(state.operations).toEqual(expect.arrayContaining([
        'terminal create',
        'terminal send',
        'terminal read',
        'terminal wait',
        'terminal close',
      ]));
      expect(state.operations.filter((operation) => operation === 'terminal send')).toHaveLength(1);
      expect(state.operations.filter((operation) => operation === 'terminal close')).toHaveLength(1);
    } finally {
      for (const [key, value] of removedEnvironment) process.env[key] = value;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
