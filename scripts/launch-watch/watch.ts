import '../toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { emitResult } from '../lib/launch-watch/emission.ts';
import { processEvidence, runOwnedProcess, type ProcessRunner } from '../lib/launch-watch/process.ts';
import type { ProcessResult } from '../kernel/subprocess.ts';
import { selectRuntimeAdapter } from '../runtime/registry.ts';
import type { RuntimeAdapter } from '../runtime/contracts.ts';
import {
  CLEANUP_RESERVE_MS,
  cleanupOverride,
  invalidWatchResult,
  parseWatchRequest,
  watchResult,
  type WatchRequest,
  type WatchResult,
} from '../lib/launch-watch/contract.ts';

type Runner = ProcessRunner;

export type WatchCleanupResult = {
  readonly completed: boolean;
  readonly evidence: Record<string, unknown>;
};

export type WatchCleanup = (options: { readonly timeoutMs: number }) => Promise<WatchCleanupResult>;

export type WatchDependencies = {
  readonly run?: Runner;
  readonly runtime?: RuntimeAdapter;
  readonly cleanupHelpers?: WatchCleanup;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly root?: string;
};

function object(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function deadlineResult(
  request: WatchRequest,
  operation: 'github-pr-read' | 'orca-terminal-read',
  reasonCode: 'github_read_deadline' | 'orca_read_deadline',
  extra: Record<string, unknown> = {},
): WatchResult {
  return watchResult('deadline-exceeded', {
    operation, sourceId: request.sourceId, predicateId: request.predicateId, reasonCode,
    deadlineMs: request.deadlineMs, evidence: extra, remediation: 'wait-and-retry', owner: 'operator',
  });
}

async function finalizeWatchFailure(
  request: WatchRequest,
  primary: WatchResult,
  startedAt: number,
  now: () => number,
  cleanupHelpers: WatchCleanup,
): Promise<WatchResult> {
  const cleanupRemaining = Math.min(
    CLEANUP_RESERVE_MS,
    Math.floor(startedAt + request.deadlineMs - 1_000 - now()),
  );
  let cleanup: WatchCleanupResult;
  if (cleanupRemaining <= 0) {
    cleanup = { completed: false, evidence: { cleanupBudgetExpired: true, cleanupRemainingMs: cleanupRemaining } };
  } else {
    try {
      cleanup = await cleanupHelpers({ timeoutMs: cleanupRemaining });
    } catch (error) {
      cleanup = { completed: false, evidence: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
  const cleanupTimedOut = cleanup.evidence.cleanupBudgetExpired === true
    || cleanup.evidence.processOutcome === 'timeout'
    || cleanup.evidence.timedOut === true;
  const cleanupErrorCode = cleanupTimedOut ? 'cleanup_timeout' : 'cleanup_termination_failed';
  const resources = {
    terminalHandle: null,
    helperProcessGroupId: typeof cleanup.evidence.helperProcessGroupId === 'string'
      ? cleanup.evidence.helperProcessGroupId
      : null,
    redirectedSinkId: typeof cleanup.evidence.redirectedSinkId === 'string'
      ? cleanup.evidence.redirectedSinkId
      : null,
  };
  return cleanupOverride(
    primary,
    cleanup.completed ? 'completed' : 'failed',
    resources,
    cleanup.completed ? null : cleanupErrorCode,
  ) as WatchResult;
}

async function invoke(
  run: Runner,
  command: string,
  args: readonly string[],
  cwd: string,
  now: () => number,
  workDeadline: number,
): Promise<{ readonly result?: ProcessResult; readonly expired: boolean }> {
  const remaining = Math.floor(workDeadline - now());
  if (remaining <= 0) return { expired: true };
  try {
    return { result: await run(command, args, { cwd, timeoutMs: remaining, input: '' }), expired: false };
  } catch (error) {
    return {
      result: {
        outcome: 'spawn-failure', ok: false, exitCode: null, signal: null, stdout: '', stderr: '',
        timedOut: false, cancelled: false, error: error instanceof Error ? error.message : String(error),
      },
      expired: false,
    };
  }
}

export async function executeWatch(raw: Uint8Array, dependencies: WatchDependencies = {}): Promise<WatchResult> {
  const parsed = parseWatchRequest(raw);
  if (!parsed.ok) return invalidWatchResult(parsed.code, parsed.deadlineMs);
  return executeWatchRequest(parsed.request, dependencies);
}

async function observeOrcaThroughRuntime(
  request: WatchRequest,
  runtime: RuntimeAdapter,
  root: string,
  now: () => number,
  workDeadline: number,
): Promise<WatchResult> {
  const remaining = Math.floor(workDeadline - now());
  if (remaining <= 0) return deadlineResult(request, 'orca-terminal-read', 'orca_read_deadline');
  const listed = runtime.listWorkers({ workspace: root }, { cwd: root, timeoutMs: remaining });
  if (listed.status !== 'ok') {
    if (listed.reason === 'runtime_timeout') {
      return deadlineResult(request, 'orca-terminal-read', 'orca_read_deadline');
    }
    return watchResult('source-unavailable', {
      operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
      reasonCode: `runtime_${listed.status}`, deadlineMs: request.deadlineMs,
      evidence: { reason: listed.reason, runtime: runtime.id }, remediation: 'inspect-source',
    });
  }
  const worker = listed.value.find((candidate) => candidate.identity.id === request.terminalHandle);
  if (!worker) {
    return watchResult('source-unavailable', {
      operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
      reasonCode: 'runtime_worker_not_found', deadlineMs: request.deadlineMs,
      evidence: { runtime: runtime.id, workspace: root }, remediation: 'inspect-source',
    });
  }
  const outputRemaining = Math.floor(workDeadline - now());
  if (outputRemaining <= 0) {
    return deadlineResult(request, 'orca-terminal-read', 'orca_read_deadline');
  }
  const output = runtime.readBoundedOutput(
    { worker: worker.identity },
    { cwd: root, timeoutMs: outputRemaining },
  );
  if (output.status !== 'ok') {
    if (output.reason === 'runtime_timeout') {
      return deadlineResult(request, 'orca-terminal-read', 'orca_read_deadline');
    }
    return watchResult('source-unavailable', {
      operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
      reasonCode: `runtime_${output.status}`, deadlineMs: request.deadlineMs,
      evidence: { reason: output.reason, runtime: runtime.id }, remediation: 'inspect-source',
    });
  }
  return watchResult('matched', {
    operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
    reasonCode: 'matched', deadlineMs: request.deadlineMs,
    evidence: {
      runtime: runtime.id,
      worker: { id: worker.identity.id, generation: worker.identity.generation },
      provenance: worker.provenance,
      lineCount: output.value.lines.length,
      changed: output.value.changed,
      terminalState: output.value.terminalState,
    },
    remediation: 'none', owner: 'wrapper', operatorDisposition: 'none',
  });
}

async function observeOrcaThroughInjectedRunner(
  request: WatchRequest,
  run: Runner,
  root: string,
  now: () => number,
  workDeadline: number,
): Promise<WatchResult> {
  const invoked = await invoke(
    run,
    'orca',
    ['terminal', 'read', '--terminal', request.terminalHandle ?? '', '--json'],
    root,
    now,
    workDeadline,
  );
  if (invoked.expired) return deadlineResult(request, 'orca-terminal-read', 'orca_read_deadline');
  const result = invoked.result;
  if (!result || result.timedOut || result.outcome === 'timeout') {
    return deadlineResult(
      request,
      'orca-terminal-read',
      'orca_read_deadline',
      result ? processEvidence(result) : {},
    );
  }
  const payload = result.stdout.length > 0 ? object(result.stdout) : null;
  if (payload?.ok === false) {
    return watchResult('source-unavailable', {
      operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
      reasonCode: 'orca_read_ok_false', deadlineMs: request.deadlineMs,
      evidence: { ...processEvidence(result), response: payload }, remediation: 'inspect-source',
    });
  }
  if (!result.ok) {
    return watchResult('source-unavailable', {
      operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
      reasonCode: 'orca_read_command_failed', deadlineMs: request.deadlineMs,
      evidence: processEvidence(result), remediation: 'inspect-source',
    });
  }
  if (!payload) {
    return watchResult('source-unavailable', {
      operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
      reasonCode: result.stdout.length === 0 ? 'orca_read_empty_stdout' : 'orca_read_malformed_json',
      deadlineMs: request.deadlineMs, evidence: processEvidence(result), remediation: 'inspect-source',
    });
  }
  const resultObject = payload.result !== null && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown>
    : null;
  const lines = resultObject?.lines;
  const nextCursor = resultObject?.nextCursor;
  if (payload.ok !== true || !resultObject || !Array.isArray(lines)
    || !('nextCursor' in resultObject)
    || (nextCursor !== null && typeof nextCursor !== 'string')) {
    return watchResult('source-unavailable', {
      operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
      reasonCode: 'orca_read_invalid_response_shape', deadlineMs: request.deadlineMs,
      evidence: { ...processEvidence(result), response: payload }, remediation: 'inspect-source',
    });
  }
  return watchResult('matched', {
    operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
    reasonCode: 'matched', deadlineMs: request.deadlineMs, evidence: { response: payload },
    remediation: 'none', owner: 'wrapper', operatorDisposition: 'none',
  });
}

export async function executeWatchRequest(
  request: WatchRequest,
  dependencies: WatchDependencies = {},
): Promise<WatchResult> {
  const run = dependencies.run ?? runOwnedProcess;
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep
    ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const root = dependencies.root ?? process.cwd();
  const startedAt = now();
  const workDeadline = startedAt + request.deadlineMs - CLEANUP_RESERVE_MS - 1_000;
  const operation = request.sourceId === 'github.pull-request' ? 'github-pr-read' : 'orca-terminal-read';
  const cleanupHelpers = dependencies.cleanupHelpers ?? (async ({ timeoutMs }) => ({
    completed: true,
    evidence: { timeoutMs, helperProcessGroupId: null, redirectedSinkId: null },
  }));
  const fail = (primary: WatchResult): Promise<WatchResult> =>
    finalizeWatchFailure(request, primary, startedAt, now, cleanupHelpers);

  if (request.sourceId === 'orca.terminal') {
    let observed: WatchResult;
    try {
      observed = dependencies.run
        ? await observeOrcaThroughInjectedRunner(request, run, root, now, workDeadline)
        : await observeOrcaThroughRuntime(
          request,
          dependencies.runtime ?? await selectRuntimeAdapter(),
          root,
          now,
          workDeadline,
        );
    } catch (error) {
      observed = watchResult('source-unavailable', {
        operation: 'orca-terminal-read', sourceId: request.sourceId, predicateId: request.predicateId,
        reasonCode: 'runtime_selection_failed', deadlineMs: request.deadlineMs,
        evidence: { error: error instanceof Error ? error.message : String(error) },
        remediation: 'inspect-source',
      });
    }
    return observed.outcome === 'matched' ? observed : fail(observed);
  }

  const gh = resolve(root, 'scripts/gh');
  const args = ['pr', 'view', String(request.prNumber), '--repo', request.repo ?? '', '--json', 'state,mergedAt'];
  for (let reads = 0; reads < 120; reads += 1) {
    const invoked = await invoke(run, gh, args, root, now, workDeadline);
    if (invoked.expired) return fail(deadlineResult(request, operation, 'github_read_deadline', { reads }));
    const result = invoked.result;
    if (!result || result.timedOut || result.outcome === 'timeout') {
      return fail(deadlineResult(
        request,
        operation,
        'github_read_deadline',
        { reads, ...(result ? processEvidence(result) : {}) },
      ));
    }
    if (!result.ok) {
      return fail(watchResult('source-unavailable', {
        operation, sourceId: request.sourceId, predicateId: request.predicateId,
        reasonCode: 'github_command_failed', deadlineMs: request.deadlineMs,
        evidence: { reads, ...processEvidence(result), argv: [gh, ...args] }, remediation: 'inspect-source',
      }));
    }
    const payload = result.stdout.length > 0 ? object(result.stdout) : null;
    if (!payload) {
      return fail(watchResult('source-unavailable', {
        operation, sourceId: request.sourceId, predicateId: request.predicateId,
        reasonCode: result.stdout.length === 0 ? 'github_empty_stdout' : 'github_malformed_json',
        deadlineMs: request.deadlineMs,
        evidence: { reads, ...processEvidence(result), argv: [gh, ...args] }, remediation: 'inspect-source',
      }));
    }
    const state = payload.state;
    const mergedAt = payload.mergedAt;
    if (!('state' in payload)) {
      return fail(watchResult('source-unavailable', {
        operation, sourceId: request.sourceId, predicateId: request.predicateId,
        reasonCode: 'github_missing_state', deadlineMs: request.deadlineMs,
        evidence: { reads, ...processEvidence(result), response: payload }, remediation: 'inspect-source',
      }));
    }
    if (!('mergedAt' in payload)) {
      return fail(watchResult('source-unavailable', {
        operation, sourceId: request.sourceId, predicateId: request.predicateId,
        reasonCode: 'github_missing_mergedAt', deadlineMs: request.deadlineMs,
        evidence: { reads, ...processEvidence(result), response: payload }, remediation: 'inspect-source',
      }));
    }
    if ((state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED')
      || (mergedAt !== null && typeof mergedAt !== 'string')) {
      return fail(watchResult('source-unavailable', {
        operation, sourceId: request.sourceId, predicateId: request.predicateId,
        reasonCode: 'github_invalid_response_shape', deadlineMs: request.deadlineMs,
        evidence: { reads, ...processEvidence(result), response: payload }, remediation: 'inspect-source',
      }));
    }
    if (state === 'MERGED' && mergedAt !== null) {
      return watchResult('matched', {
        operation, sourceId: request.sourceId, predicateId: request.predicateId, reasonCode: 'matched',
        deadlineMs: request.deadlineMs,
        evidence: { reads, response: payload, argv: [gh, ...args] },
        remediation: 'none', owner: 'wrapper', operatorDisposition: 'none',
      });
    }
    if (state === 'CLOSED' && mergedAt === null) {
      return watchResult('predicate-failed', {
        operation, sourceId: request.sourceId, predicateId: request.predicateId,
        reasonCode: 'github_pr_not_merged', deadlineMs: request.deadlineMs,
        evidence: { reads, response: payload, argv: [gh, ...args] },
        remediation: 'none', owner: 'wrapper', operatorDisposition: 'none',
      });
    }
    if (now() + 250 >= workDeadline) {
      return fail(deadlineResult(request, operation, 'github_read_deadline', { reads, response: payload }));
    }
    await sleep(250);
  }
  return fail(watchResult('source-unavailable', {
    operation, sourceId: request.sourceId, predicateId: request.predicateId,
    reasonCode: 'github_read_cap_exceeded', deadlineMs: request.deadlineMs,
    evidence: { readCap: 120 }, remediation: 'inspect-source',
  }));
}

async function main(): Promise<void> {
  const result = await executeWatch(new Uint8Array(readFileSync(0)));
  const emitted = await emitResult(result);
  if (!emitted.transportOk) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
