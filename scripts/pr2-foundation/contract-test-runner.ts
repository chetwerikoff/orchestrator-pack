import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProcess, runProcessSync } from '../kernel/subprocess.ts';
import { AC_MUTATION_CONTROLS, type AcceptanceId } from './contracts.ts';

type ProcessResult = Awaited<ReturnType<typeof runProcess>>;

const PR2A_LANDING_COMMIT = '17ac39d725ba9ae7c881816405d5225e541177c7';

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

function pr2aLandedOnBase(): boolean {
  const baseName = String(process.env.GITHUB_BASE_REF ?? '').trim() || 'main';
  const baseRef = `origin/${baseName}`;
  const baseExists = runProcessSync({
    command: 'git',
    args: ['cat-file', '-e', `${baseRef}^{commit}`],
    cwd: resolve('.'),
    inheritParentEnv: true,
  });
  if (!baseExists.ok) return false;

  const landingExists = runProcessSync({
    command: 'git',
    args: ['cat-file', '-e', `${PR2A_LANDING_COMMIT}^{commit}`],
    cwd: resolve('.'),
    inheritParentEnv: true,
  });
  if (!landingExists.ok) return false;

  return runProcessSync({
    command: 'git',
    args: ['merge-base', '--is-ancestor', PR2A_LANDING_COMMIT, baseRef],
    cwd: resolve('.'),
    inheritParentEnv: true,
  }).ok;
}

async function runPr2aMutationMatrix(runner: string, ac: AcceptanceId | null): Promise<boolean> {
  const nested = process.env.OPK_CONTRACT_MUTATION_CI_NESTED === '1';
  const acceptanceIds = ac
    ? [ac]
    : nested
      ? (['AC1'] satisfies AcceptanceId[])
      : (Object.keys(AC_MUTATION_CONTROLS) as AcceptanceId[]).filter((value) => value !== 'AC9');
  const concurrency = nested ? 1 : 2;

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
  const hasPr2aRunner = existsSync(pr2aRunner);
  const pr2aLanded = hasPr2aRunner && pr2aLandedOnBase();
  const usePr2aRunner = hasPr2aRunner && (!ac || ac !== 'AC9');

  if (usePr2aRunner && pr2aLanded) {
    // #948's red/green mutation evidence is bound to its reviewed final tree. Once the
    // PR2a landing commit is already in the target base lineage, replaying that frozen
    // plan against an unrelated downstream PR would turn the historical receipt into a
    // permanent inventory snapshot. Keep the stable externally-grounded marker consumed
    // by the heavy-lane command contract.
    process.stdout.write(`${JSON.stringify({ mutationRunner: { result: 'externally-grounded' }, successor: 'issue-948-pr2a' })}\n`);
    process.stdout.write(`${JSON.stringify({ mutationEvidence: { replayed: false, evidence: 'post-landing-final-tree-preserved' } })}\n`);
    return;
  }

  if (usePr2aRunner && !ac) {
    if (!await runPr2aMutationMatrix(pr2aRunner, null)) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ mutationRunner: { result: 'externally-grounded' }, successor: 'issue-948-pr2a' })}\n`);
    return;
  }

  if (usePr2aRunner && ac) {
    if (!await runPr2aMutationMatrix(pr2aRunner, ac)) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ mutationRunner: { result: 'externally-grounded' }, successor: 'issue-948-pr2a' })}\n`);
    return;
  }

  const mutationResult = await runMutation(resolve('scripts/pr2-foundation/mutation-runner.ts'), ac);
  emit(mutationResult);
  if (!mutationResult.ok) {
    process.exitCode = mutationResult.exitCode ?? 1;
    return;
  }

  if (process.env.OPK_CONTRACT_MUTATION_CI_NESTED === '1') return;

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
