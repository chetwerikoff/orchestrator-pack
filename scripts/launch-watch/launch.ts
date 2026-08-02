import '../toolchain/native-entrypoint-preflight.ts';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runProcess, type ProcessResult } from '../kernel/subprocess.ts';
import { emitResult } from '../lib/launch-watch/emission.ts';
import {
  CLEANUP_RESERVE_MS,
  encodeLaunchCommand,
  invalidLaunchResult,
  launchResult,
  parseLaunchRequest,
  type LaunchRequest,
  type LaunchResult,
  type Phase,
  cleanupOverride,
} from '../lib/launch-watch/contract.ts';

type Runner = (command: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number; readonly input?: string }) => Promise<ProcessResult>;

export type LaunchDependencies = {
  readonly run?: Runner;
  readonly now?: () => number;
  readonly root?: string;
  readonly trustScript?: string;
  readonly terminalClose?: boolean;
};

const defaultRun: Runner = (command, args, options) => runProcess({
  command: process.platform === 'win32' ? command : 'setsid',
  args: process.platform === 'win32' ? args : [command, ...args],
  cwd: options.cwd,
  timeoutMs: options.timeoutMs,
  input: options.input,
  allowEmptyStdout: true,
  inheritParentEnv: true,
});

function json(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function outputEvidence(result: ProcessResult): Record<string, unknown> {
  return {
    processOutcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
}

function rootForPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function cursorSlug(path: string): string {
  const segments = path.replace(/^[/\\]+/u, '').split(/[/\\]+/u).map((part) => part.trim().replace(/^\.+/u, '')).filter(Boolean);
  return segments.join('-');
}

function trustMarkerPath(worktree: string): string {
  const candidate = `${process.env.HOME ?? ''}/.cursor/projects/${cursorSlug(worktree)}`;
  if (candidate.length <= 92) return `${candidate}/.workspace-trusted`;
  const hash = createHash('sha256').update(candidate).digest('hex').slice(0, 7);
  return `${candidate.slice(0, 84)}-${hash}/.workspace-trusted`;
}

function resultTerminal(response: Record<string, unknown>): Record<string, unknown> | null {
  const result = response.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const terminal = (result as Record<string, unknown>).terminal;
  return terminal !== null && typeof terminal === 'object' && !Array.isArray(terminal) ? terminal as Record<string, unknown> : null;
}

function terminalHandle(terminal: Record<string, unknown> | null): string | null {
  for (const key of ['handle', 'terminalHandle', 'id']) {
    const value = terminal?.[key];
    if (typeof value === 'string' && value.length > 0 && !value.includes('\u0000')) return value;
  }
  return null;
}

function worktreeId(terminal: Record<string, unknown> | null): string | null {
  const value = terminal?.worktreeId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function currentWorktree(response: Record<string, unknown>): { readonly path: string; readonly id: string | null } | null {
  if (response.ok !== true || response.result === null || typeof response.result !== 'object' || Array.isArray(response.result)) return null;
  const result = response.result as Record<string, unknown>;
  if (result.worktree === null || typeof result.worktree !== 'object' || Array.isArray(result.worktree)) return null;
  const worktree = result.worktree as Record<string, unknown>;
  if (typeof worktree.path !== 'string' || worktree.path.length === 0 || worktree.path.includes('\u0000')) return null;
  const id = typeof worktree.id === 'string' ? worktree.id : typeof worktree.worktreeId === 'string' ? worktree.worktreeId : null;
  return { path: rootForPath(worktree.path), id };
}

function statusResult(result: ProcessResult): string {
  if (result.outcome === 'timeout' || result.timedOut) return 'timeout';
  if (result.outcome === 'spawn-failure') return 'spawn-failure';
  if (!result.ok) return 'failed';
  return 'ok';
}

function gitFailure(result: ProcessResult): Record<string, unknown> {
  return outputEvidence(result);
}

function cleanupResourceIds(handle: string | null): {
  readonly terminalHandle: string | null;
  readonly helperProcessGroupId: null;
  readonly redirectedSinkId: null;
} {
  return { terminalHandle: handle, helperProcessGroupId: null, redirectedSinkId: null };
}

async function closeTerminal(
  run: Runner,
  cwd: string,
  handle: string,
  timeoutMs: number,
): Promise<{ readonly completed: boolean; readonly evidence: Record<string, unknown> }> {
  try {
    const result = await run('orca', ['terminal', 'close', '--terminal', handle, '--json'], { cwd, timeoutMs, input: '' });
    return { completed: result.ok, evidence: outputEvidence(result) };
  } catch (error) {
    return { completed: false, evidence: { error: error instanceof Error ? error.message : String(error) } };
  }
}

function deadlineResult(
  phase: Phase,
  deadlineMs: number,
  sourceIds: readonly string[],
  evidence: Record<string, unknown>,
  handle: string | null = null,
): LaunchResult {
  return launchResult('deadline-exceeded', {
    phase, reasonCode: `launch_deadline_${phase?.replaceAll('-', '_') ?? 'preflight'}`,
    deadlineMs, sourceIds, evidence, remediation: handle ? 'close-and-investigate' : 'wait-and-retry',
    owner: 'operator', operatorDisposition: handle ? 'investigate-possible-terminal' : 'retry-after-deadline',
    terminal: handle ? { handle } : null, containment: handle ? { status: 'attempted', closeAttempted: false, closeCompleted: false, terminalHandle: handle } : null,
  });
}

async function invoke(
  run: Runner,
  command: string,
  args: readonly string[],
  cwd: string,
  state: { readonly now: () => number; readonly workDeadline: number },
): Promise<{ readonly result?: ProcessResult; readonly expired: boolean }> {
  const remaining = Math.floor(state.workDeadline - state.now());
  if (remaining <= 0) return { expired: true };
  try {
    return { result: await run(command, args, { cwd, timeoutMs: remaining, input: '' }), expired: false };
  } catch {
    return { result: undefined, expired: false };
  }
}

function targetClassification(
  branch: string,
  status: string,
  head: string,
  remote: string,
  ancestorRemote: ProcessResult,
  ancestorHead: ProcessResult,
): string | null {
  if (branch !== 'main') return 'target_non_main';
  if (status.length > 0) return 'target_dirty';
  if (head === remote) return null;
  if (ancestorRemote.ok) return null;
  if (ancestorHead.ok) return 'target_ahead';
  return 'target_diverged';
}

async function gitText(run: Runner, args: readonly string[], cwd: string, state: { readonly now: () => number; readonly workDeadline: number }): Promise<{ readonly value?: string; readonly result?: ProcessResult; readonly expired: boolean }> {
  const invoked = await invoke(run, 'git', args, cwd, state);
  if (invoked.expired || !invoked.result) return { expired: true };
  return { value: invoked.result.ok ? invoked.result.stdout.trim() : undefined, result: invoked.result, expired: false };
}

export async function executeLaunch(raw: Uint8Array, dependencies: LaunchDependencies = {}): Promise<LaunchResult> {
  const parsed = parseLaunchRequest(raw);
  if (!parsed.ok) return invalidLaunchResult(parsed.code, parsed.deadlineMs);
  return executeLaunchRequest(parsed.request, dependencies);
}

export async function executeLaunchRequest(request: LaunchRequest, dependencies: LaunchDependencies = {}): Promise<LaunchResult> {
  const run = dependencies.run ?? defaultRun;
  const now = dependencies.now ?? (() => performance.now());
  const startedAt = now();
  const workDeadline = startedAt + request.deadlineMs - CLEANUP_RESERVE_MS - 1_000;
  const state = { now, workDeadline };
  const evidence: Record<string, unknown> = { requestedCommand: null };
  let frozenRemote = '';

  const branch = await gitText(run, ['branch', '--show-current'], request.cwd, state);
  if (branch.expired) return deadlineResult('preflight', request.deadlineMs, ['pack.launch.target'], evidence);
  const status = await gitText(run, ['status', '--porcelain'], request.cwd, state);
  if (status.expired) return deadlineResult('target-verification', request.deadlineMs, ['pack.launch.target'], evidence);
  if (!branch.result?.ok || !status.result?.ok) {
    return launchResult('source-unavailable', {
      phase: 'target-verification', reasonCode: 'target_read_failed', deadlineMs: request.deadlineMs,
      sourceIds: ['pack.launch.target'], evidence: { branch: branch.result ? gitFailure(branch.result) : null, status: status.result ? gitFailure(status.result) : null },
      remediation: 'inspect-source',
    });
  }
  if (branch.value !== 'main') {
    return launchResult('target-refused', {
      phase: 'target-verification', reasonCode: 'target_non_main', deadlineMs: request.deadlineMs,
      sourceIds: ['pack.launch.target'], evidence: { branch: branch.value }, remediation: 'repair-target',
    });
  }
  if ((status.value ?? '').length > 0) {
    return launchResult('target-refused', {
      phase: 'target-verification', reasonCode: 'target_dirty', deadlineMs: request.deadlineMs,
      sourceIds: ['pack.launch.target'], evidence: { status: status.value }, remediation: 'repair-target',
    });
  }

  const current = await invoke(run, 'orca', ['worktree', 'current', '--json'], request.cwd, state);
  if (current.expired) return deadlineResult('binding-verification', request.deadlineMs, ['orca.worktree'], evidence);
  const currentPayload = current.result?.ok ? json(current.result.stdout) : null;
  const worktree = currentPayload ? currentWorktree(currentPayload) : null;
  if (!worktree) {
    return launchResult('source-unavailable', {
      phase: 'binding-verification', reasonCode: 'launch_worktree_current_invalid_response_shape', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.worktree'], evidence: current.result ? outputEvidence(current.result) : {}, remediation: 'inspect-source',
    });
  }
  const requestedRoot = rootForPath(request.cwd);
  if (worktree.path !== requestedRoot) {
    return launchResult('invalid-request', {
      phase: null, reasonCode: 'launch_workspace_path_mismatch', deadlineMs: request.deadlineMs,
      sourceIds: ['pack.launch.request', 'orca.worktree'], sourceId: 'pack.launch.request',
      evidence: { requestedRoot, observedRoot: worktree.path }, remediation: 'reject-request', owner: 'operator',
    });
  }
  if (!worktree.id) {
    return launchResult('source-unavailable', {
      phase: 'binding-verification', reasonCode: 'launch_missing_workspace_id', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.worktree'], evidence: { worktree }, remediation: 'inspect-source',
    });
  }

  const fetched = await invoke(run, 'git', ['fetch', 'origin', 'main'], request.cwd, state);
  if (fetched.expired) return deadlineResult('refresh', request.deadlineMs, ['pack.launch.git'], evidence);
  if (!fetched.result?.ok) {
    return launchResult('source-unavailable', {
      phase: 'refresh', reasonCode: 'refresh_failed', deadlineMs: request.deadlineMs, sourceIds: ['pack.launch.git'],
      evidence: fetched.result ? gitFailure(fetched.result) : {}, remediation: 'inspect-source',
    });
  }
  const remote = await gitText(run, ['rev-parse', request.remoteRef], request.cwd, state);
  if (remote.expired) return deadlineResult('refresh', request.deadlineMs, ['pack.launch.git'], evidence);
  if (!remote.result?.ok || !remote.value) {
    return launchResult('source-unavailable', {
      phase: 'refresh', reasonCode: 'refresh_invalid_response', deadlineMs: request.deadlineMs, sourceIds: ['pack.launch.git'],
      evidence: remote.result ? gitFailure(remote.result) : {}, remediation: 'inspect-source',
    });
  }
  frozenRemote = remote.value;
  evidence.frozenRemoteSha = frozenRemote;

  const head = await gitText(run, ['rev-parse', 'HEAD'], request.cwd, state);
  const ancestorRemote = await invoke(run, 'git', ['merge-base', '--is-ancestor', 'HEAD', request.remoteRef], request.cwd, state);
  const ancestorHead = await invoke(run, 'git', ['merge-base', '--is-ancestor', request.remoteRef, 'HEAD'], request.cwd, state);
  if (head.expired || ancestorRemote.expired || ancestorHead.expired) return deadlineResult('target-verification', request.deadlineMs, ['pack.launch.git'], evidence);
  const refusal = targetClassification(branch.value ?? '', status.value ?? '', head.value ?? '', frozenRemote, ancestorRemote.result ?? { ok: false } as ProcessResult, ancestorHead.result ?? { ok: false } as ProcessResult);
  if (refusal) {
    return launchResult('target-refused', {
      phase: 'target-verification', reasonCode: refusal, deadlineMs: request.deadlineMs, sourceIds: ['pack.launch.git'],
      evidence: { ...evidence, head: head.value, frozenRemote }, remediation: 'repair-target',
    });
  }
  if (head.value !== frozenRemote) {
    const ff = await invoke(run, 'git', ['merge', '--ff-only', frozenRemote], request.cwd, state);
    if (ff.expired) return deadlineResult('target-transition', request.deadlineMs, ['pack.launch.git'], evidence);
    if (!ff.result?.ok) {
      return launchResult('target-refused', {
        phase: 'target-transition', reasonCode: 'target_fast_forward_rejected', deadlineMs: request.deadlineMs,
        sourceIds: ['pack.launch.git'], evidence: ff.result ? gitFailure(ff.result) : {}, remediation: 'repair-target',
      });
    }
  }
  const boundHead = await gitText(run, ['rev-parse', 'HEAD'], request.cwd, state);
  const boundBranch = await gitText(run, ['branch', '--show-current'], request.cwd, state);
  const boundStatus = await gitText(run, ['status', '--porcelain'], request.cwd, state);
  if (boundHead.expired || boundBranch.expired || boundStatus.expired) return deadlineResult('target-transition', request.deadlineMs, ['pack.launch.git'], evidence);
  if (boundBranch.value !== 'main' || (boundStatus.value ?? '').length > 0 || boundHead.value !== frozenRemote) {
    return launchResult('target-refused', {
      phase: 'target-transition', reasonCode: 'target_head_mismatch', deadlineMs: request.deadlineMs,
      sourceIds: ['pack.launch.git'], evidence: { expected: frozenRemote, actual: boundHead.value, branch: boundBranch.value, status: boundStatus.value }, remediation: 'repair-target',
    });
  }

  const trust = await invoke(run, 'pwsh', ['-NoProfile', '-File', dependencies.trustScript ?? `${dependencies.root ?? process.cwd()}/scripts/trust-ao-worktree.ps1`, '-WorkspacePath', requestedRoot, '-Quiet'], request.cwd, state);
  if (trust.expired) return deadlineResult('trust', request.deadlineMs, ['pack.launch.trust'], evidence);
  const marker = trustMarkerPath(requestedRoot);
  let markerPayload: Record<string, unknown> | null = null;
  try { markerPayload = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>; } catch { markerPayload = null; }
  if (!trust.result?.ok || markerPayload?.workspacePath !== requestedRoot) {
    return launchResult('trusted-start-failed', {
      phase: 'trust', reasonCode: 'trust_marker_invalid', deadlineMs: request.deadlineMs, sourceIds: ['pack.launch.trust'],
      evidence: { process: trust.result ? outputEvidence(trust.result) : null, marker, markerPayload }, remediation: 'verify-trust',
    });
  }

  const commandValue = encodeLaunchCommand(request);
  evidence.requestedCommand = commandValue;
  const createArgs = ['terminal', 'create', '--worktree', 'active', '--command', commandValue, '--json'];
  const createStarted = now();
  let createResult: ProcessResult | undefined;
  try { createResult = (await run('orca', createArgs, { cwd: request.cwd, timeoutMs: Math.max(1, Math.floor(workDeadline - createStarted)), input: '' })); }
  catch (error) {
    const primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_dispatched_thrown', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { error: error instanceof Error ? error.message : String(error), argv: createArgs },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal',
    });
    return primary;
  }
  const response = createResult.stdout.length > 0 ? json(createResult.stdout) : null;
  const terminal = resultTerminal(response ?? {});
  const handle = terminalHandle(terminal);
  const responseWorktreeId = worktreeId(terminal);
  const validHandleShape = handle !== null && responseWorktreeId === worktree.id;
  let primary: LaunchResult;
  if (handle && !validHandleShape) {
    primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_invalid_response_shape', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { ...outputEvidence(createResult), argv: createArgs, response },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal', terminal: { handle, worktreeId: responseWorktreeId },
    });
  } else if (createResult.timedOut || createResult.outcome === 'timeout') {
    primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_timeout', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { ...outputEvidence(createResult), argv: createArgs },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal', terminal: handle ? { handle } : null,
    });
  } else if (createResult.outcome === 'spawn-failure') {
    primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_dispatched_thrown', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { ...outputEvidence(createResult), argv: createArgs },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal', terminal: handle ? { handle } : null,
    });
  } else if (createResult.exitCode !== 0) {
    primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_dispatched_nonzero', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { ...outputEvidence(createResult), argv: createArgs, response },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal', terminal: handle ? { handle } : null,
    });
  } else if (!createResult.stdout.trim()) {
    primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_empty', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { ...outputEvidence(createResult), argv: createArgs },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal',
    });
  } else if (!response) {
    primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_malformed', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { ...outputEvidence(createResult), argv: createArgs },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal',
    });
  } else if (response.ok !== true) {
    primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_dispatched_ok_false', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { ...outputEvidence(createResult), argv: createArgs, response },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal', terminal: handle ? { handle, worktreeId: responseWorktreeId } : null,
    });
  } else if (!handle) {
    primary = launchResult('terminal-create-ambiguous', {
      phase: 'terminal-create', reasonCode: 'terminal_create_missing_handle', deadlineMs: request.deadlineMs,
      sourceIds: ['orca.terminal-create'], evidence: { ...outputEvidence(createResult), argv: createArgs, response },
      remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal',
    });
  } else {
    const postHead = await gitText(run, ['rev-parse', 'HEAD'], request.cwd, state);
    const postBranch = await gitText(run, ['branch', '--show-current'], request.cwd, state);
    if (postHead.expired || postBranch.expired || postHead.value !== frozenRemote || postBranch.value !== 'main') {
      primary = launchResult('target-refused', {
        phase: postHead.expired || postBranch.expired ? 'binding-verification' : 'target-verification',
        reasonCode: postHead.expired || postBranch.expired ? 'target_post_create_read_failed' : 'target_post_create_mismatch',
        deadlineMs: request.deadlineMs, sourceIds: ['pack.launch.git', 'orca.terminal-create'],
        evidence: { expected: frozenRemote, actual: postHead.value, branch: postBranch.value, terminalHandle: handle },
        remediation: 'close-and-investigate', owner: 'wrapper', operatorDisposition: 'investigate-possible-terminal',
        terminal: { handle, worktreeId: responseWorktreeId },
      });
    } else {
      return launchResult('launched', {
        phase: 'binding-verification', reasonCode: 'launched', deadlineMs: request.deadlineMs,
        sourceIds: ['pack.launch.request', 'pack.launch.git', 'orca.worktree', 'pack.launch.trust', 'orca.terminal-create'],
        evidence: { ...evidence, terminalCreateArgv: createArgs, frozenRemote, preCreateHead: boundHead.value, postCreateHead: postHead.value },
        remediation: 'none', owner: 'wrapper', operatorDisposition: 'none',
        terminal: { handle, worktreeId: responseWorktreeId, command: commandValue },
        containment: { status: 'not-needed', closeAttempted: false, closeCompleted: false, terminalHandle: handle },
      });
    }
  }
  if (handle) {
    const closed = dependencies.terminalClose === false ? { completed: false, evidence: { skipped: true } } : await closeTerminal(run, request.cwd, handle, Math.max(1, request.deadlineMs));
    const contained = {
      ...primary,
      terminal: primary.terminal ?? { handle },
      containment: { status: closed.completed ? 'closed' : 'failed', closeAttempted: true, closeCompleted: closed.completed, terminalHandle: handle, errorCode: closed.completed ? null : 'cleanup_termination_failed' },
      evidence: { ...primary.evidence, containmentClose: closed.evidence },
    };
    if (closed.completed) return cleanupOverride(contained, 'completed', cleanupResourceIds(handle)) as LaunchResult;
    return cleanupOverride(contained, 'failed', cleanupResourceIds(handle), 'cleanup_termination_failed') as LaunchResult;
  }
  return primary;
}

async function main(): Promise<void> {
  const result = await executeLaunch(new Uint8Array(readFileSync(0)));
  const emitted = await emitResult(result);
  if (!emitted.transportOk) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
