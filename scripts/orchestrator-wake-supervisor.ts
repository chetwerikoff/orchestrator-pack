import './toolchain/native-entrypoint-preflight.ts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readSupervisorStatus, runSupervisor, type SupervisorOptions } from './lib/orchestrator-side-process-supervisor.ts';

function parse(argv: string[]): Record<string, string | boolean> {
  const output: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (key === '--detach') { output.detach = true; continue; }
    if (!key.startsWith('--')) throw new Error(`unknown_argument:${key}`);
    const value = argv[++i];
    if (!value) throw new Error(`missing_value:${key}`);
    output[key.slice(2)] = value;
  }
  return output;
}

function required(args: Record<string, string | boolean>, key: string): string {
  const value = String(args[key] ?? '').trim();
  if (!value) throw new Error(`missing_${key}`);
  return value;
}

function options(args: Record<string, string | boolean>): SupervisorOptions {
  return {
    stateDir: required(args, 'state-dir'),
    repoRoot: required(args, 'repo-root'),
    epochAuthorityPath: required(args, 'epoch-authority'),
    epochId: required(args, 'epoch-id'),
    nonce: required(args, 'nonce'),
    targetRegistryPath: required(args, 'target-registry'),
    projectedRegistryPath: required(args, 'projected-registry'),
  };
}

async function main(): Promise<void> {
  const [command = 'help', ...argv] = process.argv.slice(2);
  const args = parse(argv);
  if (command === 'status') {
    const status = readSupervisorStatus({ stateDir: required(args, 'state-dir') });
    process.stdout.write(`${JSON.stringify({ status })}\n`);
    process.exitCode = status?.childPid ? 0 : 1;
    return;
  }
  if (command !== 'run') throw new Error('usage: orchestrator-wake-supervisor.ts run|status ...');
  if (args.detach === true && process.env.OPK_CUTOVER_SUPERVISOR_DAEMON !== '1') {
    const self = fileURLToPath(import.meta.url);
    const childArgs = process.argv.slice(2).filter((arg) => arg !== '--detach');
    const child = spawn(process.execPath, ['--experimental-strip-types', self, ...childArgs], {
      cwd: path.resolve(required(args, 'repo-root')),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, OPK_CUTOVER_SUPERVISOR_DAEMON: '1' },
    });
    child.unref();
    process.stdout.write(`${JSON.stringify({ pid: child.pid, detached: true })}\n`);
    return;
  }
  await runSupervisor(options(args));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
