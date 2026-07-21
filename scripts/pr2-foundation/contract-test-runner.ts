import { resolve } from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import { AC_MUTATION_CONTROLS, type AcceptanceId } from './contracts.ts';

function parseAc(argv: string[]): AcceptanceId | null {
  const index = argv.indexOf('--ac');
  if (index < 0) return null;
  const value = argv[index + 1] as AcceptanceId | undefined;
  if (!value || !(value in AC_MUTATION_CONTROLS)) throw new Error('invalid_ac');
  return value;
}

function emit(result: Awaited<ReturnType<typeof runProcess>>): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function main(): Promise<void> {
  const ac = parseAc(process.argv.slice(2));
  const mutationResult = await runProcess({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      resolve('scripts/pr2-foundation/mutation-runner.ts'),
      ...(ac ? ['--ac', ac] : ['--all']),
    ],
    cwd: resolve('.'),
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 600_000,
  });
  emit(mutationResult);
  if (!mutationResult.ok) {
    process.exitCode = mutationResult.exitCode ?? 1;
    return;
  }

  const args = [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'scripts/toolchain/vitest-foundation.config.ts',
    'scripts/pr2-foundation/foundation.test.ts',
    'scripts/pr2-foundation/migration-symlink.test.ts',
    'scripts/pr2-foundation/mutation-catalog.test.ts',
    'scripts/pr2-foundation/real-scope-proof.test.ts',
    'scripts/pr2-foundation/worker-notification-compat.test.ts',
  ];
  if (ac) args.push('--testNamePattern', `^\\[${ac}\\]`);
  const result = await runProcess({
    command: process.execPath,
    args,
    cwd: resolve('.'),
    inheritParentEnv: true,
    allowEmptyStdout: true,
    timeoutMs: 300_000,
  });
  emit(result);
  if (!result.ok) process.exitCode = result.exitCode ?? 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
