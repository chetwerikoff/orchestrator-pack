#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runActivationTransaction } from './lib/cutover/activation-transaction.ts';
import { processStartTime } from './lib/cutover/activation-platform-preflight.ts';
import { recoveryDisposition } from './lib/cutover/activation-recovery.ts';
import type { ActivationContext, ProcessIdentity } from './lib/cutover/types.ts';

function value(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_argument:${name}`);
  return process.argv[index + 1]!;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForSupervisorOwnership(stateDir: string, pid: number, timeoutMs = 5_000): Promise<void> {
  const ownerPath = join(stateDir, 'typescript-supervisor.lock', 'owner.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) throw new Error(`typescript_supervisor_exited_early:${pid}`);
    if (existsSync(ownerPath)) {
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as ProcessIdentity;
        if (owner.pid === pid && owner.startTime === processStartTime(pid)) return;
        if (owner.pid !== pid && alive(owner.pid)) throw new Error(`typescript_supervisor_competing_owner:${owner.pid}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('typescript_supervisor_competing_owner:')) throw error;
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`typescript_supervisor_start_timeout:${pid}`);
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
  const result = await runActivationTransaction(context, {
    startTypeScriptSupervisor: async ({ epochId, nonce }) => {
      const supervisor = resolve(context.repoRoot, 'scripts/orchestrator-wake-supervisor.ts');
      const child = spawn(process.execPath, [
        '--experimental-strip-types', supervisor,
        '--action', 'start',
        '--repo-root', context.repoRoot,
        '--state-dir', context.stateDir,
        '--registry-path', context.liveRegistryProjectionPath,
        '--epoch-authority-file', context.epochAuthorityFile,
        '--activation-epoch', epochId,
        '--activation-nonce', nonce,
      ], {
        cwd: context.repoRoot,
        env: { ...process.env, ORCHESTRATOR_PACK_WAKE_SUPERVISOR_STATE_DIR: context.stateDir },
        stdio: 'ignore',
        detached: true,
      });
      if (!child.pid) throw new Error('typescript_supervisor_spawn_failed');
      child.unref();
      await waitForSupervisorOwnership(context.stateDir, child.pid);
    },
  });
  process.stdout.write(`${JSON.stringify({ cutover: result })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
