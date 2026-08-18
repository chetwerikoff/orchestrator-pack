#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectRuntimeAdapter } from './runtime/registry.ts';
import {
  recoverRuntimeWorker,
  type WorkerRecoveryCleanupAuthority,
} from './runtime/worker-recovery.ts';
import {
  acquireWorkerRecoveryClaim,
  finalizeWorkerRecoveryClaim,
  releaseWorkerRecoveryClaim,
  type WorkerRecoveryClaimHandle,
} from './runtime/worker-recovery-claim.ts';
import {
  currentWorkerAssignment,
  resolveWorkerAssignmentStorePath,
  type WorkerAssignment,
} from './lib/worker-assignment-store.ts';
import { resolveWakeSupervisorStateRoot } from './pr2-foundation/wake-supervisor-state-root.ts';
import type { RuntimeAdapter } from './runtime/contracts.ts';

export interface WorkerRecoveryCliOptions {
  repository: string;
  issueNumber: number;
  taskId: string;
  assignmentId: string;
  assignmentGeneration: number;
  provider: string;
  bindingKey: string;
  workerId: string;
  workerGeneration: string;
  sessionId: string;
  cleanupWorkspacePath: string;
  expectedHeadSha: string;
  claimKey: string;
  projectId: string;
  surface: string;
  repoRoot: string;
  dryRun: boolean;
}

function claimKeyFor(
  input: Pick<WorkerRecoveryCliOptions, 'assignmentId' | 'assignmentGeneration' | 'cleanupWorkspacePath'>,
): string {
  const source = `${input.assignmentId}|${input.assignmentGeneration}|${resolve(input.cleanupWorkspacePath)}`;
  return `recovery-${createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 24)}`;
}

function requiredOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]?.trim() ?? '';
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a non-empty value`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(...values: unknown[]): string {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function sessionMetadataPath(options: WorkerRecoveryCliOptions): string {
  const base = process.env.OPK_BASE_DIR?.trim() || join(homedir(), '.orchestrator-pack');
  return join(base, 'projects', options.projectId, 'sessions', `${options.sessionId || options.workerId}.json`);
}

/** Resolve cleanup authority only from a pre-existing pack-owned session record. */
export function loadWorkerRecoveryCleanupAuthority(
  options: WorkerRecoveryCliOptions,
): { ok: true; authority: WorkerRecoveryCleanupAuthority } | { ok: false; reason: string } {
  const path = sessionMetadataPath(options);
  if (!existsSync(path)) return { ok: false, reason: 'cleanup_ownership_authority_missing' };
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const record = asRecord(parsed);
    if (!record) return { ok: false, reason: 'cleanup_ownership_authority_untrusted' };
    metadata = record;
  } catch {
    return { ok: false, reason: 'cleanup_ownership_authority_untrusted' };
  }
  const runtimeHandle = asRecord(metadata.runtimeHandle);
  const data = asRecord(runtimeHandle?.data);
  if (!runtimeHandle || !data) return { ok: false, reason: 'cleanup_ownership_authority_untrusted' };

  const runtime = text(runtimeHandle.runtime, data.runtime);
  const id = text(runtimeHandle.id, data.id, data.handle, data.terminalHandle);
  const generation = text(runtimeHandle.generation, data.generation, data.incarnationId, data.ptyId);
  const workspacePath = text(data.workspacePath, runtimeHandle.workspacePath, metadata.worktree);
  const expectedHeadSha = text(data.headSha, runtimeHandle.headSha, metadata.ownedHeadSha, metadata.headSha).toLowerCase();
  if (!runtime || !id || !generation || !workspacePath || !expectedHeadSha) {
    return { ok: false, reason: 'cleanup_ownership_authority_untrusted' };
  }
  if (id !== options.workerId
    || generation !== options.workerGeneration
    || resolve(workspacePath) !== resolve(options.cleanupWorkspacePath)
    || expectedHeadSha !== options.expectedHeadSha.toLowerCase()) {
    return { ok: false, reason: 'cleanup_ownership_authority_mismatch' };
  }
  return {
    ok: true,
    authority: {
      source: 'pack-reservation',
      worker: { runtime, id, generation },
      workspacePath: resolve(workspacePath),
      expectedHeadSha,
    },
  };
}

export function parseWorkerRecoveryArgs(argv: readonly string[]): WorkerRecoveryCliOptions {
  const options: WorkerRecoveryCliOptions = {
    repository: '', issueNumber: 0, taskId: '', assignmentId: '', assignmentGeneration: 0,
    provider: '', bindingKey: '', workerId: '', workerGeneration: '', sessionId: '',
    cleanupWorkspacePath: '', expectedHeadSha: '', claimKey: '', projectId: 'orchestrator-pack',
    surface: 'worker-recovery', repoRoot: process.cwd(), dryRun: false,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = () => requiredOptionValue(args, index, option ?? '');
    switch (option) {
      case '--repository': options.repository = value().toLowerCase(); index += 1; break;
      case '--issue-number': options.issueNumber = Number(value()); index += 1; break;
      case '--task-id': options.taskId = value(); index += 1; break;
      case '--assignment-id': options.assignmentId = value(); index += 1; break;
      case '--assignment-generation': options.assignmentGeneration = Number(value()); index += 1; break;
      case '--provider': options.provider = value().toLowerCase(); index += 1; break;
      case '--binding-key': options.bindingKey = value(); index += 1; break;
      case '--worker-id': options.workerId = value(); index += 1; break;
      case '--worker-generation': options.workerGeneration = value(); index += 1; break;
      case '--session-id': options.sessionId = value(); index += 1; break;
      case '--cleanup-workspace': options.cleanupWorkspacePath = resolve(value()); index += 1; break;
      case '--expected-head-sha': options.expectedHeadSha = value().toLowerCase(); index += 1; break;
      case '--claim-key': options.claimKey = value(); index += 1; break;
      case '--project-id': options.projectId = value(); index += 1; break;
      case '--surface': options.surface = value(); index += 1; break;
      case '--repo-root': options.repoRoot = resolve(value()); index += 1; break;
      case '--dry-run': options.dryRun = true; break;
      default: throw new Error(`unknown argument: ${option}`);
    }
  }
  if (!options.repository || !/^[^/\s]+\/[^/\s]+$/u.test(options.repository)) throw new Error('--repository is required');
  if (!Number.isInteger(options.issueNumber) || options.issueNumber <= 0) throw new Error('--issue-number is required');
  if (!options.taskId) throw new Error('--task-id is required');
  if (!options.assignmentId) throw new Error('--assignment-id is required');
  if (!Number.isInteger(options.assignmentGeneration) || options.assignmentGeneration <= 0) throw new Error('--assignment-generation is required');
  if (!options.provider) throw new Error('--provider is required');
  if (!options.bindingKey) throw new Error('--binding-key is required');
  if (!options.cleanupWorkspacePath) throw new Error('--cleanup-workspace is required');
  if (!options.expectedHeadSha) throw new Error('--expected-head-sha is required');
  if (!options.workerId) throw new Error('--worker-id is required for destructive recovery');
  if (!options.workerGeneration) throw new Error('--worker-generation is required for destructive recovery');
  options.sessionId ||= options.workerId;
  options.claimKey ||= claimKeyFor(options);
  return options;
}

function expectedCurrentAssignment(
  options: WorkerRecoveryCliOptions,
  current: WorkerAssignment | null,
): WorkerAssignment | null {
  if (!current
    || current.repository !== options.repository
    || current.issueNumber !== options.issueNumber
    || current.taskId !== options.taskId
    || current.assignmentId !== options.assignmentId
    || current.generation !== options.assignmentGeneration
    || current.kind !== 'local'
    || current.provider !== options.provider
    || current.bindingKey !== options.bindingKey) return null;
  return current;
}

function operatorHandoff(options: WorkerRecoveryCliOptions, cleanupReason: string): Record<string, unknown> {
  return {
    outcome: 'operator_required_successor_start',
    disposition: 'operator_manual',
    repository: options.repository,
    issueNumber: options.issueNumber,
    taskId: options.taskId,
    expectedAssignment: {
      assignmentId: options.assignmentId,
      generation: options.assignmentGeneration,
    },
    provider: options.provider,
    bindingKey: options.bindingKey,
    recoveryWorkspacePath: options.cleanupWorkspacePath,
    expectedHeadSha: options.expectedHeadSha,
    cleanupOutcome: 'completed',
    cleanupReason,
  };
}

export async function runWorkerRecovery(input: {
  readonly options: WorkerRecoveryCliOptions;
  readonly adapter?: RuntimeAdapter;
  readonly claimNamespace?: string;
  readonly cleanupAuthority?: WorkerRecoveryCleanupAuthority;
}): Promise<Record<string, unknown>> {
  const { options } = input;
  const assignmentFile = resolveWorkerAssignmentStorePath(options.projectId, process.env);
  const current = expectedCurrentAssignment(options, currentWorkerAssignment(assignmentFile, options.issueNumber));
  if (!current) return { outcome: 'assignment_stale', reason: 'assignment_stale', claimKey: options.claimKey };
  if (!input.cleanupAuthority) {
    return { outcome: 'skipped_ambiguous', reason: 'cleanup_ownership_authority_missing', claimKey: options.claimKey };
  }
  if (options.dryRun) {
    return {
      outcome: 'dry_run',
      disposition: 'no_effect',
      assignmentId: current.assignmentId,
      assignmentGeneration: current.generation,
      cleanupWorkspacePath: options.cleanupWorkspacePath,
      expectedHeadSha: options.expectedHeadSha,
      cleanupAuthorityPresent: true,
    };
  }

  let adapter: RuntimeAdapter;
  try {
    adapter = input.adapter ?? await selectRuntimeAdapter({}, { cwd: options.repoRoot });
  } catch (error) {
    return {
      outcome: 'runtime_failed',
      reason: error instanceof Error ? error.message : 'runtime_adapter_selection_failed',
      claimKey: options.claimKey,
    };
  }

  const claimNamespace = input.claimNamespace
    ?? join(resolveWakeSupervisorStateRoot(), 'worker-recovery', options.projectId);
  let claimHandle: WorkerRecoveryClaimHandle | undefined;
  const result = await recoverRuntimeWorker({
    assignmentStorePath: assignmentFile,
    expectedAssignment: current,
    adapter,
    cleanupWorkspace: {
      workspacePath: options.cleanupWorkspacePath,
      expectedHeadSha: options.expectedHeadSha,
    },
    cleanupAuthority: input.cleanupAuthority,
    acquireClaim: () => {
      const claim = acquireWorkerRecoveryClaim({
        namespace: claimNamespace,
        claimKey: options.claimKey,
        workspacePath: options.cleanupWorkspacePath,
        workerId: options.workerId,
        workerGeneration: options.workerGeneration,
        surface: options.surface,
      });
      if (!claim.acquired) return { ok: false, reason: claim.reason };
      claimHandle = claim.handle;
      return { ok: true };
    },
    options: { cwd: options.repoRoot },
  });

  let claimFinalized: boolean | undefined;
  if (claimHandle) {
    try {
      claimFinalized = finalizeWorkerRecoveryClaim(claimHandle, result.outcome, result);
    } finally {
      releaseWorkerRecoveryClaim(claimHandle);
    }
  }
  if (result.outcome === 'cleanup_completed') {
    return {
      ...operatorHandoff(options, result.reason),
      ...(claimFinalized !== undefined ? { claimFinalized } : {}),
      claimKey: options.claimKey,
    };
  }
  return {
    ...result,
    ...(claimFinalized !== undefined ? { claimFinalized } : {}),
    claimKey: options.claimKey,
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: { readonly adapter?: RuntimeAdapter; readonly claimNamespace?: string } = {},
): Promise<number> {
  const options = parseWorkerRecoveryArgs(argv);
  const authority = loadWorkerRecoveryCleanupAuthority(options);
  const result = await runWorkerRecovery({
    options,
    adapter: dependencies.adapter,
    claimNamespace: dependencies.claimNamespace,
    cleanupAuthority: authority.ok ? authority.authority : undefined,
  });
  const publicResult = authority.ok || result.outcome !== 'skipped_ambiguous'
    ? result
    : { ...result, reason: authority.reason };
  process.stdout.write(`${JSON.stringify(publicResult)}\n`);
  return publicResult.outcome === 'operator_required_successor_start' || publicResult.outcome === 'dry_run' ? 0 : 1;
}

const direct = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`invoke-worker-recovery: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
