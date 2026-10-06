import { describe, expect, it, vi } from 'vitest';
import { OrcaRuntimeAdapter } from './orca-runtime/adapter.ts';
import type { OrcaJsonResponse, OrcaTerminalSummary } from './orca-runtime/native.ts';
import type {
  RuntimeAdapter,
  RuntimeComposerControl,
  RuntimeWorker,
  RuntimeWorkerIdentity,
} from './runtime/contracts.ts';
import type { ProcessResult, RunProcessSyncOptions } from './kernel/subprocess.ts';
import {
  runUnitWatcherWake,
  type UnitWatcherWakeConfig,
  type WatcherCommandRunner,
} from './unit-watcher-wake.ts';

const identity: RuntimeWorkerIdentity = {
  runtime: 'orca',
  id: 'term_unit',
  generation: 'inc_unit_1',
};

const worker: RuntimeWorker = {
  identity,
  workspacePath: '/tmp/unit',
  title: 'opk-t2-unit',
  provenance: 'external',
};

const config: UnitWatcherWakeConfig = {
  watchTerminal: 'term_job',
  targetTerminal: identity.id,
  wakeText: 'WATCHER: term_job exited; resume and inspect its result',
  waitTimeoutMs: 1_000,
};

function processResult(
  stdout: string,
  options: { readonly status?: number; readonly stderr?: string } = {},
): ProcessResult {
  const status = options.status ?? 0;
  return {
    outcome: 'exit',
    ok: status === 0,
    exitCode: status,
    signal: null,
    stdout,
    stderr: options.stderr ?? '',
    timedOut: false,
    cancelled: false,
  };
}

function runner(
  queued: readonly ProcessResult[],
  calls: RunProcessSyncOptions[],
): WatcherCommandRunner {
  let index = 0;
  return (options) => {
    calls.push(options);
    const next = queued[index];
    index += 1;
    if (!next) throw new Error('unexpected command invocation');
    return next;
  };
}

const waitConfirmed = processResult(JSON.stringify({
  ok: true,
  result: {
    wait: {
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 0,
    },
  },
}) + '\n');

function boundControl(): RuntimeComposerControl {
  return {
    kind: 'opencode-http',
    dispatch: () => ({
      status: 'dispatched',
      witness: { operation: 'submit', accepted: true, source: 'runtime-response' },
    }),
  };
}

function adapterWith(options: {
  readonly findWorkerById?: RuntimeAdapter['findWorkerById'];
  readonly findWorker?: RuntimeAdapter['findWorker'];
  readonly observeComposerFamily?: NonNullable<RuntimeAdapter['observeComposerFamily']>;
  readonly composerControl?: NonNullable<RuntimeAdapter['composerControl']>;
  readonly dispatchInput?: RuntimeAdapter['dispatchInput'];
} = {}): RuntimeAdapter {
  return {
    id: 'orca',
    findWorkerById: options.findWorkerById ?? (() => ({ status: 'ok', value: worker })),
    findWorker: options.findWorker ?? (() => ({ status: 'ok', value: worker })),
    observeComposerFamily: options.observeComposerFamily ?? (() => ({
      status: 'known',
      family: 'opencode',
      command: 'opencode --hostname 127.0.0.1 --port 4096',
      provenance: 'orca-terminal-show',
    })),
    composerControl: options.composerControl ?? (() => boundControl()),
    dispatchInput: options.dispatchInput ?? (() => ({
      status: 'dispatched',
      witness: { operation: 'submit', accepted: true, source: 'runtime-response' },
    })),
  } as unknown as RuntimeAdapter;
}

