import '../toolchain/native-entrypoint-preflight.ts';

import { existsSync } from 'node:fs';
import {
  applyOpkVitestHarnessEnv,
  cleanupHarnessRoot,
  createHarnessRoot,
} from '../lib/vitest-live-store-harness.mjs';

const VITEST_PROBE_KEYS = new Set([
  'AC9:modification-outside-independent-union',
  'AC9:declaration-snapshot-missing',
  'AC9:declaration-created-after-implementation',
]);

function mutationKey(): string {
  const keyIndex = process.argv.indexOf('--key');
  const key = keyIndex >= 0 ? String(process.argv[keyIndex + 1] ?? '') : '';
  if (!key) throw new Error('mutation_key_missing');
  return key;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const key = mutationKey();
  const failingTestId = `mutation-contract:${key}`;
  let harnessRoot: string | null = null;
  let failed = false;
  try {
    if (VITEST_PROBE_KEYS.has(key)) {
      harnessRoot = createHarnessRoot();
      applyOpkVitestHarnessEnv(harnessRoot, process.env);
    }
    const { runBehavioralMutationProbe } = await import('./mutation-behavior-probes.ts');
    runBehavioralMutationProbe(key);
  } catch (error) {
    failed = true;
    process.stderr.write(`${failingTestId}: ${describeError(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (harnessRoot && existsSync(harnessRoot)) {
      try {
        cleanupHarnessRoot(harnessRoot);
      } catch (error) {
        failed = true;
        process.stderr.write(`${failingTestId}: harness_cleanup_failed:${describeError(error)}\n`);
        process.exitCode = 1;
      }
    }
  }
  if (!failed) process.stdout.write(`${failingTestId}: passed\n`);
}

main().catch((error) => {
  process.stderr.write(`${describeError(error)}\n`);
  process.exitCode = 2;
});
