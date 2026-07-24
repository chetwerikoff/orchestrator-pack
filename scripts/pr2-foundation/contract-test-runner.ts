import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProcess } from '../kernel/subprocess.ts';
import { AC_MUTATION_CONTROLS, type AcceptanceId } from './contracts.ts';

type ProcessResult = Awaited<ReturnType<typeof runProcess>>;

function parseAc(argv: string[]): AcceptanceId | null {
  const index = argv.indexOf('--ac');
  if (index < 0) return null;
  const value = argv[index + 1] as AcceptanceId | undefined;
  if (!value || !(value in AC_MUTATION_CONTROLS)) throw new Error('invalid_ac');
  return value;
}

function emit(result: ProcessResult): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function runMutation(runner: string, ac: AcceptanceId | null): Promise<ProcessResult> {
  return runProcess({
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      runner,
      ...(ac ? ['--ac', ac] : ['--all']),
    ],
    cwd: resolve('.'),
    inheritParentEnv: true,
    allowEmptyStdout: false,
    timeoutMs: 600_000,
  });
}

async function runPr2aMutationMatrix(runner: string): Promise<boolean> {
  const acceptanceIds = (Object.keys(AC_MUTATION_CONTROLS) as AcceptanceId[])
    .filter((value) => value !== 'AC9');
  const concurrency = 2;

  for (let index = 0; index < acceptanceIds.length; index += concurrency) {
    const batch = acceptanceIds.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (acceptanceId) => ({
      acceptanceId,
      result: await runMutation(runner, acceptanceId),
    })));

    let batchOk = true;
    for (const { acceptanceId, result } of results) {
      emit(result);
      if (!result.ok) {
        process.stderr.write(`mutation_group_failed:${acceptanceId}\n`);
        batchOk = false;
      }
    }
    if (!batchOk) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const ac = parseAc(process.argv.slice(2));
  const pr2aRunner = resolve('scripts/pr2a/mutation-runner.ts');
  const usePr2aRunner = existsSync(pr2aRunner) && (!ac || ac !== 'AC9');

  if (usePr2aRunner && !ac) {
    if (!await runPr2aMutationMatrix(pr2aRunner)) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ mutationRunner: { result: 'externally-grounded' }, successor: 'issue-948-pr2a' })}\n`);
    return;
  }

  const mutationResult = await runMutation(
    usePr2aRunner ? pr2aRunner : resolve('scripts/pr2-foundation/mutation-runner.ts'),
    ac,
  );
  emit(mutationResult);
  if (!mutationResult.ok) {
    process.exitCode = mutationResult.exitCode ?? 1;
    return;
  }
  if (usePr2aRunner) {
    process.stdout.write(`${JSON.stringify({ mutationRunner: { result: 'externally-grounded' }, successor: 'issue-948-pr2a' })}\n`);
  }

  if (process.env.OPK_CONTRACT_MUTATION_CI_NESTED === '1' || usePr2aRunner) return;

  const args = [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.config.ts',
    'scripts/pr2-foundation/binding-cache.test.ts',
    'scripts/pr2-foundation/foundation.test.ts',
    'scripts/pr2-foundation/migration-symlink.test.ts',
    'scripts/pr2-foundation/mutation-catalog.test.ts',
    'scripts/pr2-foundation/mutation-semantic-gates.test.ts',
    'scripts/pr2-foundation/real-scope-proof.test.ts',
    'scripts/pr2-foundation/review-head-ready.test.ts',
    'scripts/pr2-foundation/terminalized-port.test.ts',
    'scripts/pr2-foundation/worker-notification-compat.test.ts',
  ];
  if (ac) args.push('--testNamePattern', `^\[${ac}\]`);
  const result = await runProcess({
    command: process.execPath,
    args,
    cwd: resolve('.'),
    inheritParentEnv: true,
    env: {
      OPK_CONTRACT_MUTATIONS_ALREADY_RUN: '1',
      OPK_VITEST_HARNESS: '1',
    },
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