describe('unit watcher wake', () => {
  it('snapshots and revalidates one exact target identity, then confirms one adapter dispatch', async () => {
    const calls: RunProcessSyncOptions[] = [];
    const dispatchCalls: Array<{
      readonly input: Parameters<RuntimeAdapter['dispatchInput']>[0];
      readonly options: Parameters<RuntimeAdapter['dispatchInput']>[1];
    }> = [];
    const dispatchInput: RuntimeAdapter['dispatchInput'] = (input, options) => {
      dispatchCalls.push({ input, options });
      return {
        status: 'dispatched',
        witness: { operation: 'submit', accepted: true, source: 'runtime-response' },
      };
    };
    const output = await runUnitWatcherWake(config, {
      executable: 'orca',
      run: runner([waitConfirmed], calls),
      adapter: adapterWith({ dispatchInput }),
    });

    expect(output).toEqual({
      exitCode: 0,
      stdout: 'watcher wake submission confirmed: runtime=orca target=term_unit generation=inc_unit_1 dispatch=dispatched\n',
      stderr: '',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'terminal', 'wait',
      '--terminal', 'term_job',
      '--for', 'exit',
      '--timeout-ms', '1000',
      '--json',
    ]);
    expect(dispatchCalls).toEqual([{
      input: { worker: identity, text: config.wakeText },
      options: { timeoutMs: 10_000 },
    }]);
  });

  it('keeps raw text-plus-enter accepted:true as dispatch-unknown and never retries', async () => {
    const terminal: OrcaTerminalSummary = {
      handle: identity.id,
      incarnationId: identity.generation,
      worktreePath: worker.workspacePath,
      title: 'plain-shell',
      command: 'bash',
    };
    const runJson = vi.fn((args: readonly string[]): OrcaJsonResponse => {
      const operation = `${args[0] ?? ''} ${args[1] ?? ''}`;
      if (operation === 'terminal show') return { ok: true, result: { terminal } };
      if (operation === 'terminal list') {
        return { ok: true, result: { terminals: [terminal] } };
      }
      if (operation === 'terminal send') {
        return { ok: true, result: { send: { accepted: true } } };
      }
      return {
        ok: false,
        outcomeCategory: 'supported_operation_failure',
        error: { code: 'unexpected_operation', message: operation },
      };
    });
    const output = await runUnitWatcherWake(config, {
      executable: 'orca',
      run: runner([waitConfirmed], []),
      adapter: new OrcaRuntimeAdapter({ runJson: runJson as never }),
    });

    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain('delivery-unknown: submit_witness_unavailable');
    expect(output.stderr).toContain(
      '{"status":"dispatch_unknown","reason":"submit_witness_unavailable"}',
    );
    const sends = runJson.mock.calls
      .filter((call) => call[0]?.[0] === 'terminal' && call[0]?.[1] === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[0]).toEqual([
      'terminal', 'send',
      '--terminal', identity.id,
      '--text', config.wakeText,
      '--enter',
    ]);
  });

  it('refuses an unbound OpenCode target before waiting or dispatching', async () => {
    const waitCalls: RunProcessSyncOptions[] = [];
    const dispatchCalls: unknown[] = [];
    const dispatchInput: RuntimeAdapter['dispatchInput'] = (input) => {
      dispatchCalls.push(input);
      return { status: 'dispatched' };
    };
    const output = await runUnitWatcherWake(config, {
      executable: 'orca',
      run: runner([], waitCalls),
      adapter: adapterWith({
        composerControl: () => undefined,
        dispatchInput,
      }),
    });

    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain('OpenCode target control is unbound');
    expect(output.stderr).toContain('opencode_control_unbound');
    expect(waitCalls).toEqual([]);
    expect(dispatchCalls).toEqual([]);
  });

  it('fails closed when the captured target generation is stale or reused after the wait', async () => {
    let findWorkerCalls = 0;
    const findWorker: RuntimeAdapter['findWorker'] = () => {
      findWorkerCalls += 1;
      return findWorkerCalls === 1
        ? { status: 'ok', value: worker }
        : { status: 'ok', value: null };
    };
    const dispatchCalls: unknown[] = [];
    const dispatchInput: RuntimeAdapter['dispatchInput'] = (input) => {
      dispatchCalls.push(input);
      return { status: 'dispatched' };
    };
    const output = await runUnitWatcherWake(config, {
      executable: 'orca',
      run: runner([waitConfirmed], []),
      adapter: adapterWith({ findWorker, dispatchInput }),
    });

    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain('target runtime identity is stale or reused');
    expect(output.stderr).toContain('{"status":"ok","value":null}');
    expect(findWorkerCalls).toBe(2);
    expect(dispatchCalls).toEqual([]);
  });

  it('fails loudly when the target cannot be resolved to an exact runtime identity', async () => {
    const waitCalls: RunProcessSyncOptions[] = [];
    const dispatchCalls: unknown[] = [];
    const dispatchInput: RuntimeAdapter['dispatchInput'] = (input) => {
      dispatchCalls.push(input);
      return { status: 'dispatched' };
    };
    const output = await runUnitWatcherWake(config, {
      executable: 'orca',
      run: runner([], waitCalls),
      adapter: adapterWith({
        findWorkerById: () => ({ status: 'ok', value: null }),
        dispatchInput,
      }),
    });

    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain('target runtime identity is missing');
    expect(output.stderr).toContain('{"status":"ok","value":null}');
    expect(waitCalls).toEqual([]);
    expect(dispatchCalls).toEqual([]);
  });
});
