import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OrcaTaskRuntimeAdapter } from '../orca-runtime/task-adapter.ts';
import { runOrcaJson, type OrcaJsonResponse } from '../orca-runtime/native.ts';
import { drainRuntimeInbox, type RuntimeInboxCheckResult } from './contracts.ts';
import { DeterministicRuntimeAdapter } from './test-adapter.ts';
import { executeRuntimeTaskLifecycle } from './task-lifecycle.ts';

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
        const text = textIndex >= 0 ? String(args[textIndex + 1] ?? '') : '';
        if (textIndex >= 0) lines.push(text);
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
    acquireClaim: () => ({ ok: true }),
  });
}

function hermeticOrcaFixture(
  statePath: string,
  capturePath: string,
  expectedPath: string,
): string {
  return `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';

const statePath = ${JSON.stringify(statePath)};
const capturePath = ${JSON.stringify(capturePath)};
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
writeFileSync(capturePath, \`\${JSON.stringify({
  args,
  operation,
  forbiddenEnvironment,
  pathEntries,
  expectedPath,
})}\\n\`, 'utf8');
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
    const text = textIndex >= 0 ? String(args[textIndex + 1] ?? '') : '';
    if (textIndex >= 0) state.lines.push(text);
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

  it('fails closed at the Orca dispatch boundary without a production submit witness', () => {
    const runJson = fakeOrcaTransport();
    const result = exercise(new OrcaTaskRuntimeAdapter({ runJson: runJson as never }));
    expect(result).toMatchObject({
      stage: 'dispatch',
      result: { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' },
    });
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'send')).toHaveLength(1);
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'read')).toHaveLength(0);
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'wait')).toHaveLength(0);
    expect(runJson.mock.calls.filter((call) => call[0]?.[1] === 'close')).toHaveLength(0);
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

  it('fails closed before runtime work when claim authority is missing', () => {
    const adapter = new DeterministicRuntimeAdapter();
    const spawn = vi.spyOn(adapter, 'spawnWorker');
    const result = executeRuntimeTaskLifecycle({
      adapter,
      title: 'issue-1248',
      command: 'cursor-agent',
      prompt: 'implement the issue',
    } as unknown as Parameters<typeof executeRuntimeTaskLifecycle>[0]);
    expect(result).toEqual({ stage: 'claim', reason: 'claim_authority_missing' });
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

  it('keeps the hermetic Orca worker open after an uncredentialed dispatch', () => {
    const root = mkdtempSync(join(process.cwd(), '.issue-1248-orca-hermetic-'));
    const fixturePath = join(root, 'orca-hermetic.mjs');
    const statePath = join(root, 'state.json');
    const capturePath = join(root, 'capture.json');
    const nativeCalls: Array<{
      readonly args: readonly string[];
      readonly response: OrcaJsonResponse;
    }> = [];
    try {
      writeFileSync(
        fixturePath,
        hermeticOrcaFixture(statePath, capturePath, root),
        'utf8',
      );
      chmodSync(fixturePath, 0o755);
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('AO_') && !key.startsWith('AGENT_ORCHESTRATOR_'),
        ),
      ) as NodeJS.ProcessEnv;
      environment.PATH = root;
      environment.OPK_VITEST_HARNESS = '';
      environment.OPK_VITEST_SKIP_CHILD_ENV_MERGE = '1';
      const observingRunJson: typeof runOrcaJson = <T>(args: readonly string[], options = {}) => {
        const response = runOrcaJson<T>(args, { ...options, inheritParentEnv: false });
        nativeCalls.push({ args: [...args], response: response as OrcaJsonResponse });
        return response;
      };
      const adapter = new OrcaTaskRuntimeAdapter({
        cwd: root,
        executable: fixturePath,
        env: environment,
        runJson: observingRunJson,
        timeoutMs: 5_000,
      });

      const result = executeRuntimeTaskLifecycle({
        adapter,
        title: 'issue-1248-hermetic',
        command: 'cursor-agent',
        prompt: 'implement the issue',
        observationWindowMs: 1_000,
        options: { cwd: root, timeoutMs: 5_000 },
        acquireClaim: () => ({ ok: true }),
      });

      expect(result).toMatchObject({
        stage: 'dispatch',
        result: { status: 'dispatch_unknown', reason: 'submit_witness_unavailable' },
      });

      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        exists: boolean;
        operations: string[];
      };
      expect(state.exists).toBe(true);
      expect(state.operations).toContain('terminal create');
      expect(state.operations.filter((operation) => operation === 'terminal send')).toHaveLength(1);
      expect(state.operations.filter((operation) => operation === 'terminal read')).toHaveLength(0);
      expect(state.operations.filter((operation) => operation === 'terminal wait')).toHaveLength(0);
      expect(state.operations.filter((operation) => operation === 'terminal close')).toHaveLength(0);

      const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
        operation: string;
        forbiddenEnvironment: string[];
        pathEntries: string[];
        expectedPath: string;
      };
      expect(capture).toMatchObject({
        operation: 'terminal send',
        forbiddenEnvironment: [],
        pathEntries: [root],
        expectedPath: root,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bounded runtime inbox drain', () => {
  it('processes all messages before exactly one ack per delivery and loops to authoritative empty', async () => {
    const runId = 'run-inbox-1';
    const calls: Array<{ runId: string; ackDeliveryId?: string }> = [];
    const processed: string[] = [];
    const checkInbox = vi.fn((input: { readonly runId: string; readonly ackDeliveryId?: string }): RuntimeInboxCheckResult => {
      calls.push({ ...input });
      if (!input.ackDeliveryId) {
        return {
          status: 'delivery',
          delivery: {
            runId,
            deliveryId: 'delivery-1',
            messages: [{ type: 'a' }, { type: 'b' }],
          },
        };
      }
      if (input.ackDeliveryId === 'delivery-1') {
        return {
          status: 'delivery',
          delivery: {
            runId,
            deliveryId: 'delivery-2',
            messages: [{ type: 'c' }],
          },
        };
      }
      if (input.ackDeliveryId === 'delivery-2') return { status: 'empty', runId };
      return { status: 'failed', reason: 'unexpected_ack' };
    });

    const result = await drainRuntimeInbox(
      { checkInbox },
      {
        runId,
        processMessage: (message) => {
          processed.push(message.type);
        },
      },
      { timeoutMs: 1_000 },
    );

    expect(result).toEqual({ status: 'empty', runId });
    expect(processed).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual([
      { runId },
      { runId, ackDeliveryId: 'delivery-1' },
      { runId, ackDeliveryId: 'delivery-2' },
    ]);
  });

  it('does not ack a delivery when any interior message fails processing', async () => {
    const runId = 'run-inbox-2';
    const checkInbox = vi.fn((_input: { readonly runId: string; readonly ackDeliveryId?: string }): RuntimeInboxCheckResult => ({
      status: 'delivery',
      delivery: {
        runId,
        deliveryId: 'delivery-fail',
        messages: [{ type: 'first' }, { type: 'explode' }, { type: 'never' }],
      },
    }));
    const processed: string[] = [];

    const result = await drainRuntimeInbox(
      { checkInbox },
      {
        runId,
        processMessage: (message) => {
          processed.push(message.type);
          if (message.type === 'explode') throw new Error('surface_failed');
        },
      },
      { timeoutMs: 1_000 },
    );

    expect(result).toEqual({
      status: 'blocked',
      runId,
      reason: 'runtime_inbox_message_processing_failed:surface_failed',
      pendingDeliveryId: 'delivery-fail',
    });
    expect(processed).toEqual(['first', 'explode']);
    expect(checkInbox).toHaveBeenCalledTimes(1);
    expect(checkInbox.mock.calls[0]?.[0]).toEqual({ runId });
  });

  it('returns boundary_busy and leaves the current delivery unacked when arrivals exhaust the caller budget', async () => {
    const runId = 'run-inbox-3';
    let nowMs = 0;
    const calls: Array<{ runId: string; ackDeliveryId?: string }> = [];
    const checkInbox = vi.fn((input: { readonly runId: string; readonly ackDeliveryId?: string }): RuntimeInboxCheckResult => {
      calls.push({ ...input });
      return {
        status: 'delivery',
        delivery: {
          runId,
          deliveryId: input.ackDeliveryId ? 'delivery-2' : 'delivery-1',
          messages: [{ type: input.ackDeliveryId ? 'second' : 'first' }],
        },
      };
    });

    const result = await drainRuntimeInbox(
      { checkInbox },
      {
        runId,
        now: () => nowMs,
        processMessage: () => {
          nowMs += 6;
        },
      },
      { timeoutMs: 10 },
    );

    expect(result).toEqual({
      status: 'boundary_busy',
      runId,
      reason: 'runtime_inbox_budget_exhausted',
      pendingDeliveryId: 'delivery-2',
    });
    expect(calls).toEqual([
      { runId },
      { runId, ackDeliveryId: 'delivery-1' },
    ]);
  });

  it('fails closed without retrying an ack whose combined ack/check result is unknown', async () => {
    const runId = 'run-inbox-4';
    const calls: Array<{ runId: string; ackDeliveryId?: string }> = [];
    const checkInbox = vi.fn((input: { readonly runId: string; readonly ackDeliveryId?: string }): RuntimeInboxCheckResult => {
      calls.push({ ...input });
      if (!input.ackDeliveryId) {
        return {
          status: 'delivery',
          delivery: { runId, deliveryId: 'delivery-unknown', messages: [{ type: 'one' }] },
        };
      }
      return { status: 'unknown', reason: 'ack_result_unknown' };
    });

    const result = await drainRuntimeInbox(
      { checkInbox },
      { runId, processMessage: () => undefined },
      { timeoutMs: 1_000 },
    );

    expect(result).toEqual({
      status: 'blocked',
      runId,
      reason: 'runtime_inbox_unknown:ack_result_unknown',
      pendingDeliveryId: 'delivery-unknown',
    });
    expect(calls).toEqual([
      { runId },
      { runId, ackDeliveryId: 'delivery-unknown' },
    ]);
  });
});
