#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { selectRuntimeAdapter } from './runtime/registry.ts';
import { recoverRuntimeWorker } from './runtime/worker-recovery.ts';
import {
  acquireWorkerRecoveryClaim,
  finalizeWorkerRecoveryClaim,
  releaseWorkerRecoveryClaim,
} from './runtime/worker-recovery-claim.ts';
import { resolveWakeSupervisorStateRoot } from './pr2-foundation/wake-supervisor-state-root.ts';
import type { RuntimeAdapter } from './runtime/contracts.ts';

export interface WorkerRecoveryCliOptions {
  workerId: string;
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

function claimKeyFor(input: Pick<WorkerRecoveryCliOptions, 'workerId' | 'cleanupWorkspacePath'>): string {
  const source = `${input.workerId}|${resolve(input.cleanupWorkspacePath)}`;
  return `recovery-${createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 24)}`;
}

export function parseWorkerRecoveryArgs(argv: readonly string[]): WorkerRecoveryCliOptions {
  const options: WorkerRecoveryCliOptions = {
    workerId: '',
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
    switch (args[index]) {
      case '--worker-id': options.workerId = args[++index]?.trim() ?? ''; break;
      case '--cleanup-workspace': options.cleanupWorkspacePath = resolve(args[++index] ?? ''); break;
      case '--expected-head-sha': options.expectedHeadSha = args[++index]?.trim().toLowerCase() ?? ''; break;
      case '--spawn-workspace': {
        const value = args[++index]?.trim() ?? '';
        options.spawnWorkspace = value === 'active' ? 'active' : resolve(value);
        break;
      }
      case '--title': options.title = args[++index]?.trim() || options.title; break;
      case '--command': options.command = args[++index]?.trim() || options.command; break;
      case '--claim-key': options.claimKey = args[++index]?.trim() ?? ''; break;
      case '--project-id': options.projectId = args[++index]?.trim() || options.projectId; break;
      case '--surface': options.surface = args[++index]?.trim() || options.surface; break;
      case '--repo-root': options.repoRoot = resolve(args[++index] ?? options.repoRoot); break;
      case '--dry-run': options.dryRun = true; break;
      default: throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  if (!options.cleanupWorkspacePath) throw new Error('--cleanup-workspace is required');
  options.claimKey ||= claimKeyFor(options);
  return options;
}

export async function runWorkerRecovery(input: {
  readonly options: WorkerRecoveryCliOptions;
  readonly adapter?: RuntimeAdapter;
  readonly claimNamespace?: string;
}): Promise<Record<string, unknown>> {
  const { options } = input;
  if (options.dryRun) {
    return {
      outcome: 'dry_run',
      claimKey: options.claimKey,
      cleanupWorkspacePath: options.cleanupWorkspacePath,
      spawnWorkspace: options.spawnWorkspace,
    };
  }

  // Adapter selection is read-only and occurs before claim ownership so a
  // composition-root failure cannot strand an active recovery claim.
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
  const claim = acquireWorkerRecoveryClaim({
    namespace: claimNamespace,
    claimKey: options.claimKey,
    workspacePath: options.cleanupWorkspacePath,
    workerId: options.workerId || undefined,
    surface: options.surface,
  });
  if (!claim.acquired) {
    return { outcome: 'spawn_denied', reason: claim.reason, claimKey: options.claimKey };
  }

  try {
    const result = recoverRuntimeWorker({
      adapter,
      targetId: options.workerId || undefined,
      workspace: options.spawnWorkspace,
      cleanupWorkspace: {
        workspacePath: options.cleanupWorkspacePath,
        expectedHeadSha: options.expectedHeadSha || undefined,
      },
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
