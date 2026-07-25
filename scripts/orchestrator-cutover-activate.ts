#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runActivationTransaction } from './lib/cutover/activation-transaction.ts';
import { recoveryDisposition } from './lib/cutover/activation-recovery.ts';
import { runSupervisorOwned, status, type SupervisorOptions } from './lib/orchestrator-side-process-supervisor.ts';
import type { ActivationContext } from './lib/cutover/types.ts';

function value(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_argument:${name}`);
  return process.argv[index + 1]!;
}

function supervisorOptions(context: ActivationContext, epochId: string, nonce: string): SupervisorOptions {
  return {
    repoRoot: context.repoRoot,
    stateDir: context.stateDir,
    registryPath: context.liveRegistryProjectionPath,
    epochAuthorityFile: context.epochAuthorityFile,
    epochId,
    nonce,
  };
}

async function main(): Promise<void> {
  const planPath = resolve(value('--plan'));
  const context = JSON.parse(readFileSync(planPath, 'utf8')) as ActivationContext;
  const mode = process.argv.includes('--resume') ? 'resume' : 'activate';
  if (mode === 'resume') {
    const nonceIndex = process.argv.indexOf('--nonce');
    const nonce = nonceIndex >= 0 ? process.argv[nonceIndex + 1] ?? '' : '';
    if (!nonce) throw new Error('resume_nonce_required');
    process.stdout.write(`${JSON.stringify({ disposition: recoveryDisposition(context.stateDir, context.epochAuthorityFile, context.epochId, nonce) })}\n`);
    return;
  }

  const supervisorController = new AbortController();
  let supervisorTask: Promise<void> | null = null;
  process.on('SIGTERM', () => supervisorController.abort());
  process.on('SIGINT', () => supervisorController.abort());

  const result = await runActivationTransaction(context, {
    startTypeScriptSupervisor: ({ epochId, nonce }) => {
      const options = supervisorOptions(context, epochId, nonce);
      supervisorTask = runSupervisorOwned(options, supervisorController.signal);
      const current = status(options);
      if (!current.running || current.supervisorPid !== process.pid || !current.childPid) {
        supervisorController.abort();
        throw new Error('typescript_supervisor_start_verification_failed');
      }
    },
  });
  process.stdout.write(`${JSON.stringify({ cutover: result, supervisor: 'foreground-owned' })}\n`);
  if (supervisorTask) await supervisorTask;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
