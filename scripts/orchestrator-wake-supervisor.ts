#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { runSupervisorOwned, status, stop, type SupervisorOptions } from './lib/orchestrator-side-process-supervisor.ts';

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_argument:${name}`);
  return process.argv[index + 1]!;
}
function optional(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function options(): SupervisorOptions {
  const repoRoot = resolve(optional('--repo-root', process.cwd()));
  return {
    repoRoot,
    stateDir: resolve(arg('--state-dir')),
    registryPath: resolve(arg('--registry-path')),
    epochAuthorityFile: resolve(arg('--epoch-authority-file')),
    epochId: arg('--activation-epoch'),
    nonce: arg('--activation-nonce'),
    pollMs: Number(optional('--poll-ms', '1000')),
  };
}

async function main(): Promise<void> {
  const action = optional('--action', 'status').toLowerCase();
  const input = options();
  if (action === 'status') {
    process.stdout.write(`${JSON.stringify(status(input))}\n`);
    return;
  }
  if (action === 'stop') {
    stop(input);
    process.stdout.write(`${JSON.stringify({ stopped: true, epochId: input.epochId })}\n`);
    return;
  }
  if (action !== 'start') throw new Error(`invalid_action:${action}`);
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  await runSupervisorOwned(input, controller.signal);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
