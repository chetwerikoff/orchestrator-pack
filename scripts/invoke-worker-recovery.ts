#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
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
} from './runtime/worker-recovery-claim.ts';
import { resolveWakeSupervisorStateRoot } from './pr2-foundation/wake-supervisor-state-root.ts';
import type { RuntimeAdapter } from './runtime/contracts.ts';

export interface WorkerRecoveryCliOptions {
  workerId: string;
  workerGeneration: string;
  cleanupWorkspacePath: string;
  expectedHeadSha: string;
  spawnWorkspace: 'active' | string;
  title: string;
  command: string;
  claimKey: string;
  projectId: string;
  surface: string;
  repoRoot: string;
  dryRun: boolean;
}

function claimKeyFor(
  input: Pick<WorkerRecoveryCliOptions, 'workerId' | 'workerGeneration' | 'cleanupWorkspacePath'>,
): string {
  const source = `${input.workerId}|${input.workerGeneration}|${resolve(input.cleanupWorkspacePath)}`;
  return `recovery-${createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 24)}`;
}

function requiredOptionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]?.trim() ?? '';
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a non-empty value`);
  }
  return value;
}

export function parseWorkerRecoveryArgs(argv: readonly string[]): WorkerRecoveryCliOptions {
  const options: WorkerRecoveryCliOptions = {
    workerId: '',
    workerGeneration: '',
    cleanupWorkspacePath: '',
    expectedHeadSha: '',
    spawnWorkspace: 'active',
    title: 'recovered-worker',
    command: 'cursor-agent',
    claimKey: '',
    projectId: 'orchestrator-pack',
    surface: 'worker-recovery',
    repoRoot: process.cwd(),
    dryRun: false,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    switch (option) {
      case '--worker-id':
        options.workerId = requiredOptionValue(args, index, option);
        index += 1;
        break;
      case '--worker-generation':
        options.workerGeneration = requiredOptionValue(args, index, option);
        index += 1;
        break;
      case '--cleanup-workspace':
        options.cleanupWorkspacePath = resolve(requiredOptionValue(args, index, option));
        index += 1;
        break;
      case '--expected-head-sha':
        options.expectedHeadSha = requiredOptionValue(args, index, option).toLowerCase();
        index += 1;
        break;
      case '--spawn-workspace': {
        const value = requiredOptionValue(args, index, option);
        options.spawnWorkspace = value === 'active' ? 'active' : resolve(value);
        index += 1;
        break;
      }
      case '--title':
        options.title = requiredOptionValue(args, index, option);
        index += 1;
        break;
      case '--command':
        options.command = requiredOptionValue(args, index, option);
        index += 1;
        break;
      case '--claim-key':
        options.claimKey = requiredOptionValue(args, index, option);
        index += 1;
        break;
      case '--project-id':
        options.projectId = requiredOptionValue(args, index, option);
        index += 1;
        break;
      case '--surface':
        options.surface = requiredOptionValue(args, index, option);
        index += 1;
        break;
      case '--repo-root':
        options.repoRoot = resolve(requiredOptionValue(args, index, option));
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`unknown argument: ${option}`);
    }
  }

  if (!options.cleanupWorkspacePath) throw new Error('--cleanup-workspace is required');
  if (!options.expectedHeadSha) throw new Error('--expected-head-sha is required');
  if (!options.workerId) throw new Error('--worker-id is required for destructive recovery');
  if (!options.workerGeneration) {
    throw new Error('--worker-generation is required for destructive recovery');
  }
  if (options.spawnWorkspace !== 'active'
    && resolve(options.spawnWorkspace) === resolve(options.cleanupWorkspacePath)) {
    throw new Error('--spawn-workspace must differ from --cleanup-workspace');
  }

  options.claimKey ||= claimKeyFor(options);
  return options;
}

/**
 * The CLI deliberately cannot mint cleanup authority from its flags or from the
 * recovery-time serialization claim. A caller that already loaded and validated
 * a durable pack reservation may pass that authority through this API; the
 * direct command otherwise fails closed before removeWorkspace.
 */
export async function runWorkerRecovery(input: {
  readonly options: WorkerRecoveryCliOptions;
  readonly adapter?: RuntimeAdapter;
  readonly claimNamespace?: string;
  readonly cleanupAuthority?: WorkerRecoveryCleanupAuthority;
}): Promise<Record<string, unknown>> {
  const { options } = input;
  if (options.dryRun) {
    return {
      outcome: 'dry_run',
      claimKey: options.claimKey,
      cleanupWorkspacePath: options.cleanupWorkspacePath,
      expectedHeadSha: options.expectedHeadSha,
      spawnWorkspace: options.spawnWorkspace,
      workerId: options.workerId,
      workerGeneration: options.workerGeneration,
      cleanupAuthorityPresent: Boolean(input.cleanupAuthority),
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

  if (!input.cleanupAuthority) {
    return {
      outcome: 'skipped_ambiguous',
      reason: 'cleanup_ownership_authority_missing',
      claimKey: options.claimKey,
    };
  }

  const claimNamespace = input.claimNamespace
    ?? join(resolveWakeSupervisorStateRoot(), 'worker-recovery', options.projectId);
  const claim = acquireWorkerRecoveryClaim({
    namespace: claimNamespace,
    claimKey: options.claimKey,
    workspacePath: options.cleanupWorkspacePath,
    workerId: options.workerId,
    workerGeneration: options.workerGeneration,
    surface: options.surface,
  });
  if (!claim.acquired) {
    return { outcome: 'spawn_denied', reason: claim.reason, claimKey: options.claimKey };
  }

  try {
    const result = recoverRuntimeWorker({
      adapter,
      targetId: options.workerId,
      targetGeneration: options.workerGeneration,
      workspace: options.spawnWorkspace,
      cleanupWorkspace: {
        workspacePath: options.cleanupWorkspacePath,
        expectedHeadSha: options.expectedHeadSha,
      },
      cleanupAuthority: input.cleanupAuthority,
      title: options.title,
      command: options.command,
      acquireClaim: () => ({ ok: true }),
      options: { cwd: options.repoRoot },
    });
    const terminalOutcome = result.outcome === 'spawn_started'
      ? 'spawn_started'
      : result.outcome === 'runtime_failed'
        ? 'runtime_failed'
        : result.outcome;
    const finalized = finalizeWorkerRecoveryClaim(claim.handle, terminalOutcome, result);
    return { ...result, claimFinalized: finalized, claimKey: options.claimKey };
  } catch (error) {
    const finalized = finalizeWorkerRecoveryClaim(claim.handle, 'internal_failure', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'runtime_failed',
      reason: error instanceof Error ? error.message : 'internal_failure',
      claimFinalized: finalized,
      claimKey: options.claimKey,
    };
  } finally {
    releaseWorkerRecoveryClaim(claim.handle);
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseWorkerRecoveryArgs(argv);
  const result = await runWorkerRecovery({ options });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.outcome === 'spawn_started' || result.outcome === 'dry_run' ? 0 : 1;
}

const direct = import.meta.url === new URL(process.argv[1] ?? '', 'file:').href;
if (direct) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`invoke-worker-recovery: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
