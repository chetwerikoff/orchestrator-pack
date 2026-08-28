#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { runProcessSync } from './kernel/subprocess.ts';
import { main as verifyMain } from './verify.ts';

function has(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}
function value(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  process.stdout.write('== orchestrator-pack bootstrap ==\n');
  process.stdout.write('This helper does not read or print secrets, start a runtime, mutate user configuration, or create orchestration state.\n');

  const verifyArgs: string[] = [];
  if (has(argv, '--strict-prereqs')) verifyArgs.push('--strict-prereqs');
  if (has(argv, '--test-backed-smoke')) verifyArgs.push('--test-backed-smoke');
  const verifyCode = await verifyMain(verifyArgs);
  if (verifyCode !== 0) return verifyCode;

  if (has(argv, '--install-dependencies')) {
    const install = runProcessSync({
      command: 'npm',
      args: ['ci', '--include=dev'],
      cwd: process.cwd(),
      inheritParentEnv: true,
    });
    if (install.stdout) process.stdout.write(install.stdout);
    if (install.stderr) process.stderr.write(install.stderr);
    if (!install.ok) return install.exitCode ?? 1;
    const major = runProcessSync({
      command: 'npm',
      args: ['run', 'check:node-major', '--silent'],
      cwd: process.cwd(),
      inheritParentEnv: true,
    });
    if (!major.ok) return major.exitCode ?? 1;
    process.stdout.write('[PASS] frozen workspace dependencies installed.\n');
  } else {
    process.stdout.write('Dependency installation was not requested. Use --install-dependencies when needed.\n');
  }

  const target = value(argv, '--target-repo');
  process.stdout.write('== Runtime-neutral next step ==\n');
  process.stdout.write(target
    ? `Target repository: ${target}\nResolve the exact registered adapter and composite identity before effects.\n`
    : 'No target repository was supplied; no target-side action was attempted.\n');
  process.stdout.write('Use scripts/runtime/runtime-cli.ts and the registered RuntimeAdapter for runtime operations.\n');
  process.stdout.write('[PASS] bootstrap completed without host-runtime mutation.\n');
  return 0;
}

if (import.meta.main) process.exitCode = await main();
